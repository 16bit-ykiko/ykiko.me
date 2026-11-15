import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseHtml } from "../html_tree.ts";
import { Parser } from "../zhihu_parser.ts";
import { FIXTURES, assertMatchesFile, captureLog } from "./helpers.ts";

const fixture = (name: string): string =>
  readFileSync(path.join(FIXTURES, "zhihu", name), "utf8");

function withUrlsMap<T>(fn: () => T): T {
  Parser.urlsMap = new Map([
    [
      "https://zhuanlan.zhihu.com/p/645810896",
      "https://www.ykiko.me/zh-cn/articles/645810896",
    ],
  ]);
  try {
    return fn();
  } finally {
    Parser.urlsMap = new Map();
  }
}

test("article body constructs", () => {
  const [doc, log] = captureLog(() =>
    withUrlsMap(() =>
      new Parser().parseBody(parseHtml(fixture("constructs.html"))),
    ),
  );
  assertMatchesFile(doc.dump(), "zhihu/constructs.md");
  assertMatchesFile(
    `${JSON.stringify({ log }, null, 2)}\n`,
    "zhihu/constructs.json",
  );
});

for (const name of ["real-1919923607997518115", "richtext", "ordered-keys"]) {
  test(`article page ${name}`, () => {
    const [article, log] = captureLog(() =>
      withUrlsMap(() =>
        new Parser().parseArticleFromHtml(fixture(`${name}.page`)),
      ),
    );
    assertMatchesFile(article.content.dump(), `zhihu/${name}.md`);
    const meta = {
      title: article.title,
      cover: article.cover,
      created: article.created,
      updated: article.updated,
      log,
    };
    assertMatchesFile(
      `${JSON.stringify(meta, null, 2)}\n`,
      `zhihu/${name}.json`,
    );
  });
}

test("the first article of the page wins even when a later id sorts first", () => {
  const article = new Parser().parseArticleFromHtml(
    fixture("ordered-keys.page"),
  );
  assert.equal(article.title, "第一个：大号 id");
});

test("a string of whitespace between inline elements collapses to one space", () => {
  const doc = new Parser().parseBody(
    parseHtml("<p><code>a</code>   <code>b</code></p>"),
  );
  assert.equal(doc.dump(), "`a` `b`");
});

test("a GIF keeps its animation, not the still frame in data-original", () => {
  const doc = new Parser().parseBody(
    parseHtml(
      '<figure><img src="https://pic2.zhimg.com/v2-a_1440w.gif" data-thumbnail="https://pic2.zhimg.com/v2-a_b.jpg" data-original="https://pic2.zhimg.com/v2-a_r.jpg"/><figcaption>cap</figcaption></figure>' +
        '<figure><img src="https://pic2.zhimg.com/v2-b_1440w.jpg" data-original="https://pic2.zhimg.com/v2-b_r.jpg"/><figcaption>still</figcaption></figure>',
    ),
  );
  assert.equal(
    doc.dump(),
    "![cap](https://pic2.zhimg.com/v2-a_r.gif)\n\n![still](https://pic2.zhimg.com/v2-b_r.jpg)",
  );
});
