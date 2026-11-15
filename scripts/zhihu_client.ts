import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatTimestamp, localIsoNow } from "./dates.ts";
import {
  metadataString,
  readMarkdownDocument,
  renderFrontMatter,
  writeMarkdownDocument,
  type Metadata,
} from "./front_matter.ts";
import { Session, USER_AGENT, type Response, type Transport } from "./http.ts";
import { isObject, truthy, type Json, type JsonObject } from "./json.ts";
import { markdownToHtml, type ImageInfo } from "./markdown_html.ts";
import { dumpYaml, loadYaml } from "./yaml_io.ts";
import { readText, strip } from "./text.ts";
import { REPO_ROOT } from "./paths.ts";
import { Parser } from "./zhihu_parser.ts";

const TZ_SHANGHAI = "Asia/Shanghai";

export const PAGE_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.zhihu.com/",
};
export const API_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.zhihu.com/",
};
const LOGIN_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.zhihu.com",
  Referer: "https://www.zhihu.com/signin",
  "x-requested-with": "fetch",
  "content-type": "application/json;charset=UTF-8",
};
export const ZHUANLAN_HEADERS = {
  authority: "zhuanlan.zhihu.com",
  "user-agent": USER_AGENT,
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  origin: "https://zhuanlan.zhihu.com",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: "https://zhuanlan.zhihu.com/write",
  "x-requested-with": "fetch",
};
const REQUEST_TIMEOUT_SECONDS = 20;
export const COOKIE_DIR = path.join(REPO_ROOT, ".cookie");
export const COOKIE_FILE = path.join(COOKIE_DIR, "zhihu.yaml");
const LEGACY_COOKIE_FILES = [
  path.join(COOKIE_DIR, "zhihu.json"),
  path.join(COOKIE_DIR, "zhihu.txt"),
];
const SELF_PROFILE_API = "https://www.zhihu.com/api/v4/me";
const QRCODE_API = "https://www.zhihu.com/api/v3/account/api/login/qrcode";
const CAPTCHA_V2_API =
  "https://www.zhihu.com/api/v3/oauth/captcha/v2?type=captcha_sign_in";
const UDID_API = "https://www.zhihu.com/udid";
export const ZHUANLAN_API = "https://zhuanlan.zhihu.com/api/articles";
const IMAGES_API = "https://api.zhihu.com/images";
const IMAGE_HOST = "https://picx.zhimg.com";
const OSS_HOST = "https://zhihu-pics-upload.zhimg.com";
const OSS_BUCKET = "zhihu-pics";
const OSS_USER_AGENT = "aliyun-sdk-js/6.8.0 Chrome 120.0.0.0 on Linux 64-bit";
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
// One level of brackets may nest in the alt text: ![grid[0].](a.gif)
const MARKDOWN_IMAGE = /!\[((?:[^[\]]|\[[^[\]]*\])*)\]\(([^()\s]+)\)/g;

function get(obj: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function str(value: Json | undefined): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function int(value: Json | undefined): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value))
    return Number(value);
  throw new Error(`invalid literal for int(): ${String(value)}`);
}

export class ZhihuColumn {
  id: string;
  title: string;
  intro: string;
  articlesCount: number;
  followers: number;

  constructor(
    id: string,
    title: string,
    intro: string,
    articlesCount: number,
    followers: number,
  ) {
    this.id = id;
    this.title = title;
    this.intro = intro;
    this.articlesCount = articlesCount;
    this.followers = followers;
  }

  static fromApi(payload: JsonObject): ZhihuColumn {
    const inner = get(payload, "column");
    const column =
      Object.hasOwn(payload, "column") && isObject(inner) ? inner : payload;
    return new ZhihuColumn(
      str(get(column, "id")),
      str(get(column, "title")),
      typeof get(column, "intro") === "string"
        ? (column["intro"] as string)
        : "",
      int(get(column, "articles_count") ?? 0),
      int(get(column, "followers") ?? 0),
    );
  }
}

