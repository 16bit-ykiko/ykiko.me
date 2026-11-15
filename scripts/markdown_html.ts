// Markdown to the HTML Zhihu's editor accepts. markdown-it is tuned to the
// dialect the articles were written against: emphasis closes wherever a
// matching delimiter follows ("**隐式参数 (flags) **！"), and raw HTML is a block
// only for block-level tags (a lone <br> stays a paragraph).
import markdownIt, { type MarkdownIt, type StateBlock } from "markdown-it";
import {
  Element,
  TextNode,
  decodeContents,
  newElement,
  parseHtml,
  type Node,
} from "./html_tree.ts";
import { WS_CLASS, escapeRegExp, isSpace, strip } from "./text.ts";

const BLOCK_LEVEL = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "canvas",
  "center",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "group",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "main",
  "map",
  "math",
  "menu",
  "nav",
  "noscript",
  "object",
  "ol",
  "option",
  "output",
  "p",
  "pre",
  "progress",
  "script",
  "section",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
]);

function createRenderer(): MarkdownIt {
  const md = markdownIt({ html: true, breaks: true, linkify: false });

  const BaseState = md.inline.State;
  md.inline.State = class extends BaseState {
    override scanDelims(start: number, canSplitWord: boolean) {
      const result = super.scanDelims(start, canSplitWord);
      if (this.src.charCodeAt(start) !== 0x2a) return result;
      const before = start > 0 ? this.src[start - 1]! : "";
      const after = this.src[start + result.length] ?? "";
      const literal =
        (before === "" || isSpace(before)) && (after === "" || isSpace(after));
      return { ...result, can_open: !literal, can_close: !literal };
    }
  };

  const rules = md.block.ruler.__rules__;
  const htmlBlock = rules[md.block.ruler.__find__("html_block")]!;
  const original = htmlBlock.fn;
  md.block.ruler.at(
    "html_block",
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean,
    ) => {
      const pos = state.bMarks[startLine]! + state.tShift[startLine]!;
      const line = state.src.slice(pos, state.eMarks[startLine]);
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line);
      if (tag && !BLOCK_LEVEL.has(tag[1]!.toLowerCase())) return false;
      return original(state, startLine, endLine, silent);
    },
    { alt: htmlBlock.alt },
  );

  md.core.ruler.push("table_align_style", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "th_open" && token.type !== "td_open") continue;
      const m = /^text-align:(\w+)$/.exec(String(token.attrGet("style")));
      if (m) token.attrSet("style", `text-align: ${m[1]};`);
    }
  });
  return md;
}

const renderer = createRenderer();

const LINKCARD = new RegExp(
  `\\{\\{<${WS_CLASS}*linkcard${WS_CLASS}+url="([^"]+)"${WS_CLASS}+title="([^"]*)"${WS_CLASS}*>\\}\\}`,
  "gu",
);

function expandTabs(line: string, tabSize: number): string {
  let out = "";
  let column = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const spaces = tabSize - (column % tabSize);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

// Line endings become "\n", tabs become spaces at four-column stops (code
// blocks included), and lines of nothing but spaces become empty.
function normalizeSource(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => expandTabs(line, 4))
    .join("\n")
    .replace(/(?<=\n) +\n/g, "\n");
}

// What Zhihu wants to know of an image it hosts beyond its URL.
export interface ImageInfo {
  width: number;
  height: number;
  // A GIF's still frame.
  thumbnail?: string;
}

// `images`: what is known of the images by URL; one missing goes without.
export function markdownToHtml(
  markdownText: string,
  images: ReadonlyMap<string, ImageInfo> = new Map(),
): string {
  const body = markdownText.replace(
    LINKCARD,
    (_m, url: string, title: string) =>
      `<p><a href="${url}">${title || url}</a></p>`,
  );
  return postprocessZhihuHtml(renderer.render(normalizeSource(body)), images);
}

