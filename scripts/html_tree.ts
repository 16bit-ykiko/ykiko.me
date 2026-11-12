// A lenient HTML tree in the shape the Zhihu parser expects: nothing is
// restructured (a <figure> inside a <p> stays there), an end tag closes the
// nearest open element of its name and is dropped when there is none, and a
// string of nothing but ASCII whitespace outside <pre> collapses to a single
// "\n" or " ". htmlparser2 only tokenizes.
import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";

export type StringKind =
  | "text"
  | "cdata"
  | "comment"
  | "doctype"
  | "pi"
  | "script"
  | "style"
  | "template"
  | "rt"
  | "rp";

export type Node = Element | TextNode;

export class TextNode {
  readonly name = null;
  kind: StringKind;
  data: string;
  parent: Element | null = null;

  constructor(data: string, kind: StringKind = "text") {
    this.data = data;
    this.kind = kind;
  }

  get text(): string {
    return MAIN_CONTENT.has(this.kind) ? this.data : "";
  }

  get nextSibling(): Node | null {
    return sibling(this, 1);
  }

  get previousSibling(): Node | null {
    return sibling(this, -1);
  }

  extract(): this {
    detach(this);
    return this;
  }

  replaceWith(data: string): void {
    const parent = this.parent;
    if (!parent) return;
    const node = new TextNode(data);
    node.parent = parent;
    parent.children[parent.children.indexOf(this)] = node;
    this.parent = null;
  }
}

export class Element {
  name: string;
  attrs: Map<string, string>;
  children: Node[] = [];
  parent: Element | null = null;

  constructor(name: string, attrs: Map<string, string> = new Map()) {
    this.name = name;
    this.attrs = attrs;
  }

  get text(): string {
    const kinds = containerKind(this.name);
    let out = "";
    for (const node of this.descendants()) {
      if (node instanceof TextNode && kinds.has(node.kind)) out += node.data;
    }
    return out;
  }

  get nextSibling(): Node | null {
    return sibling(this, 1);
  }

  get previousSibling(): Node | null {
    return sibling(this, -1);
  }

  attr(name: string): string | undefined {
    return this.attrs.get(name);
  }

  classes(): string[] {
    const value = this.attrs.get("class");
    return value === undefined ? [] : splitClass(value);
  }

  *descendants(): Generator<Node> {
    for (const child of this.children) {
      yield child;
      if (child instanceof Element) yield* child.descendants();
    }
  }

  elements(): Element[] {
    return this.children.filter((c): c is Element => c instanceof Element);
  }

  find(names: string | string[]): Element | null {
    const wanted = typeof names === "string" ? [names] : names;
    for (const node of this.descendants()) {
      if (node instanceof Element && wanted.includes(node.name)) return node;
    }
    return null;
  }

  findAll(names: string | string[]): Element[] {
    const wanted = typeof names === "string" ? [names] : names;
    const found: Element[] = [];
    for (const node of this.descendants()) {
      if (node instanceof Element && wanted.includes(node.name)) {
        found.push(node);
      }
    }
    return found;
  }

  findFirst(match: (el: Element) => boolean): Element | null {
    for (const node of this.descendants()) {
      if (node instanceof Element && match(node)) return node;
    }
    return null;
  }

  firstString(): TextNode | null {
    for (const node of this.descendants()) {
      if (node instanceof TextNode) return node;
    }
    return null;
  }

  append(node: Node): void {
    detach(node);
    node.parent = this;
    this.children.push(node);
  }

  extract(): this {
    detach(this);
    return this;
  }
}

const MAIN_CONTENT = new Set<StringKind>(["text", "cdata"]);
const STRING_CONTAINERS = new Map<string, StringKind>([
  ["rt", "rt"],
  ["rp", "rp"],
  ["style", "style"],
  ["script", "script"],
  ["template", "template"],
]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "menuitem",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "basefont",
  "bgsound",
  "command",
  "frame",
  "image",
  "isindex",
  "nextid",
  "spacer",
]);
const PRESERVE_WHITESPACE = new Set(["pre", "textarea"]);
const LIST_ATTRIBUTES = new Map<string, Set<string>>([
  ["*", new Set(["class", "accesskey", "dropzone"])],
  ["a", new Set(["rel", "rev"])],
  ["link", new Set(["rel", "rev"])],
  ["td", new Set(["headers"])],
  ["th", new Set(["headers"])],
  ["form", new Set(["accept-charset"])],
  ["object", new Set(["archive"])],
  ["area", new Set(["rel"])],
  ["icon", new Set(["sizes"])],
  ["iframe", new Set(["sandbox"])],
  ["output", new Set(["for"])],
]);

function containerKind(name: string): Set<StringKind> {
  const kind = STRING_CONTAINERS.get(name);
  return kind ? new Set([kind]) : MAIN_CONTENT;
}

function isListAttribute(tag: string, attr: string): boolean {
  return (
    LIST_ATTRIBUTES.get("*")!.has(attr) ||
    (LIST_ATTRIBUTES.get(tag)?.has(attr) ?? false)
  );
}

function splitClass(value: string): string[] {
  return value.split(/[ \t\n\r\f\v]+/).filter(Boolean);
}