export class ZhihuArticle {
  id: string;
  title: string;
  url: string;
  created: number;
  updated: number;
  columnId: string | null;
  columnTitle: string | null;

  constructor(
    id: string,
    title: string,
    url: string,
    created: number,
    updated: number,
    columnId: string | null,
    columnTitle: string | null,
  ) {
    this.id = id;
    this.title = title;
    this.url = url;
    this.created = created;
    this.updated = updated;
    this.columnId = columnId;
    this.columnTitle = columnTitle;
  }

  static fromApi(payload: JsonObject): ZhihuArticle {
    const rawColumn = get(payload, "column");
    const column = isObject(rawColumn) ? rawColumn : {};
    const articleId = str(get(payload, "id"));
    const columnId = get(column, "id");
    const columnTitle = get(column, "title");
    return new ZhihuArticle(
      articleId,
      str(get(payload, "title")),
      `https://zhuanlan.zhihu.com/p/${articleId}`,
      int(get(payload, "created") ?? get(payload, "updated") ?? 0),
      int(get(payload, "updated") ?? get(payload, "created") ?? 0),
      columnId !== undefined && columnId !== null ? str(columnId) : null,
      typeof columnTitle === "string" ? columnTitle : null,
    );
  }
}

export function parseCookieHeader(cookieText: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (let pair of cookieText.split(";")) {
    pair = strip(pair);
    if (!pair || !pair.includes("=")) continue;
    const i = pair.indexOf("=");
    cookies[strip(pair.slice(0, i))] = strip(pair.slice(i + 1));
  }
  return cookies;
}

export function formatCookieHeader(session: Session): string {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const cookie of session.cookies.list()) {
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    items.push(`${cookie.name}=${cookie.value}`);
  }
  return items.join("; ");
}