function postprocessZhihuHtml(
  html: string,
  images: ReadonlyMap<string, ImageInfo>,
): string {
  html = html.replace(
    /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string, code: string) => `<pre lang="${lang}">${code}</pre>`,
  );
  html = html.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (_m, code: string) => `<pre>${code}</pre>`,
  );
  // Zhihu's table of contents takes h2 and h3 only. An article written from
  // h1 moves every level down one; otherwise h1 moves up to h2. Below h3,
  // headings become bold paragraphs.
  const shift = html.includes("<h1>") ? 1 : 0;
  html = html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, content: string) => {
      const n = Math.max(Number(level) + shift, 2);
      if (n <= 3) return `<h${n}>${content}</h${n}>`;
      return `<p><strong>${content}</strong></p>`;
    },
  );
  html = html.replaceAll('<pre lang="x86asm">', '<pre lang="nasm">');
  // Zhihu keeps every row in one <tbody>; header cells stay <th>.
  html = html.replaceAll(
    "<table>",
    '<table data-draft-node="block" data-draft-type="table" data-size="normal">',
  );
  html = html.replace(
    new RegExp(
      `<thead>${WS_CLASS}*([\\s\\S]*?)${WS_CLASS}*</thead>${WS_CLASS}*<tbody>`,
      "gu",
    ),
    (_m, rows: string) => `<tbody>${rows}`,
  );
  html = figures(html, images);
  html = mergeSplitOrderedLists(html);
  html = tightenListItems(html);
  return stripBlockWhitespace(html);
}

function insertAfter(anchor: Node, node: Node): void {
  const parent = anchor.parent!;
  node.extract();
  parent.children.splice(parent.children.indexOf(anchor) + 1, 0, node);
  node.parent = parent;
}

function isBlank(node: Node): boolean {
  return node instanceof TextNode && !strip(node.data);
}

function figure(img: Element, images: ReadonlyMap<string, ImageInfo>): Element {
  const src = img.attr("src") ?? "";
  const info = images.get(src);
  const out = newElement("img");
  out.attrs.set("src", src);
  out.attrs.set("data-caption", img.attr("alt") ?? "");
  out.attrs.set("data-size", "normal");
  if (info) {
    out.attrs.set("data-rawwidth", String(info.width));
    out.attrs.set("data-rawheight", String(info.height));
    if (info.thumbnail) out.attrs.set("data-thumbnail", info.thumbnail);
  }
  const wrapper = newElement("figure");
  wrapper.attrs.set("data-size", "normal");
  wrapper.append(out);
  return wrapper;
}

// An image alone in its paragraph becomes a figure, its alt text the caption
// Zhihu shows under it. Zhihu keeps no figure inside a list item, only a bare
// inline image, so a figure in an item of a top-level unordered list leaves
// it: the list is cut after that item and resumes after the figure. An
// ordered list cannot be cut, Zhihu numbering every <ol> from 1.
function figures(html: string, images: ReadonlyMap<string, ImageInfo>): string {
  const root = parseHtml(`<div>${html}</div>`).find("div")!;
  for (const img of root.findAll("img")) {
    const p = img.parent;
    if (p?.name !== "p" || p.children.some((c) => c !== img && !isBlank(c)))
      continue;
    insertAfter(p, figure(img, images));
    p.extract();
  }
  for (const ul of root.elements().filter((e) => e.name === "ul")) {
    let list = ul;
    for (const li of ul.elements().filter((e) => e.name === "li")) {
      if (li.parent !== list) {
        list.append(li);
      }
      const moved = li.elements().filter((e) => e.name === "figure");
      if (moved.length === 0) continue;
      let anchor: Node = list;
      for (const fig of moved) {
        insertAfter(anchor, fig);
        anchor = fig;
      }
      if (li.children.every(isBlank)) li.extract();
      const rest = newElement("ul");
      insertAfter(anchor, rest);
      list = rest;
    }
    if (list !== ul && list.elements().length === 0) list.extract();
  }
  return decodeContents(root);
}

// The items of a loose list each hold a paragraph, which Zhihu shows with a
// blank line between the items; an item holding just one loses it.
function tightenListItems(html: string): string {
  const root = parseHtml(`<div>${html}</div>`).find("div")!;
  for (const li of root.findAll("li")) {
    const content = li.children.filter((c) => !isBlank(c));
    const only = content[0];
    if (content.length !== 1 || !(only instanceof Element) || only.name !== "p")
      continue;
    let anchor: Node = only;
    for (const child of [...only.children]) {
      insertAfter(anchor, child);
      anchor = child;
    }
    only.extract();
  }
  return decodeContents(root);
}

