import { charLength, rstrip, strip } from "./text.ts";

export abstract class MdNode {
  abstract toString(): string;
}

export class Paragraph extends MdNode {
  children: MdNode[];

  constructor(children: MdNode[]) {
    super();
    this.children = children;
  }

  toString(): string {
    return strip(
      this.children
        .map((child) => child.toString())
        .join("")
        .replace(/ {2,}/g, " "),
    );
  }
}

export class Text extends MdNode {
  text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  toString(): string {
    return this.text;
  }
}

export class Emphasis extends MdNode {
  text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  toString(): string {
    return `_${this.text}_`;
  }
}

export class Strong extends MdNode {
  text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  toString(): string {
    return `**${this.text}**`;
  }
}

export class Link extends MdNode {
  label: string;
  url: string;

  constructor(label: string, url: string) {
    super();
    this.label = label;
    this.url = url;
  }

  toString(): string {
    return `[${this.label}](${this.url})`;
  }
}

export class Image extends MdNode {
  label: string;
  url: string;

  constructor(label: string, url: string) {
    super();
    this.label = label;
    this.url = url;
  }

  toString(): string {
    return `![${this.label}](${this.url})`;
  }
}

export class InlineCode extends MdNode {
  code: string;

  constructor(code: string) {
    super();
    this.code = code;
  }

  toString(): string {
    return `\`${this.code}\``;
  }
}

export class BlockCode extends MdNode {
  code: string;
  language: string;

  constructor(code: string, language: string) {
    super();
    this.code = code;
    this.language = language;
  }

  toString(): string {
    return `\`\`\`${this.language}\n${this.code}\n\`\`\``;
  }
}

export class Header extends MdNode {
  level: number;
  text: string;

  constructor(level: number, text: string) {
    super();
    this.level = level;
    this.text = text;
  }

  toString(): string {
    return `${"#".repeat(this.level)} ${this.text}`;
  }
}

export class List extends MdNode {
  ordered: boolean;
  items: MdNode[];

  constructor(ordered: boolean, items: MdNode[]) {
    super();
    if (items.length === 0) throw new Error("List must have at least one item");
    this.ordered = ordered;
    this.items = items;
  }

  // A nested list is written at its parent's depth, which gives "- - item".
  toString(depth = 0): string {
    let result = "";
    const indent = "  ".repeat(depth);
    this.items.forEach((item, index) => {
      const prefix = this.ordered ? `${index + 1}. ` : "- ";
      if (item instanceof List) {
        result += `${indent}${prefix}${item.toString(depth)}`;
      } else {
        result += `${indent}${prefix}${item.toString()}\n`;
      }
    });
    return result;
  }
}

export class BlockQuote extends MdNode {
  children: Paragraph;

  constructor(children: Paragraph) {
    super();
    this.children = children;
  }

  toString(): string {
    return `> ${strip(this.children.toString())}`;
  }
}

export class HorizontalRule extends MdNode {
  toString(): string {
    return "---";
  }
}

export class NewLine extends MdNode {
  toString(): string {
    return "<br>";
  }
}

export class LinkCard extends MdNode {
  label: string;
  url: string;

  constructor(label: string, url: string) {
    super();
    this.label = label;
    this.url = url;
  }

  toString(): string {
    return `{{< linkcard url="${this.url}" title="${this.label}" >}}`;
  }
}

export class Table extends MdNode {
  rows: string[][];

  constructor(rows: string[][]) {
    super();
    if (rows.length === 0) throw new Error("Table must have at least one row");
    this.rows = rows;
  }

  toString(): string {
    const header = this.rows[0]!;
    const sep = header.map((h) => "-".repeat(Math.max(4, charLength(h))));
    const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
    for (const row of this.rows.slice(1)) lines.push(`| ${row.join(" | ")} |`);
    return lines.join("\n");
  }
}

export class Document {
  children: MdNode[];

  constructor(children: MdNode[]) {
    this.children = children;
  }

  dump(): string {
    return this.children.map((child) => rstrip(child.toString())).join("\n\n");
  }
}
