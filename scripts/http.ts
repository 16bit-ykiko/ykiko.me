// A small HTTP session: a cookie jar shared by every request (cookies set
// while following redirects included), default headers, timeouts, and
// gzip/deflate/brotli bodies. Proxies come from HTTPS_PROXY/NO_PROXY.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { parseJson, type Json } from "./json.ts";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/145.0.0.0 Safari/537.36";

export interface Cookie {
  name: string;
  value: string;
  // "" matches every host; ".example.com" the domain and its subdomains.
  domain: string;
  path: string;
  secure: boolean;
  expires: number | null;
}

export class CookieJar {
  // domain -> path -> name, each level in the order first set; reading the
  // jar walks it in that order.
  private readonly domains = new Map<
    string,
    Map<string, Map<string, Cookie>>
  >();

  set(name: string, value: string, domain = "", path = "/"): void {
    this.store({ name, value, domain, path, secure: false, expires: null });
  }

  get(name: string): string | undefined {
    return this.list().find((c) => c.name === name)?.value;
  }

  update(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) this.set(name, value);
  }

  list(): Cookie[] {
    const now = Date.now() / 1000;
    const all: Cookie[] = [];
    for (const paths of this.domains.values()) {
      for (const names of paths.values()) {
        for (const c of names.values()) {
          if (c.expires === null || c.expires > now) all.push(c);
        }
      }
    }
    return all;
  }

  private store(cookie: Cookie): void {
    let paths = this.domains.get(cookie.domain);
    if (!paths) this.domains.set(cookie.domain, (paths = new Map()));
    let names = paths.get(cookie.path);
    if (!names) paths.set(cookie.path, (names = new Map()));
    names.set(cookie.name, cookie);
  }

  private remove(domain: string, path: string, name: string): void {
    this.domains.get(domain)?.get(path)?.delete(name);
  }

  header(url: URL): string {
    const host = effectiveHost(url.hostname);
    const matching = this.list().filter((c) => {
      if (c.secure && url.protocol !== "https:") return false;
      if (c.domain) {
        const dotted = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
        if (!`.${host}`.endsWith(dotted)) return false;
      }
      return pathMatches(url.pathname || "/", c.path);
    });
    matching.sort((a, b) => b.path.length - a.path.length);
    return matching.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  extract(url: URL, setCookies: string[]): void {
    for (const line of setCookies) {
      const parts = line.split(";");
      const first = parts[0]!.trim();
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      let domain: string | null = null;
      let path: string | null = null;
      let secure = false;
      let expires: number | null = null;
      let maxAge: number | null = null;
      let invalid = false;
      const seen = new Set<string>();
      for (const part of parts.slice(1)) {
        const [rawKey, ...rest] = part.split("=");
        const key = rawKey!.trim().toLowerCase();
        const val = rest.join("=").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        if (key === "domain") domain = val.toLowerCase();
        else if (key === "path") path = val;
        else if (key === "secure") secure = true;
        else if (key === "max-age") {
          if (/^-?\d+$/.test(val)) maxAge = Number(val);
          else invalid = true;
        } else if (key === "expires") expires = parseExpires(val);
      }
      if (invalid) continue;
      if (maxAge !== null) expires = Date.now() / 1000 + maxAge;
      const host = effectiveHost(url.hostname);
      let cookieDomain: string;
      if (domain === null || domain === "") {
        cookieDomain = host;
      } else {
        cookieDomain = domain.startsWith(".") ? domain : `.${domain}`;
        const bare = cookieDomain.slice(1);
        if (host !== bare && !host.endsWith(cookieDomain)) continue;
      }
      if (path === null || path === "") {
        const p = url.pathname || "/";
        const i = p.lastIndexOf("/");
        path = i > 0 ? p.slice(0, i) : "/";
      }
      if (expires !== null && expires <= Date.now() / 1000) {
        this.remove(cookieDomain, path, name);
        continue;
      }
      this.store({ name, value, domain: cookieDomain, path, secure, expires });
    }
  }
}

// A date with a month name; one without a zone is UTC. Anything else
// leaves the cookie a session cookie.
function parseExpires(value: string): number | null {
  const text = value.replace(/^"|"$/g, "");
  if (!/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(text))
    return null;
  const zoned = /(gmt|utc|z|[+-]\d{2}:?\d{2})\s*$/i.test(text)
    ? text
    : `${text} GMT`;
  const t = Date.parse(zoned);
  return Number.isNaN(t) ? null : t / 1000;
}

function effectiveHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.includes(".") ? lower : `${lower}.local`;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  return (
    requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/")
  );
}

export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string | number>;
  json?: unknown;
  timeout?: number;
}

export interface RawRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | null;
  timeout: number;
}

export interface RawResponse {
  status: number;
  reason: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export type Transport = (request: RawRequest) => Promise<RawResponse>;

export class HttpError extends Error {
  readonly response: Response;

