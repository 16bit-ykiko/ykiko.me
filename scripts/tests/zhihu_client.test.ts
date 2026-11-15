import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Session, type RawRequest, type RawResponse } from "../http.ts";
import {
  ZhihuClient,
  formatCookieHeader,
  imageSize,
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

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR", "latin1").copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function gif(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.write("GIF89a", "latin1");
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

test("image sizes come from PNG, GIF and JPEG headers", () => {
  assert.deepEqual(imageSize(png(3840, 2160)), { width: 3840, height: 2160 });
  assert.deepEqual(imageSize(gif(1280, 678)), { width: 1280, height: 678 });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
    0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
  ]);
  assert.deepEqual(imageSize(jpeg), { width: 640, height: 480 });
  assert.throws(() => imageSize(Buffer.from("RIFF0000WEBP")));
});

test("a preview uploads the images on disk and the cover into a new draft", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zhihu-preview-"));
  try {
    const article = path.join(dir, "article.md");
    writeFileSync(
      article,
      "# Title\n\n## Part\n\n- item\n\n  ![grid[0].](media/a.gif)\n\n- next\n",
    );
    mkdirSync(path.join(dir, "media"));
    writeFileSync(path.join(dir, "media", "a.gif"), gif(4, 3));
    writeFileSync(path.join(dir, "cover.png"), png(16, 9));

    const log: string[] = [];
    let draft: unknown = null;
    let images = 0;
    const client = ZhihuClient.fromCookieHeader(
      "z_c0=token",
      async (request): Promise<RawResponse> => {
        const url = request.url;
        log.push(`${request.method} ${url.host}${url.pathname}`);
        const json = (value: unknown): RawResponse => ({
          status: 200,
          reason: "OK",
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(value)),
        });
        if (url.host === "zhihu-pics-upload.zhimg.com") {
          assert.match(request.headers["Authorization"]!, /^OSS STS\.id:/);
          return json({});
        }
        if (url.pathname === "/images") {
          images++;
          return json({
            upload_file: {
              image_id: `${images}`,
              state: 2,
              object_key: `v2-key${images}`,
            },
            upload_token: {
              access_id: "STS.id",
              access_key: "key",
              access_token: "token",
            },
          });
        }
        if (url.pathname.endsWith("/uploading_status")) return json({});
        if (url.pathname.startsWith("/images/")) {
          return json({
            status: "success",
            original_hash: `v2-hash${url.pathname.slice(8)}`,
          });
        }
        if (url.pathname === "/api/articles/drafts") return json({ id: 42 });
        if (url.pathname === "/api/articles/42/draft") {
          draft = JSON.parse(request.body!.toString("utf8"));
          return json({});
        }
        throw new Error(`unexpected ${url.href}`);
      },
    );

    const preview = await client.previewArticle(
      article,
      null,
      path.join(dir, "cover.png"),
    );
    assert.equal(
      preview,
      "https://zhuanlan.zhihu.com/p/42/preview?comment=0&catalog=1",
    );
    assert.deepEqual(log, [
      "POST api.zhihu.com/images",
      "PUT zhihu-pics-upload.zhimg.com/v2-key1",
      "PUT api.zhihu.com/images/1/uploading_status",
      "GET api.zhihu.com/images/1",
      "POST api.zhihu.com/images",
      "PUT zhihu-pics-upload.zhimg.com/v2-key2",
      "PUT api.zhihu.com/images/2/uploading_status",
      "GET api.zhihu.com/images/2",
      "POST zhuanlan.zhihu.com/api/articles/drafts",
      "PATCH zhuanlan.zhihu.com/api/articles/42/draft",
    ]);
    assert.deepEqual(draft, {
      content:
        '<h2>Part</h2><ul><li>item</li></ul><figure data-size="normal"><img data-caption="grid[0]." data-rawheight="3" data-rawwidth="4" data-size="normal" data-thumbnail="https://picx.zhimg.com/v2-hash1.jpg" src="https://picx.zhimg.com/v2-hash1.gif"/></figure><ul><li>next</li></ul>',
      title: "Title",
      titleImage: "https://picx.zhimg.com/v2-hash2.png",
      isTitleImageFullScreen: false,
      table_of_contents: true,
    });
    const written = readFileSync(article, "utf8");
    assert.match(written, /zhihu_draft_id: "42"/);
    assert.match(
      written,
      /zhihu_title_image_url: https:\/\/picx\.zhimg\.com\/v2-hash2\.png\n/,
    );
    assert.match(written, /\n# Title\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