function sibling(node: Node, step: number): Node | null {
  const parent = node.parent;
  if (!parent) return null;
  return parent.children[parent.children.indexOf(node) + step] ?? null;
}

function detach(node: Node): void {
  const parent = node.parent;
  if (!parent) return;
  parent.children.splice(parent.children.indexOf(node), 1);
  node.parent = null;
}

export function newElement(name: string): Element {
  return new Element(name);
}

class TreeBuilder implements TokenizerCallbacks {
  readonly root = new Element("[document]");
  private readonly source: string;
  private stack: Element[] = [this.root];
  private pending: string[] = [];
  private tagName = "";
  private attrs = new Map<string, string>();
  private attrName = "";
  private attrValue = "";

  constructor(source: string) {
    this.source = source;
  }

  private get current(): Element {
    return this.stack[this.stack.length - 1]!;
  }

  private flush(kind?: StringKind): void {
    if (this.pending.length === 0) return;
    let data = this.pending.join("");
    this.pending = [];
    const preserve = this.stack.some((el) => PRESERVE_WHITESPACE.has(el.name));
    if (!preserve && /^[ \n\t\f\r]*$/.test(data)) {
      data = data.includes("\n") ? "\n" : " ";
    }
    if (!kind) {
      kind = "text";
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const container = STRING_CONTAINERS.get(this.stack[i]!.name);
        if (container) {
          kind = container;
          break;
        }
      }
    }
    const node = new TextNode(data, kind);
    node.parent = this.current;
    this.current.children.push(node);
  }

  private open(name: string, attrs: Map<string, string>): void {
    this.flush();
    for (const [key, value] of attrs) {
      if (isListAttribute(name, key))
        attrs.set(key, splitClass(value).join(" "));
    }
    const el = new Element(name, attrs);
    el.parent = this.current;
    this.current.children.push(el);
    this.stack.push(el);
  }

  private close(name: string): void {
    this.flush();
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (this.stack[i]!.name === name) {
        this.stack.length = i;
        return;
      }
    }
  }

  ontext(start: number, end: number): void {
    this.pending.push(this.source.slice(start, end));
  }

  ontextentity(codepoint: number): void {
    this.pending.push(String.fromCodePoint(codepoint));
  }

  onopentagname(start: number, end: number): void {
    this.tagName = this.source.slice(start, end).toLowerCase();
    this.attrs = new Map();
  }

  onattribname(start: number, end: number): void {
    this.attrName = this.source.slice(start, end).toLowerCase();
    this.attrValue = "";
  }

  onattribdata(start: number, end: number): void {
    this.attrValue += this.source.slice(start, end);
  }

  onattribentity(codepoint: number): void {
    this.attrValue += String.fromCodePoint(codepoint);
  }

  onattribend(): void {
    this.attrs.set(this.attrName, this.attrValue);
    this.attrValue = "";
  }

  onopentagend(): void {
    const name = this.tagName;
    this.open(name, this.attrs);
    if (VOID_ELEMENTS.has(name)) this.close(name);
  }

  onselfclosingtag(): void {
    const name = this.tagName;
    this.open(name, this.attrs);
    this.close(name);
  }

  onclosetag(start: number, end: number): void {
    this.close(this.source.slice(start, end).toLowerCase());
  }

  oncomment(start: number, end: number, offset: number): void {
    this.flush();
    this.pending.push(this.source.slice(start, end - offset));
    this.flush("comment");
  }

  oncdata(start: number, end: number, offset: number): void {
    this.flush();
    this.pending.push(this.source.slice(start, end - offset));
    this.flush("cdata");
  }

  ondeclaration(start: number, end: number): void {
    this.flush();
    this.pending.push(this.source.slice(start, end));
    this.flush("doctype");
  }

  onprocessinginstruction(start: number, end: number): void {
    this.flush();
    this.pending.push(this.source.slice(start, end));
    this.flush("pi");
  }

  onend(): void {
    this.flush();
  }
}

export function parseHtml(source: string): Element {
  const builder = new TreeBuilder(source);
  const tokenizer = new Tokenizer({ decodeEntities: true }, builder);
  tokenizer.write(source);
  tokenizer.end();
  return builder.root;
}

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
  );
}

function quoteAttribute(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('"', "&quot;")}"`;
}

const PREFIX: Partial<Record<StringKind, [string, string]>> = {
  comment: ["<!--", "-->"],
  cdata: ["<![CDATA[", "]]>"],
  doctype: ["<!", ">"],
  pi: ["<?", ">"],
};

function serialize(node: Node): string {
  if (node instanceof TextNode) {
    const wrap = PREFIX[node.kind];
    if (wrap) return wrap[0] + node.data + wrap[1];
    const parent = node.parent?.name;
    if (parent === "script" || parent === "style") return node.data;
    return escapeText(node.data);
  }
  const attrs = [...node.attrs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ` ${key}=${quoteAttribute(escapeText(value))}`)
    .join("");
  if (node.children.length === 0 && VOID_ELEMENTS.has(node.name)) {
    return `<${node.name}${attrs}/>`;
  }
  return `<${node.name}${attrs}>${decodeContents(node)}</${node.name}>`;
}

export function decodeContents(el: Element): string {
  return el.children.map(serialize).join("");
}
