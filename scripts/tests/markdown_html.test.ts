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

test("an article written from # moves every heading level down one", () => {
  assert.equal(
    markdownToHtml("# A\n\n## B\n\n### C\n\nx"),
    "<h2>A</h2><h3>B</h3><p><strong>C</strong></p><p>x</p>",
  );
});

test("an image alone in its paragraph becomes a figure with what is known of it", () => {
  const images = new Map([
    [
      "https://picx.zhimg.com/v2-a.gif",
      { width: 4, height: 3, thumbnail: "https://picx.zhimg.com/v2-a.jpg" },
    ],
  ]);
  assert.equal(
    markdownToHtml(
      "![cap](https://picx.zhimg.com/v2-a.gif)\n\ntext ![x](https://picx.zhimg.com/v2-b.png)",
      images,
    ),
    '<figure data-size="normal"><img data-caption="cap" data-rawheight="3" data-rawwidth="4" data-size="normal" data-thumbnail="https://picx.zhimg.com/v2-a.jpg" src="https://picx.zhimg.com/v2-a.gif"/></figure>' +
      '<p>text <img alt="x" src="https://picx.zhimg.com/v2-b.png"/></p>',
  );
});

test("a figure leaves its unordered list item, the list resuming after it", () => {
  assert.equal(
    markdownToHtml(
      "- a\n\n  ![p](https://x/p.png)\n\n- b\n- c\n\n  ![q](https://x/q.png)\n",
    ),
    '<ul><li>a</li></ul><figure data-size="normal"><img data-caption="p" data-size="normal" src="https://x/p.png"/></figure>' +
      '<ul><li>b</li><li>c</li></ul><figure data-size="normal"><img data-caption="q" data-size="normal" src="https://x/q.png"/></figure>',
  );
});

test("a figure stays in its ordered list item", () => {
  assert.equal(
    markdownToHtml("1. a\n\n   ![p](https://x/p.png)\n2. b\n"),
    '<ol><li><p>a</p><figure data-size="normal"><img data-caption="p" data-size="normal" src="https://x/p.png"/></figure></li><li>b</li></ol>',
  );
});