function cookieHeaderOf(text: string): string {
  const payload = loadYaml(text);
  if (!isRecord(payload)) return "";
  const value = payload["cookie_header"];
  return value === undefined || value === null ? "" : strip(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export function loadCookieCache(cachePath: string = COOKIE_FILE): string {
  if (!existsSync(cachePath)) {
    for (const legacyPath of LEGACY_COOKIE_FILES) {
      if (existsSync(legacyPath)) {
        const text = readText(legacyPath);
        return legacyPath.endsWith(".txt") ? strip(text) : cookieHeaderOf(text);
      }
    }
    return "";
  }
  return cookieHeaderOf(readText(cachePath));
}

export function saveCookieCache(
  session: Session,
  cachePath: string = COOKIE_FILE,
): void {
  mkdirSync(COOKIE_DIR, { recursive: true });
  writeFileSync(
    cachePath,
    dumpYaml({
      cookie_header: formatCookieHeader(session),
      saved_at: localIsoNow(),
    }),
    "utf8",
  );
}

function which(command: string): string | null {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [command],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0
    ? strip(result.stdout.split("\n")[0] ?? "") || null
    : null;
}

export function saveGithubSecret(
  secretName: string,
  cookieHeader: string,
): void {
  if (!which("gh")) throw new Error("`gh` is not installed.");
  const result = spawnSync("gh", ["secret", "set", secretName], {
    input: cookieHeader,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Command 'gh secret set ${secretName}' returned non-zero exit status ${result.status}.`,
    );
  }
}

function launch(command: string, args: string[]): boolean {
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export function openUrl(url: string): boolean {
  for (const command of ["xdg-open", "open"]) {
    const found = which(command);
    if (found && launch(found, [url])) return true;
  }
  for (const entry of (process.env["BROWSER"] ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    const [command, ...args] = entry.split(" ");
    const withUrl = args.some((a) => a.includes("%s"))
      ? args.map((a) => a.replace("%s", url))
      : [...args, url];
    if (command && which(command) && launch(command, withUrl)) return true;
  }
  for (const command of ["wslview", "x-www-browser", "www-browser"]) {
    const found = which(command);
    if (found && launch(found, [url])) return true;
  }
  return false;
}

function toZhihuLinks(markdown: string): string {
  return markdown.replace(
    /https:\/\/www\.ykiko\.me\/zh-cn\/articles\/(\d+)/g,
    "https://zhuanlan.zhihu.com/p/$1",
  );
}

// The title is the front matter's, else an opening "# " line, which then
// leaves the body, else the file name.
function titleAndBody(
  metadata: Metadata,
  body: string,
  markdownPath: string,
): [string, string] {
  if (truthy(metadata["title"])) return [String(metadata["title"]), body];
  const heading = /^\s*# (.+)\n/.exec(body);
  if (heading) return [strip(heading[1]!), body.slice(heading[0].length)];
  return [path.basename(markdownPath, path.extname(markdownPath)), body];
}

export function imageSize(data: Buffer): { width: number; height: number } {
  if (data.subarray(1, 4).toString("latin1") === "PNG") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.subarray(0, 3).toString("latin1") === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 9 < data.length; ) {
      const marker = data[at + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        return {
          width: data.readUInt16BE(at + 7),
          height: data.readUInt16BE(at + 5),
        };
      }
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  throw new Error("not a PNG, GIF or JPEG image");
}

function titleImageOf(metadata: Metadata): Json {
  const value = truthy(metadata["zhihu_title_image_url"])
    ? metadata["zhihu_title_image_url"]
    : metadata["title_image_url"];
  return value === undefined || value === null ? null : String(value);
}

export class ZhihuClient {
  session: Session;
  private profile: JsonObject | null = null;

  constructor(session?: Session) {
    this.session = session ?? new Session();
  }

  static fromCookieHeader(
    cookieHeader: string,
    transport?: Transport,
  ): ZhihuClient {
    const client = new ZhihuClient(new Session(transport));
    client.session.cookies.update(parseCookieHeader(cookieHeader));
    return client;
  }

  static async fromEnvOrCache(options: {
    allowLogin: boolean;
    forceLogin?: boolean;
    cachePath?: string;
  }): Promise<ZhihuClient> {
    const { allowLogin, forceLogin = false, cachePath = COOKIE_FILE } = options;
    const envCookie = strip(process.env["ZHIHU_COOKIE"] ?? "");
    const client = envCookie
      ? ZhihuClient.fromCookieHeader(envCookie)
      : new ZhihuClient();

    if (!forceLogin && envCookie && (await client.isSessionValid()))
      return client;

    if (!forceLogin && !envCookie) {
      const cachedCookie = loadCookieCache(cachePath);
      if (cachedCookie) {
        const cachedClient = ZhihuClient.fromCookieHeader(cachedCookie);
        if (await cachedClient.isSessionValid()) return cachedClient;
      }
    }

    if (!allowLogin) {
      throw new Error(
        "No valid Zhihu cookie found. Set ZHIHU_COOKIE, or run `node scripts/zhihu_cli.ts login`.",
      );
    }

    const loggedIn = await ZhihuClient.loginViaQrcode();
    saveCookieCache(loggedIn.session, cachePath);
    return loggedIn;
  }

  buildLoginHeaders(isPolling = false): Record<string, string> {
    const headers: Record<string, string> = { ...LOGIN_HEADERS };
    const xsrfToken = this.session.cookies.get("_xsrf");
    if (xsrfToken) headers["x-xsrftoken"] = xsrfToken;
    if (isPolling) {
      headers["Accept"] = "*/*";
      headers["Referer"] = "https://www.zhihu.com/signin?next=%2F";
      headers["sec-fetch-dest"] = "empty";
      headers["sec-fetch-mode"] = "cors";
      headers["sec-fetch-site"] = "same-origin";
      headers["x-zse-93"] = "101_3_3.0";
    }
    return headers;
  }

  async prefetchLoginContext(): Promise<void> {
    await this.session.get("https://www.zhihu.com/signin?next=%2F", {
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.zhihu.com/" },
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    await this.session.post(UDID_API, {
      headers: this.buildLoginHeaders(),
      json: {},
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    await this.session.get(CAPTCHA_V2_API, {
      headers: this.buildLoginHeaders(),
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
  }

  static async loginViaQrcode(timeoutSeconds = 120): Promise<ZhihuClient> {
    const client = new ZhihuClient();
    await client.prefetchLoginContext();

    const response = await client.session.post(QRCODE_API, {
      headers: client.buildLoginHeaders(),
      json: {},
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    response.raiseForStatus();
    const payload = response.json();
    const data = isObject(payload) ? payload : {};
    const token = truthy(get(data, "token"))
      ? get(data, "token")
      : get(data, "qrcode_token");
    const link = get(data, "link");
    if (!truthy(token) || !truthy(link)) {
      throw new Error(
        `Failed to request Zhihu QR login: ${JSON.stringify(payload)}`,
      );
    }

    await client.printQrCode(String(link));
    console.log(String(link));

    const deadline = Date.now() + timeoutSeconds * 1000;
    let promptedConfirm = false;
    let promptedRiskControl = false;
    while (Date.now() < deadline) {
      const poll = await client.session.get(
        `${QRCODE_API}/${String(token)}/scan_info`,
        {
          headers: client.buildLoginHeaders(true),
          timeout: REQUEST_TIMEOUT_SECONDS,
        },
      );
      let scanInfo: JsonObject = {};
      try {
        const parsed = poll.json();
        if (isObject(parsed)) scanInfo = parsed;
      } catch {
        scanInfo = {};
      }

      client.syncScanCookies(scanInfo);

      const error = get(scanInfo, "error");
      if (poll.status === 403 && isObject(error)) {
        const redirect = get(error, "redirect");
        if (get(error, "code") === 40352 || get(error, "need_login") === true) {
          if (!promptedRiskControl) {
            promptedRiskControl = true;
            console.log("Zhihu requested a risk-control verification page.");
            if (truthy(redirect)) {
              console.log(String(redirect));
              openUrl(String(redirect));
            }
          }
          await sleep(1500);
          continue;
        }
      }

      if (get(scanInfo, "status") === 1 && !promptedConfirm) {
        promptedConfirm = true;
        console.log("QR scanned. Confirm the login in the Zhihu app.");
      }

      if (client.isLoginSuccessful(scanInfo)) {
        try {
          await client.getProfile(true);
        } catch {
          // the profile is fetched again when needed
        }
        if (client.session.cookies.get("z_c0")) return client;
      }

      await sleep(1000);
    }
    throw new Error("QR login timed out.");
  }

  async printQrCode(link: string): Promise<void> {
    const { renderUnicodeCompact } = await import("uqr");
    console.log("Scan the QR code with the Zhihu app:");
    try {
      console.log(renderUnicodeCompact(link, { border: 1, ecc: "M" }));
    } catch {
      // the link is printed below as well
    }
  }

  syncScanCookies(scanInfo: JsonObject): void {
    const rawCookie: string[] = [];
    for (const key of ["cookie", "cookies"]) {
      const value = get(scanInfo, key);
      if (typeof value === "string") rawCookie.push(value);
    }
    const skipNames = new Set([
      "Domain",
      "Path",
      "Expires",
      "Max-Age",
      "HttpOnly",
      "Secure",
      "SameSite",
    ]);
    for (let item of rawCookie.join(";").split(";")) {
      item = strip(item);
      if (!item || !item.includes("=")) continue;
      const i = item.indexOf("=");
      const name = item.slice(0, i);
      const value = item.slice(i + 1);
      if (skipNames.has(name) || !value) continue;
      this.session.cookies.set(name, value, ".zhihu.com", "/");
    }
    const zc0 = get(scanInfo, "z_c0");
    if (truthy(zc0))
      this.session.cookies.set("z_c0", String(zc0), ".zhihu.com", "/");
  }

  isLoginSuccessful(scanInfo: JsonObject): boolean {
    if (this.session.cookies.get("z_c0")) return true;
    const userId = get(scanInfo, "user_id");
    if (userId !== undefined && userId !== null) return true;
    if (
      truthy(get(scanInfo, "access_token")) ||
      get(scanInfo, "success") === true ||
      get(scanInfo, "logged_in") === true
    ) {
      return true;
    }
    const loginStatus = str(get(scanInfo, "login_status") ?? "").toUpperCase();
    return [
      "CONFIRMED",
      "LOGIN_SUCCESS",
      "SUCCESS",
      "OK",
      "LOGGED_IN",
    ].includes(loginStatus);
  }

  ensureNotBlocked(response: Response): void {
    const content = response.text;
    const blockedText = [
      "系统监测到您的网络环境存在异常",
      "请求参数异常，请升级客户端后重试",
      "请点击下方验证按钮进行验证",
    ];
    if (
      response.url.includes("account/unhuman") ||
      blockedText.some((text) => content.includes(text))
    ) {
      throw new Error(
        "Zhihu blocked the current session. Refresh the cookie cache and complete the risk-control verification.",
      );
    }
    if (response.url.includes("www.zhihu.com/signin"))
      throw new Error("Zhihu cookie expired.");
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await this.getProfile(true);
      return true;
    } catch {
      return false;
    }
  }

  async apiGet(
    url: string,
    params?: Record<string, string | number>,
  ): Promise<JsonObject> {
    const response = await this.session.get(url, {
      headers: API_HEADERS,
      ...(params ? { params } : {}),
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    response.raiseForStatus();
    const payload = response.json();
    if (!isObject(payload))
      throw new Error(`Expected a JSON object from ${url}`);
    return payload;
  }

  async getProfile(refresh = false): Promise<JsonObject> {
    if (this.profile !== null && !refresh) return this.profile;
    const response = await this.session.get(SELF_PROFILE_API, {
      headers: API_HEADERS,
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    response.raiseForStatus();
    const payload = response.json();
    if (!isObject(payload)) throw new Error("Unexpected profile response");
    this.profile = payload;
    return payload;
  }

  async profileName(): Promise<string> {
    const name = get(await this.getProfile(), "name");
    return name === undefined ? "" : str(name);
  }

  async urlToken(): Promise<string> {
    const profile = await this.getProfile();
    if (!Object.hasOwn(profile, "url_token"))
      throw new Error("Profile has no url_token");
    return str(profile["url_token"]);
  }

  async paginate(url: string, key = "data", limit = 20): Promise<JsonObject[]> {
    let offset = 0;
    const items: JsonObject[] = [];
    for (;;) {
      const payload = await this.apiGet(url, { offset, limit });
      const page = get(payload, key) ?? [];
      if (Array.isArray(page)) items.push(...page.filter(isObject));
      const paging = get(payload, "paging");
      const isEnd = isObject(paging) ? (get(paging, "is_end") ?? true) : true;
      if (truthy(isEnd)) break;
      offset += limit;
    }
    return items;
  }

  async listColumns(): Promise<ZhihuColumn[]> {
    const url =
      `https://www.zhihu.com/api/v4/members/${await this.urlToken()}/column-contributions` +
      "?include=data%5B*%5D.column.intro%2Cfollowers%2Carticles_count";
    return (await this.paginate(url)).map((item) => ZhihuColumn.fromApi(item));
  }

  async listArticles(): Promise<ZhihuArticle[]> {
    const url =
      `https://www.zhihu.com/api/v4/members/${await this.urlToken()}/articles` +
      "?include=data%5B*%5D.column%2Cauthor%2Ccomment_count%2Cvoteup_count";
    return (await this.paginate(url)).map((item) => ZhihuArticle.fromApi(item));
  }

  async fetchArticleHtml(url: string): Promise<string> {
    const response = await this.session.get(url, {
      headers: PAGE_HEADERS,
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    response.raiseForStatus();
    this.ensureNotBlocked(response);
    return response.text;
  }

  async download(url: string): Promise<Buffer | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.session.get(url, {
          headers: PAGE_HEADERS,
          timeout: REQUEST_TIMEOUT_SECONDS,
        });
        response.raiseForStatus();
        return response.content;
      } catch (error) {
        console.log(
          `Download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(1000);
      }
    }
    return null;
  }

  // `only`: just these articles; every other one stays as it is on disk.
  async syncArticles(
    outputDir: string,
    delaySeconds = 0,
    only: readonly string[] = [],
  ): Promise<void> {
    const listed = await this.listArticles();
    const missing = only.filter((id) => !listed.some((a) => a.id === id));
    if (missing.length > 0)
      throw new Error(`Not among your articles: ${missing.join(", ")}`);
    const articles =
      only.length > 0 ? listed.filter((a) => only.includes(a.id)) : listed;
    const total = articles.length;
    Parser.urlsMap = new Map(
      listed.map((a) => [a.url, `https://www.ykiko.me/zh-cn/articles/${a.id}`]),
    );
    const parser = new Parser();

    const startedAt = performance.now();
    for (const [i, article] of articles.entries()) {
      const index = i + 1;
      const articleStartedAt = performance.now();
      console.log(`[${index}/${total}] Fetching ${article.id}...`);
      const html = await this.fetchArticleHtml(article.url);
      const parsed = parser.parseArticleFromHtml(html);
      const markdownText = this.renderSyncedMarkdown(
        article.id,
        parsed.title,
        parsed.created,
        parsed.updated,
        parsed.content.dump(),
        article.url,
        article.columnId,
        article.columnTitle,
        path.join(outputDir, article.id, "index.md"),
      );
      await this.writeArticleFiles(
        outputDir,
        article.id,
        markdownText,
        parsed.cover,
      );
      const elapsed = (performance.now() - articleStartedAt) / 1000;
      console.log(
        `[${index}/${total}] Done: ${article.id} (${elapsed.toFixed(2)}s)`,
      );
      if (delaySeconds > 0) await sleep(delaySeconds * 1000);
    }
    console.log(
      `All done in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
    );
  }

  renderSyncedMarkdown(
    articleId: string,
    title: string,
    created: number,
    updated: number,
    body: string,
    articleUrl: string,
    columnId: string | null,
    columnTitle: string | null,
    existingPath: string,
  ): string {
    const existing: Metadata = existsSync(existingPath)
      ? readMarkdownDocument(existingPath)[0]
      : {};
    const reserved = new Set([
      "title",
      "date",
      "updated",
      "zhihu_article_id",
      "zhihu_url",
      "zhihu_column_id",
      "zhihu_column_title",
    ]);
    const metadata: Metadata = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!reserved.has(key)) metadata[key] = value;
    }
    Object.assign(metadata, {
      title,
      date: formatTimestamp(created, TZ_SHANGHAI),
      updated: formatTimestamp(updated, TZ_SHANGHAI),
      zhihu_article_id: articleId,
      zhihu_url: articleUrl,
    });
    if (columnId) metadata["zhihu_column_id"] = columnId;
    if (columnTitle) metadata["zhihu_column_title"] = columnTitle;
    return renderFrontMatter(metadata, body);
  }

  async writeArticleFiles(
    baseDir: string,
    articleId: string,
    markdownText: string,
    coverUrl: string,
  ): Promise<void> {
    const articleDir = path.join(baseDir, articleId);
    mkdirSync(articleDir, { recursive: true });
    writeFileSync(path.join(articleDir, "index.md"), markdownText, "utf8");
    if (coverUrl) {
      const content = await this.download(coverUrl);
      if (content !== null)
        writeFileSync(path.join(articleDir, "featured.png"), content);
    }
  }

  // Zhihu hands out a slot for the image, the file goes to its OSS bucket,
  // and the image is usable once Zhihu has processed it, which takes a GIF
  // minutes. An image Zhihu already has needs no upload.
  async uploadImage(file: string): Promise<{ url: string } & ImageInfo> {
    const extension = path.extname(file).slice(1).toLowerCase();
    const type = IMAGE_TYPES[extension];
    if (type === undefined) {
      throw new Error(`${file}: Zhihu takes PNG, GIF and JPEG images`);
    }
    const data = readFileSync(file);
    const slotResponse = await this.session.post(IMAGES_API, {
      json: {
        image_hash: createHash("md5").update(data).digest("hex"),
        source: "article",
      },
      headers: API_HEADERS,
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    slotResponse.raiseForStatus();
    const slot = slotResponse.json();
    const uploadFile = isObject(slot) ? get(slot, "upload_file") : undefined;
    if (!isObject(uploadFile)) throw new Error(`${file}: no upload slot`);
    const imageId = str(uploadFile["image_id"]);
    if (int(uploadFile["state"]) === 2) {
      const token = isObject(slot) ? get(slot, "upload_token") : undefined;
      if (!isObject(token)) throw new Error(`${file}: no upload token`);
      const objectKey = str(uploadFile["object_key"]);
      const date = new Date().toUTCString();
      const securityToken = str(token["access_token"]);
      const signature = createHmac("sha1", str(token["access_key"]))
        .update(
          `PUT\n\n${type}\n${date}\n` +
            `x-oss-date:${date}\n` +
            `x-oss-security-token:${securityToken}\n` +
            `x-oss-user-agent:${OSS_USER_AGENT}\n` +
            `/${OSS_BUCKET}/${objectKey}`,
        )
        .digest("base64");
      const put = await this.session.put(`${OSS_HOST}/${objectKey}`, {
        data,
        headers: {
          "Content-Type": type,
          Date: date,
          "x-oss-date": date,
          "x-oss-security-token": securityToken,
          "x-oss-user-agent": OSS_USER_AGENT,
          Authorization: `OSS ${str(token["access_id"])}:${signature}`,
        },
        timeout: 120,
      });
      put.raiseForStatus();
      const done = await this.session.put(
        `${IMAGES_API}/${imageId}/uploading_status`,
        {
          json: { upload_result: "success" },
          headers: API_HEADERS,
          timeout: REQUEST_TIMEOUT_SECONDS,
        },
      );
      done.raiseForStatus();
    }
    let info: Json = null;
    for (let waited = 0; waited < 600; waited++) {
      const response = await this.session.get(`${IMAGES_API}/${imageId}`, {
        headers: API_HEADERS,
        timeout: REQUEST_TIMEOUT_SECONDS,
      });
      response.raiseForStatus();
      info = response.json();
      if (isObject(info) && info["status"] === "success") break;
      await sleep(1000);
    }
    if (!isObject(info) || info["status"] !== "success") {
      throw new Error(
        `${file}: Zhihu did not finish processing image ${imageId}`,
      );
    }
    const hash = info["original_hash"];
    if (typeof hash !== "string") throw new Error(`${file}: no image hash`);
    const suffix = extension === "jpeg" ? "jpg" : extension;
    return {
      url: `${IMAGE_HOST}/${hash}.${suffix}`,
      ...imageSize(data),
      ...(suffix === "gif" ? { thumbnail: `${IMAGE_HOST}/${hash}.jpg` } : {}),
    };
  }

  // The images the markdown links on disk go to Zhihu's image host, the
  // links rewritten to it.
  private async hostLocalImages(
    markdown: string,
    baseDir: string,
  ): Promise<[string, Map<string, ImageInfo>]> {
    const hosted = new Map<string, string>();
    const images = new Map<string, ImageInfo>();
    for (const match of markdown.matchAll(MARKDOWN_IMAGE)) {
      const target = match[2]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || hosted.has(target)) continue;
      const { url, ...info } = await this.uploadImage(
        path.resolve(baseDir, target),
      );
      hosted.set(target, url);
      images.set(url, info);
    }
    const rewritten = markdown.replace(
      MARKDOWN_IMAGE,
      (whole, alt: string, target: string) =>
        hosted.has(target) ? `![${alt}](${hosted.get(target)})` : whole,
    );
    return [rewritten, images];
  }

  // `cover`: an image on disk to upload as the title image, recorded in
  // the front matter so later updates keep it.
  private async draftContent(
    markdownPath: string,
    metadata: Metadata,
    bodyMarkdown: string,
    cover: string | null,
  ): Promise<{ title: string; html: string; titleImage: Json }> {
    const [title, body] = titleAndBody(metadata, bodyMarkdown, markdownPath);
    const [markdown, images] = await this.hostLocalImages(
      toZhihuLinks(body),
      path.dirname(markdownPath),
    );
    if (cover) {
      metadata["zhihu_title_image_url"] = (await this.uploadImage(cover)).url;
    }
    return {
      title,
      html: markdownToHtml(markdown, images),
      titleImage: titleImageOf(metadata),
    };
  }

  private async createDraft(title: string): Promise<string> {
    const createResponse = await this.session.post(`${ZHUANLAN_API}/drafts`, {
      json: { title, delta_time: 0 },
      headers: ZHUANLAN_HEADERS,
      timeout: REQUEST_TIMEOUT_SECONDS,
    });
    createResponse.raiseForStatus();
    const created = createResponse.json();
    if (!isObject(created) || get(created, "id") === undefined) {
      throw new Error("Draft creation returned no id");
    }
    return str(created["id"]);
  }

  private async patchDraft(
    id: string,
    content: { title: string; html: string; titleImage: Json },
  ): Promise<void> {
    const patchResponse = await this.session.patch(
      `${ZHUANLAN_API}/${id}/draft`,
      {
        json: {
          content: content.html,
          title: content.title,
          titleImage: content.titleImage,
          isTitleImageFullScreen: false,
          table_of_contents: true,
        },
        headers: ZHUANLAN_HEADERS,
        timeout: REQUEST_TIMEOUT_SECONDS,
      },
    );
    patchResponse.raiseForStatus();
  }

  // Without `articleId`, the draft a preview made is published, or else a
  // new one.
  async createOrUpdateArticle(
    markdownPath: string,
    articleId: string | null,
    column: ZhihuColumn | null,
    cover: string | null = null,
  ): Promise<string> {
    const [metadata, bodyMarkdown] = readMarkdownDocument(markdownPath);
    const content = await this.draftContent(
      markdownPath,
      metadata,
      bodyMarkdown,
      cover,
    );
    const targetId =
      articleId ||
      metadataString(metadata, "zhihu_draft_id") ||
      (await this.createDraft(content.title));
    await this.patchDraft(targetId, content);

    const publishResponse = await this.session.put(
      `${ZHUANLAN_API}/${targetId}/publish`,
      {
        json: {
          column: column ? { id: column.id, title: column.title } : null,
          commentPermission: "anyone",
        },
        headers: ZHUANLAN_HEADERS,
        timeout: REQUEST_TIMEOUT_SECONDS,
      },
    );
    publishResponse.raiseForStatus();

    delete metadata["zhihu_draft_id"];
    metadata["zhihu_article_id"] = targetId;
    metadata["zhihu_url"] = `https://zhuanlan.zhihu.com/p/${targetId}`;
    if (column) {
      metadata["zhihu_column_id"] = column.id;
      metadata["zhihu_column_title"] = column.title;
    }
    writeMarkdownDocument(markdownPath, metadata, bodyMarkdown);
    return targetId;
  }

  // Pushes the content to the draft without publishing it. Without
  // `articleId`, the draft is the one an earlier preview made, or a new one
  // recorded in the front matter as zhihu_draft_id.
  async previewArticle(
    markdownPath: string,
    articleId: string | null,
    cover: string | null = null,
  ): Promise<string> {
    const [metadata, bodyMarkdown] = readMarkdownDocument(markdownPath);
    const content = await this.draftContent(
      markdownPath,
      metadata,
      bodyMarkdown,
      cover,
    );
    let id = articleId || metadataString(metadata, "zhihu_draft_id");
    const created = !id;
    if (created) {
      id = await this.createDraft(content.title);
      metadata["zhihu_draft_id"] = id;
    }
    await this.patchDraft(id, content);
    if (cover || created) {
      writeMarkdownDocument(markdownPath, metadata, bodyMarkdown);
    }
    return `https://zhuanlan.zhihu.com/p/${id}/preview?comment=0&catalog=1`;
  }
}
