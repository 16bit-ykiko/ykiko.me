import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { markdownToHtml } from "../markdown_html.ts";
import { FIXTURES, TESTS_DIR, assertMatchesFile } from "./helpers.ts";

for (const dir of [
  path.join(TESTS_DIR, "data"),
  path.join(FIXTURES, "markdown"),
]) {
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    test(`markdown to Zhihu HTML: ${name}`, () => {
      const html = markdownToHtml(readFileSync(path.join(dir, name), "utf8"));
      assertMatchesFile(html, `html/${name.replace(/\.md$/, ".html")}`);
    });
  }
}

test("no whitespace is left between block tags, except inside <pre>", () => {
  const html = markdownToHtml(
    "# T\n\npara one\n\n- a\n- b\n\n```cpp\nint x;\n\nint y;\n```\n\n> q\n",
  );
  assert.equal(
    html,
    '<h2>T</h2><p>para one</p><ul><li>a</li><li>b</li></ul><pre lang="cpp">int x;\n\nint y;\n</pre><blockquote><p>q</p></blockquote>',
  );
});

test("line breaks inside a paragraph keep no newline after <br/>", () => {
  assert.equal(markdownToHtml("one\ntwo"), "<p>one<br/>two</p>");
});

test("emphasis closes after a space or a full stop, as the articles expect", () => {
  assert.equal(
    markdownToHtml("大量**隐式参数 (implicit flags) **！和**传递。**同样"),
    "<p>大量<strong>隐式参数 (implicit flags) </strong>！和<strong>传递。</strong>同样</p>",
  );
});

test("a lone <br> is a paragraph", () => {
  assert.equal(
    markdownToHtml("x\n\n<br>\n\ny"),
    "<p>x</p><p><br/></p><p>y</p>",
  );
});

test("tabs become spaces at four-column stops", () => {
  assert.equal(
    markdownToHtml("```\na\tb\n\tc\n```"),
    "<pre>a   b\n    c\n</pre>",
  );
});
