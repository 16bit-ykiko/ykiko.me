import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Session, type RawRequest, type RawResponse } from "../http.ts";
import {
  ZhihuClient,
  formatCookieHeader,
  parseCookieHeader,
} from "../zhihu_client.ts";
import { FIXTURES, assertMatchesFile, captureLogAsync } from "./helpers.ts";

const SYNC = path.join(FIXTURES, "sync");

function fakeZhihu(
  log: string[],
): (request: RawRequest) => Promise<RawResponse> {
  return async (request) => {
    const url = request.url;
    log.push(`${request.method} ${url.href}`);
    const ok = (body: Buffer, type: string): RawResponse => ({
      status: 200,
      reason: "OK",
      headers: { "content-type": type },
      body,
    });
    if (url.pathname === "/api/v4/me")
      return ok(readFileSync(path.join(SYNC, "me.json")), "application/json");
    if (url.pathname.endsWith("/articles")) {
      return ok(
        readFileSync(
          path.join(SYNC, `articles-${url.searchParams.get("offset")}.json`),
        ),
        "application/json",
      );
    }
    if (url.host === "zhuanlan.zhihu.com") {
      const id = url.pathname.slice(3);
      const page = path.join(SYNC, "pages", `${id}.html`);
      const real = path.join(FIXTURES, "zhihu", `real-${id}.page`);
      return ok(
        readFileSync(existsSync(page) ? page : real),
        "text/html; charset=utf-8",
      );
    }
    return ok(Buffer.from(`IMG:${url.href}`), "image/jpeg");
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();
}

test("sync writes every article with its front matter and cover", async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "zhihu-sync-"));
  try {
    cpSync(path.join(SYNC, "existing"), out, { recursive: true });
    const log: string[] = [];
    const client = ZhihuClient.fromCookieHeader("z_c0=token", fakeZhihu(log));
    const [, stdout] = await captureLogAsync(() => client.syncArticles(out));
    assertMatchesFile(`${log.join("\n")}\n`, "sync/requests.txt");
    assertMatchesFile(
      `${stdout.join("\n").replace(/\(\d+\.\d+s\)|in \d+\.\d+s/g, "TIME")}\n`,
      "sync/stdout.txt",
    );
    const expectedFiles = listFiles(
      path.join(path.dirname(FIXTURES), "expected", "sync"),
    ).filter((f) => !f.endsWith(".txt"));
    assert.deepEqual(listFiles(out), expectedFiles);
    for (const file of expectedFiles)
      assertMatchesFile(readFileSync(path.join(out, file)), `sync/${file}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("cookies keep the order they were first set in", () => {
  const session = new Session();
  session.cookies.update(
    parseCookieHeader('_zap=1; _xsrf=2;  d_c0=3 ; bad; z_c0="2|1:0"'),
  );
  session.cookies.set("z_c0", "new", ".zhihu.com", "/");
  session.cookies.set("_zap", "again");
  assert.equal(
    formatCookieHeader(session),
    '_zap=again; _xsrf=2; d_c0=3; z_c0="2|1:0"',
  );
});

test("cookies set while following a redirect are kept and sent", async () => {
  const sent: string[] = [];
  const session = new Session(async (request): Promise<RawResponse> => {
    sent.push(
      `${request.method} ${request.url.href} cookie=${request.headers["Cookie"] ?? ""}`,
    );
    if (request.url.pathname === "/start") {
      return {
        status: 302,
        reason: "Found",
        headers: {
          location: "/next",
          "set-cookie": [
            "a=1; Domain=zhihu.com; Path=/",
            "gone=x; Max-Age=0",
            "host=only",
          ],
        },
        body: Buffer.alloc(0),
      };
    }
    return {
      status: 200,
      reason: "OK",
      headers: {},
      body: Buffer.from("done"),
    };
  });
  session.cookies.update({ gone: "old" });
  const response = await session.post("https://www.zhihu.com/start", {
    json: { x: 1 },
  });
  assert.equal(response.text, "done");
  assert.equal(response.url, "https://www.zhihu.com/next");
  assert.deepEqual(sent, [
    "POST https://www.zhihu.com/start cookie=gone=old",
    "GET https://www.zhihu.com/next cookie=gone=old; a=1; host=only",
  ]);
  assert.equal(session.cookies.get("a"), "1");
});

test("an HTTP error names the status and the URL", async () => {
  const session = new Session(async () => ({
    status: 403,
    reason: "Forbidden",
    headers: {},
    body: Buffer.alloc(0),
  }));
  const response = await session.get("https://www.zhihu.com/api/v4/me", {
    params: { a: 1 },
  });
  assert.throws(() => response.raiseForStatus(), {
    message:
      "403 Client Error: Forbidden for url: https://www.zhihu.com/api/v4/me?a=1",
  });
});
