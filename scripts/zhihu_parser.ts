import { Element, parseHtml, TextNode, type Node } from "./html_tree.ts";
import {
  isObject,
  keysInOrder,
  parseJson,
  truthy,
  type Json,
  type JsonObject,
} from "./json.ts";
import * as md from "./markdown_ast.ts";
import {
  isAlnum,
  firstChar,
  lastChar,
  removePrefix,
  removeSuffix,
  strip,
  unquote,
} from "./text.ts";

const OLD_PAGES_ARTICLE =
  /^https:\/\/16bit-ykiko\.github\.io\/about-me\/(\d+)\/?$/;

export class Article {
  content: md.Document;
  title: string;
  cover: string;
  created: number;
  updated: number;

  constructor(
    content: md.Document,
    title: string,
    cover: string,
    created: number,
    updated: number,
  ) {
    this.content = content;
    this.title = title;
    this.cover = cover;
    this.created = created;
    this.updated = updated;
  }
}

function field(obj: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function or(...values: (Json | undefined)[]): Json | undefined {
  for (const value of values.slice(0, -1)) if (truthy(value)) return value;
  return values[values.length - 1];
}

function asString(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: Json | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number")
    throw new Error(`Expected a number, got ${String(value)}`);
  return value;
}

function required(obj: JsonObject, key: string): Json {
  const value = field(obj, key);
  if (value === undefined) throw new Error(`Missing key: ${key}`);
  return value;
}

function textOf(node: Node): string {
  return node.text;
}

export class Parser {
  static urlsMap = new Map<string, string>();
  static readonly languagesMap = new Map([
    ["nasm", "x86asm"],
    ["text", "bash"],
  ]);

  static warnSkip(tagName: string, context: string): void {
    console.log(`Warning: skipping unsupported <${tagName}> in ${context}`);
  }

  parseArticleFromHtml(text: string): Article {
    const soup = parseHtml(text);
    const initialData = soup.findFirst(
      (el) => el.name === "script" && el.attr("id") === "js-initialData",
    );
    if (initialData !== null) {
      const data = parseJson(initialData.text);
      const articles = dig(data, ["initialState", "entities", "articles"]);
      const inner = articles[keysInOrder(articles)[0]!];
      if (!isObject(inner)) throw new Error("Article entity not found");
      const content = this.parseBody(
        parseHtml(asString(required(inner, "content"))),
      );
      const cover = or(
        field(inner, "imageUrl"),
        field(inner, "image_url"),
        field(inner, "titleImage"),
        Object.hasOwn(inner, "title_image") ? inner["title_image"] : "",
      );
      return new Article(
        content,
        asString(required(inner, "title")),
        asString(cover),
        asNumber(required(inner, "created")),
        asNumber(required(inner, "updated")),
      );
    }

    const body = soup.findFirst(
      (el) =>
        el.name === "div" && (el.attr("class") ?? "").includes("RichText"),
    );
    if (body === null) throw new Error("Article body not found");
    return new Article(this.parseBody(body), "", "", 0, 0);
  }

  parseArticleFromJson(text: string): Article {
    const inner = parseJson(text);
    if (!isObject(inner)) throw new Error("Expected a JSON object");
    const content = this.parseBody(
      parseHtml(asString(required(inner, "content"))),
    );
    const cover = or(
      field(inner, "image_url"),
      Object.hasOwn(inner, "title_image") ? inner["title_image"] : "",
    );
    return new Article(
      content,
      asString(required(inner, "title")),
      asString(cover),
      asNumber(required(inner, "created")),
      asNumber(required(inner, "updated")),
    );
  }

  parseBody(element: Element): md.Document {
    const nodes: md.MdNode[] = [];
    for (const child of element.children) {
      if (child instanceof TextNode) {
        if (strip(child.text)) {
          nodes.push(new md.Paragraph([new md.Text(strip(child.text))]));
        }
        continue;
      }
      switch (child.name) {
        case "h2":
          nodes.push(new md.Header(2, child.text));
          break;
        case "h3":
          nodes.push(new md.Header(3, child.text));
          break;
        case "hr":
          nodes.push(new md.HorizontalRule());
          break;
        case "p":
          nodes.push(this.parseParagraph(child));
          break;
        case "a":
          nodes.push(this.parseLinkcard(child));
          break;
        case "ul":
        case "ol": {
          const node = this.parseList(child);
          if (node !== null) nodes.push(node);
          break;
        }
        case "div": {
          const node = this.parseDiv(child);
          if (node !== null) nodes.push(node);
          break;
        }
        case "blockquote":
          nodes.push(this.parseBlockquote(child));
          break;
        case "figure": {
          const node = this.parseImage(child);
          if (node !== null) nodes.push(node);
          break;
        }
        case "table": {
          const node = this.parseTable(child);
          if (node !== null) nodes.push(node);
          break;
        }
        default:
          Parser.warnSkip(child.name, "article body");
      }
    }
    return new md.Document(nodes);
  }

  static norm(text: string): string {
    return text
      .replace(/ {2,}/g, " ")
      .replace(/\\([_*[\]()~`>#+\-.!|{}])/g, "$1");
  }

  parseParagraph(element: Element): md.Paragraph {
    const nodes: md.MdNode[] = [];
    for (const child of element.children) {
      if (child instanceof TextNode) {
        if (child.text) nodes.push(new md.Text(Parser.norm(child.text)));
        continue;
      }
      switch (child.name) {
        case "a":
          nodes.push(this.parseLink(child));
          break;
        case "b":
        case "strong":
          nodes.push(new md.Strong(Parser.norm(child.text)));
          break;
        case "i":
        case "em": {
          // Zhihu renders the underscores of an identifier such as
          // define_static_ as italics; an <em> touching word characters
          // is such an identifier.
          const prev = nodes[nodes.length - 1];
          const prevText =
            prev instanceof md.Text ||
            prev instanceof md.Emphasis ||
            prev instanceof md.Strong ||
            prev instanceof md.Header
              ? prev.text
              : "";
          const nextSib = child.nextSibling;
          const nextText =
            nextSib instanceof TextNode ? firstChar(nextSib.data) : "";
          const text = Parser.norm(child.text);
          const prevLast = lastChar(prevText);
          const prevIsWord =
            prevText !== "" && (isAlnum(prevLast) || prevLast === "_");
          const nextIsWord =
            nextText !== "" &&
            (isAlnum(nextText) || nextText === "_" || nextText === "{");
          if (prevIsWord || nextIsWord) {
            nodes.push(new md.Text(`\\_${text}\\_`));
          } else {
            nodes.push(new md.Emphasis(text));
          }
          break;
        }
        case "code":
          nodes.push(new md.InlineCode(child.text));
          break;
        case "br":
          nodes.push(new md.NewLine());
          break;
        case "hr":
          nodes.push(new md.HorizontalRule());
          break;
        case "span":
        case "sup":
        case "sub":
        case "section":
          if (child.text) nodes.push(new md.Text(Parser.norm(child.text)));
          break;
        case "figure": {
          const node = this.parseImage(child);
          if (node !== null) nodes.push(node);
          break;
        }
        default:
          Parser.warnSkip(child.name, "paragraph");
      }
    }
    return new md.Paragraph(nodes);
  }

  normalizeUrl(url: string): string {
    url = unquote(url.replaceAll("//link.zhihu.com/?target=https%3A", ""));
    url = Parser.urlsMap.get(url) ?? url;
    // The repository was about-me until 2026-11; the Zhihu articles keep its links.
    url = url.replaceAll(
      "https://github.com/16bit-ykiko/about-me/",
      "https://github.com/16bit-ykiko/ykiko.me/",
    );
    return url.replace(
      OLD_PAGES_ARTICLE,
      "https://ykiko.me/zh-cn/articles/$1/",
    );
  }

  parseLink(element: Element): md.Link {
    const href = element.attr("href");
    if (href === undefined) throw new Error("Link without href");
    const url = this.normalizeUrl(href);
    const label = this.parseParagraph(element).toString();
    return new md.Link(label, url);
  }

  parseLinkcard(element: Element): md.LinkCard {
    const title = element.attr("data-text");
    const href = element.attr("href");
    if (href === undefined) throw new Error("Link card without href");
    return new md.LinkCard(title ? title : "", this.normalizeUrl(href));
  }

  parseImage(element: Element): md.Image | null {
    let img = element.find("img");
    if (img === null) {
      const noscript = element.find("noscript");
      img = noscript ? noscript.find("img") : null;
    }
    if (img === null) {
      Parser.warnSkip("figure", "image parsing");
      return null;
    }
    let src: string | undefined;
    for (const attr of ["data-original", "data-default-watermark-src", "src"]) {
      src = img.attr(attr);
      if (src !== undefined) break;
    }
    if (src === undefined) throw new Error("Image src not found");
    const figcaption = element.find("figcaption");
    return new md.Image(
      figcaption ? figcaption.text : "",
      this.normalizeUrl(src),
    );
  }

  parseList(element: Element): md.MdNode | null {
    const nodes: md.MdNode[] = [];
    for (const child of element.children) {
      if (child instanceof TextNode) continue;
      switch (child.name) {
        case "li":
          nodes.push(this.parseLiContent(child));
          break;
        case "ul":
        case "ol": {
          const node = this.parseList(child);
          if (node !== null) nodes.push(node);
          break;
        }
        default:
          Parser.warnSkip(child.name, "list");
      }
    }
    if (nodes.length === 0) return null;
    return new md.List(element.name === "ol", nodes);
  }

  // Zhihu wraps the text of a loose list item in <p>.
  parseLiContent(element: Element): md.MdNode {
    const childNames = new Set(element.elements().map((c) => c.name));
    if (childNames.has("p")) {
      const parts: md.MdNode[] = [];
      for (const child of element.children) {
        if (child instanceof Element && child.name === "p") {
          parts.push(...this.parseParagraph(child).children);
        } else if (child instanceof TextNode && strip(child.text)) {
          parts.push(new md.Text(Parser.norm(child.text)));
        }
      }
      return new md.Paragraph(parts);
    }
    if (childNames.has("ul") || childNames.has("ol")) {
      for (const child of element.elements()) {
        if (child.name === "ul" || child.name === "ol") {
          const nested = this.parseList(child);
          if (nested !== null) return nested;
        }
      }
    }
    return this.parseParagraph(element);
  }

  parseDiv(element: Element): md.MdNode | null {
    const pre = element.find("pre");
    if (pre === null) {
      Parser.warnSkip("div", "block parsing");
      return null;
    }
    const code = pre.find("code");
    if (code === null) {
      Parser.warnSkip("pre", "code block parsing");
      return null;
    }
    const text = removeSuffix(code.text, "\n");
    const classes = code.classes();
    let language =
      classes.length > 0 ? removePrefix(classes[0]!, "language-") : "";
    language = Parser.languagesMap.get(language) ?? language;
    return new md.BlockCode(text, language);
  }

  // A blockquote whose paragraphs were separated by <br><br> comes back as
  // several <p>.
  parseBlockquote(element: Element): md.BlockQuote {
    if (element.elements().some((c) => c.name === "p")) {
      const parts: md.MdNode[] = [];
      for (const child of element.children) {
        if (child instanceof Element && child.name === "p") {
          if (parts.length > 0) parts.push(new md.NewLine(), new md.NewLine());
          parts.push(...this.parseParagraph(child).children);
        } else if (child instanceof TextNode && strip(child.text)) {
          parts.push(new md.Text(Parser.norm(child.text)));
        }
      }
      return new md.BlockQuote(new md.Paragraph(parts));
    }
    return new md.BlockQuote(this.parseParagraph(element));
  }

  parseTable(element: Element): md.Table | null {
    const rows: string[][] = [];
    const tbody = element.find("tbody") ?? element;
    for (const tr of tbody.findAll("tr")) {
      const cells = tr
        .findAll(["th", "td"])
        .map((cell) => Parser.norm(textOf(cell)));
      if (cells.length > 0) rows.push(cells);
    }
    return rows.length > 0 ? new md.Table(rows) : null;
  }
}

function dig(data: Json, path: string[]): JsonObject {
  let current: Json = data;
  for (const key of path) {
    if (!isObject(current) || !Object.hasOwn(current, key)) {
      throw new Error(`Missing key: ${key}`);
    }
    current = current[key]!;
  }
  if (!isObject(current))
    throw new Error(`Expected an object at ${path.join(".")}`);
  return current;
}