  constructor(message: string, response: Response) {
    super(message);
    this.response = response;
  }
}

export class Response {
  readonly status: number;
  readonly reason: string;
  readonly url: string;
  readonly headers: Record<string, string | string[]>;
  readonly content: Buffer;

  constructor(raw: RawResponse, url: string) {
    this.status = raw.status;
    this.reason = raw.reason;
    this.url = url;
    this.headers = raw.headers;
    this.content = raw.body;
  }

  get ok(): boolean {
    return this.status < 400;
  }

  get text(): string {
    const type = headerValue(this.headers, "content-type") ?? "";
    const charset = /charset=["']?([^;"'\s]+)/i.exec(type)?.[1] ?? "utf-8";
    try {
      return new TextDecoder(charset).decode(this.content);
    } catch {
      return new TextDecoder("utf-8").decode(this.content);
    }
  }

  json(): Json {
    return parseJson(this.text);
  }

  raiseForStatus(): void {
    if (this.status >= 400 && this.status < 600) {
      const kind = this.status < 500 ? "Client Error" : "Server Error";
      throw new HttpError(
        `${this.status} ${kind}: ${this.reason} for url: ${this.url}`,
        this,
      );
    }
  }
}

function headerValue(
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

const agent = new https.Agent({ keepAlive: true, proxyEnv: process.env });
const plainAgent = new http.Agent({ keepAlive: true, proxyEnv: process.env });

export const nodeTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const lib = request.url.protocol === "http:" ? http : https;
    const req = lib.request(
      request.url,
      {
        method: request.method,
        timeout: request.timeout,
        headers: request.headers,
        agent: request.url.protocol === "http:" ? plainAgent : agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              reason: res.statusMessage ?? "",
              headers: res.headers as Record<string, string | string[]>,
              body: decode(
                Buffer.concat(chunks),
                res.headers["content-encoding"],
                res.statusCode ?? 0,
              ),
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Request to ${request.url.href} timed out after ${request.timeout} ms`,
        ),
      );
    });
    req.on("error", reject);
    if (request.body) req.write(request.body);
    req.end();
  });

// An empty body, or one of a redirect that does not decode, is kept as is.
function decode(
  body: Buffer,
  encoding: string | undefined,
  status: number,
): Buffer {
  if (body.length === 0) return body;
  try {
    return decompress(body, encoding);
  } catch (error) {
    if (status >= 300 && status < 400) return body;
    throw error;
  }
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    case "br":
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept-Encoding": "gzip, deflate",
  Accept: "*/*",
  Connection: "keep-alive",
};

function mergeHeaders(
  ...sets: Record<string, string>[]
): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const set of sets) {
    for (const [key, value] of Object.entries(set))
      merged.set(key.toLowerCase(), [key, value]);
  }
  return Object.fromEntries([...merged.values()]);
}

export class Session {
  readonly cookies = new CookieJar();
  private readonly transport: Transport;

  constructor(transport: Transport = nodeTransport) {
    this.transport = transport;
  }

  get(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("GET", url, options);
  }

  post(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("POST", url, options);
  }

  put(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("PUT", url, options);
  }

  patch(url: string, options: RequestOptions = {}): Promise<Response> {
    return this.request("PATCH", url, options);
  }

  async request(
    method: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    let target = new URL(url);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      target.searchParams.append(key, String(value));
    }
    let headers = mergeHeaders(DEFAULT_HEADERS, options.headers ?? {});
    let body: Buffer | null = null;
    if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json), "utf8");
      if (
        !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
      ) {
        headers["Content-Type"] = "application/json";
      }
    }
    const timeout = (options.timeout ?? 30) * 1000;

    for (let redirects = 0; ; redirects++) {
      const sent = { ...headers };
      if (body) sent["Content-Length"] = String(body.length);
      const cookie = this.cookies.header(target);
      if (cookie) sent["Cookie"] = cookie;
      const raw = await this.transport({
        method,
        url: target,
        headers: sent,
        body,
        timeout,
      });
      const setCookie = raw.headers["set-cookie"];
      this.cookies.extract(
        target,
        Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
      );
      const location = headerValue(raw.headers, "location");
      if (![301, 302, 303, 307, 308].includes(raw.status) || !location) {
        return new Response(raw, target.href);
      }
      if (redirects >= 30)
        throw new Error(`Exceeded 30 redirects: ${target.href}`);
      target = new URL(location, target);
      if (
        (raw.status === 303 && method !== "HEAD") ||
        (raw.status === 302 && method !== "HEAD") ||
        (raw.status === 301 && method === "POST")
      ) {
        method = "GET";
      }
      // Only 307 and 308 send the body again.
      if (raw.status !== 307 && raw.status !== 308) {
        body = null;
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) =>
              !["content-type", "content-length"].includes(k.toLowerCase()),
          ),
        );
      }
    }
  }
}