function startOf(ol: Element): number | null {
  const value = ol.attr("start");
  if (value === undefined) return 1;
  const trimmed = strip(value);
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

// A loose ordered list interrupted by paragraphs is rendered as several
// <ol start="N">, and Zhihu numbers each from 1. The fragments are merged
// into one list, the paragraphs between them going into the item before;
// when numbers are missing in the gap, paragraphs like "3. Title" there
// become those items.
function mergeSplitOrderedLists(html: string): string {
  const soup = parseHtml(`<div>${html}</div>`);
  const root = soup.find("div")!;

  for (;;) {
    const continuation = root
      .findAll("ol")
      .find((ol) => (startOf(ol) ?? 1) > 1);
    if (continuation === undefined) break;
    const continuationStart = startOf(continuation)!;

    let prevOl: Element | null = null;
    let between: Node[] = [];
    let sibling = continuation.previousSibling;
    while (sibling !== null) {
      if (sibling instanceof Element && sibling.name === "ol") {
        prevOl = sibling;
        break;
      }
      between.unshift(sibling);
      sibling = sibling.previousSibling;
    }

    if (prevOl === null) {
      continuation.attrs.delete("start");
      continue;
    }

    const currentLis = prevOl.elements().filter((c) => c.name === "li");
    const prevLastIdx = currentLis.length;
    const missingCount = continuationStart - prevLastIdx - 1;

    for (const node of between) node.extract();
    between = between.filter((n) => !(n instanceof TextNode && !strip(n.data)));

    const lastLi = currentLis[currentLis.length - 1]!;
    if (missingCount <= 0) {
      for (const node of between) lastLi.append(node);
    } else {
      const segments: Node[][] = [[]];
      for (const node of between) {
        if (node instanceof Element && node.name === "p") {
          const expected = prevLastIdx + segments.length;
          const text = strip(node.text);
          if (
            segments.length <= missingCount &&
            new RegExp(
              `^${escapeRegExp(String(expected))}${WS_CLASS}*[.、]`,
              "u",
            ).test(text)
          ) {
            stripNumberPrefix(node, expected);
            segments.push([node]);
            continue;
          }
        }
        segments[segments.length - 1]!.push(node);
      }
      for (const node of segments[0]!) lastLi.append(node);
      for (const segment of segments.slice(1)) {
        const li = newElement("li");
        for (const node of segment) li.append(node);
        prevOl.append(li);
      }
    }

    for (const li of continuation.elements().filter((c) => c.name === "li")) {
      prevOl.append(li.extract());
    }
    continuation.extract();
  }
  return decodeContents(root);
}

function stripNumberPrefix(node: Element, num: number): void {
  const first = node.firstString();
  if (first) {
    first.replaceWith(
      first.data.replace(
        new RegExp(`^${WS_CLASS}*${num}${WS_CLASS}*[.、]${WS_CLASS}*`, "u"),
        "",
      ),
    );
  }
}

const BLOCK_TAG = new RegExp(
  `${WS_CLASS}*(</?(?:p|h[1-6]|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|hr|div|pre|figure)\\b[^>]*>)${WS_CLASS}*`,
  "gu",
);

// Zhihu's editor turns whitespace between block tags into empty blocks: the
// article renders fine, but opening it in the editor shows large gaps
// between paragraphs. Its own saved HTML has none, so drop it, outside <pre>.
function stripBlockWhitespace(html: string): string {
  const blocks: string[] = [];
  html = html.replace(/<pre\b[\s\S]*?<\/pre>/g, (m) => {
    blocks.push(m);
    return `\0${blocks.length - 1}\0`;
  });
  html = html.replace(BLOCK_TAG, "$1");
  html = html.replace(
    new RegExp(`${WS_CLASS}*(\\0\\d+\\0)${WS_CLASS}*`, "gu"),
    "$1",
  );
  html = html.replace(
    new RegExp(`(<br${WS_CLASS}*/?>)${WS_CLASS}+`, "gu"),
    "$1",
  );
  return html.replace(/\0(\d+)\0/g, (_m, i: string) => blocks[Number(i)]!);
}
