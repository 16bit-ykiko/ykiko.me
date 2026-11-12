// YAML written in the layout the front matter and the cookie cache already
// have, so that a file the sync rewrites stays byte for byte what it was:
// plain scalars where YAML 1.1 allows them, single quotes otherwise, long
// values folded at 80 columns, keys of 123 characters or more written as
// "? key". Reading goes through the yaml package in YAML 1.1 mode.
import { parse, type ScalarTag, type Tags } from "yaml";

export type YamlValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | YamlValue[]
  | { [key: string]: YamlValue };

export interface DumpOptions {
  // A sequence inside a mapping sits at the mapping's indent ("key:\n- a")
  // unless this is set; the front matter indents it, as prettier does.
  indentSequences?: boolean;
}

const BREAKS = "\n\x85\u2028\u2029";
const SPACE_OR_BREAK = "\0 \t\r\n\x85\u2028\u2029";

const RESOLVERS: [string, RegExp][] = [
  [
    "bool",
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)\n?$/,
  ],
  [
    "float",
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\n?$/,
  ],
  [
    "int",
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)\n?$/,
  ],
  ["merge", /^(?:<<)\n?$/],
  ["null", /^(?:~|null|Null|NULL|)\n?$/],
  [
    "timestamp",
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)\n?$/,
  ],
  ["value", /^(?:=)\n?$/],
  ["yaml", /^(?:!|&|\*)\n?$/],
];

// Scalars resolve the way the front matter was always read: YAML 1.1 types
// narrowed to the resolvers below, so "y", "08" or "1e3" stay strings.
function narrowedTags(tags: Tags): Tags {
  return tags.map((tag) => {
    if (typeof tag !== "object" || !("test" in tag) || !tag.test) return tag;
    const kind = tag.tag.replace("tag:yaml.org,2002:", "");
    const resolver = RESOLVERS.find(([name]) => name === kind)?.[1];
    if (!resolver) return tag;
    const own = tag.test.source.replace(/^\^/, "");
    const test = new RegExp(
      `^(?=${resolver.source.slice(1)})${own}`,
      tag.test.flags,
    );
    return { ...tag, test } satisfies ScalarTag;
  });
}

export function loadYaml(text: string): YamlValue {
  return parse(text, {
    version: "1.1",
    schema: "yaml-1.1",
    intAsBigInt: true,
    customTags: narrowedTags,
  }) as YamlValue;
}

const FIRST_CHARS: Record<string, string> = {
  bool: "yYnNtTfFoO",
  float: "-+0123456789.",
  int: "-+0123456789",
  merge: "<",
  null: "~nN",
  timestamp: "0123456789",
  value: "=",
  yaml: "!&*",
};

function resolve(value: string): string {
  for (const [tag, re] of RESOLVERS) {
    const first = value === "" ? "" : value[0]!;
    const applies =
      value === "" ? tag === "null" : FIRST_CHARS[tag]!.includes(first);
    if (applies && re.test(value)) return tag;
  }
  return "str";
}

interface Analysis {
  scalar: string;
  empty: boolean;
  multiline: boolean;
  allowFlowPlain: boolean;
  allowBlockPlain: boolean;
  allowSingleQuoted: boolean;
}

function analyzeScalar(scalar: string): Analysis {
  if (!scalar) {
    return {
      scalar,
      empty: true,
      multiline: false,
      allowFlowPlain: false,
      allowBlockPlain: true,
      allowSingleQuoted: true,
    };
  }
  const chars = Array.from(scalar);
  let blockIndicators = false;
  let flowIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;

  if (scalar.startsWith("---") || scalar.startsWith("...")) {
    blockIndicators = true;
    flowIndicators = true;
  }
  let precededByWhitespace = true;
  let followedByWhitespace =
    chars.length === 1 || SPACE_OR_BREAK.includes(chars[1]!);
  let previousSpace = false;
  let previousBreak = false;

  for (let index = 0; index < chars.length; ) {
    const ch = chars[index]!;
    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
        flowIndicators = true;
        blockIndicators = true;
      }
      if (ch === "?" || ch === ":") {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === "-" && followedByWhitespace) {
        flowIndicators = true;
        blockIndicators = true;
      }
    } else {
      if (",?[]{}".includes(ch)) flowIndicators = true;
      if (ch === ":") {
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === "#" && precededByWhitespace) {
        flowIndicators = true;
        blockIndicators = true;
      }
    }

    if (BREAKS.includes(ch)) lineBreaks = true;
    const cp = ch.codePointAt(0)!;
    if (!(ch === "\n" || (cp >= 0x20 && cp <= 0x7e))) {
      const printable =
        (cp === 0x85 ||
          (cp >= 0xa0 && cp <= 0xd7ff) ||
          (cp >= 0xe000 && cp <= 0xfffd) ||
          (cp >= 0x10000 && cp < 0x10ffff)) &&
        cp !== 0xfeff;
      if (!printable) specialCharacters = true;
    }

    if (ch === " ") {
      if (index === 0) leadingSpace = true;
      if (index === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (BREAKS.includes(ch)) {
      if (index === 0) leadingBreak = true;
      if (index === chars.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }

    index++;
    precededByWhitespace = SPACE_OR_BREAK.includes(ch);
    followedByWhitespace =
      index + 1 >= chars.length || SPACE_OR_BREAK.includes(chars[index + 1]!);
  }

  let allowFlowPlain = true;
  let allowBlockPlain = true;
  let allowSingleQuoted = true;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
    allowFlowPlain = allowBlockPlain = false;
  }
  if (breakSpace) allowFlowPlain = allowBlockPlain = allowSingleQuoted = false;
  if (spaceBreak || specialCharacters) {
    allowFlowPlain = allowBlockPlain = allowSingleQuoted = false;
  }
  if (lineBreaks) allowFlowPlain = allowBlockPlain = false;
  if (flowIndicators) allowFlowPlain = false;
  if (blockIndicators) allowBlockPlain = false;
  return {
    scalar,
    empty: false,
    multiline: lineBreaks,
    allowFlowPlain,
    allowBlockPlain,
    allowSingleQuoted,
  };
}

const ESCAPES: Record<string, string> = {
  "\0": "0",
  "\x07": "a",
  "\x08": "b",
  "\x09": "t",
  "\x0A": "n",
  "\x0B": "v",
  "\x0C": "f",
  "\x0D": "r",
  "\x1B": "e",
  '"': '"',
  "\\": "\\",
  "\x85": "N",
  "\xA0": "_",
  "\u2028": "L",
  "\u2029": "P",
};

const BEST_WIDTH = 80;
const BEST_INDENT = 2;

interface Context {
  root?: boolean;
  sequence?: boolean;
  mapping?: boolean;
  simpleKey?: boolean;
}

class Emitter {
  out = "";
  column = 0;
  whitespace = true;
  indention = true;
  openEnded = false;
  indent: number | null = null;
  indents: (number | null)[] = [];
  flowLevel = 0;
  rootContext = false;
  mappingContext = false;
  simpleKeyContext = false;
  private readonly indentSequences: boolean;

  constructor(options: DumpOptions) {
    this.indentSequences = options.indentSequences ?? false;
  }

  private write(data: string): void {
    this.out += data;
    this.column += Array.from(data).length;
  }

  private writeIndicator(
    indicator: string,
    needWhitespace: boolean,
    whitespace = false,
    indention = false,
  ): void {
    const data =
      this.whitespace || !needWhitespace ? indicator : " " + indicator;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.openEnded = false;
    this.write(data);
  }

  private writeIndent(): void {
    const indent = this.indent ?? 0;
    if (
      !this.indention ||
      this.column > indent ||
      (this.column === indent && !this.whitespace)
    ) {
      this.writeLineBreak();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.out += " ".repeat(indent - this.column);
      this.column = indent;
    }
  }

  private writeLineBreak(data = "\n"): void {
    this.whitespace = true;
    this.indention = true;
    this.column = 0;
    this.out += data;
  }

  private increaseIndent(flow: boolean, indentless = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) {
      this.indent = flow ? BEST_INDENT : 0;
    } else if (!indentless) {
      this.indent += BEST_INDENT;
    }
  }

  dump(value: YamlValue): string {
    this.node(value, { root: true });
    this.writeIndent();
    if (this.openEnded) {
      this.writeIndicator("...", true);
      this.writeIndent();
    }
    return this.out;
  }

  private node(value: YamlValue, ctx: Context): void {
    this.rootContext = ctx.root ?? false;
    this.mappingContext = ctx.mapping ?? false;
    this.simpleKeyContext = ctx.simpleKey ?? false;
    if (Array.isArray(value)) {
      if (this.flowLevel || value.length === 0) this.flowSequence(value);
      else this.blockSequence(value);
    } else if (isMapping(value)) {
      if (this.flowLevel || Object.keys(value).length === 0)
        this.flowMapping(value);
      else this.blockMapping(value);
    } else {
      this.increaseIndent(true);
      this.scalar(represent(value));
      this.indent = this.indents.pop()!;
    }
  }

  private flowSequence(items: YamlValue[]): void {
    this.writeIndicator("[", true, true);
    this.flowLevel++;
    this.increaseIndent(true);
    items.forEach((item, i) => {
      if (i > 0) this.writeIndicator(",", false);
      if (this.column > BEST_WIDTH) this.writeIndent();
      this.node(item, { sequence: true });
    });
    this.indent = this.indents.pop()!;
    this.flowLevel--;
    this.writeIndicator("]", false);
  }

  private flowMapping(map: { [key: string]: YamlValue }): void {
    this.writeIndicator("{", true, true);
    this.flowLevel++;
    this.increaseIndent(true);
    Object.entries(map).forEach(([key, value], i) => {
      if (i > 0) this.writeIndicator(",", false);
      if (this.column > BEST_WIDTH) this.writeIndent();
      if (this.checkSimpleKey(key)) {
        this.node(key, { mapping: true, simpleKey: true });
        this.writeIndicator(":", false);
      } else {
        this.writeIndicator("?", true);
        this.node(key, { mapping: true });
        if (this.column > BEST_WIDTH) this.writeIndent();
        this.writeIndicator(":", true);
      }
      this.node(value, { mapping: true });
    });
    this.indent = this.indents.pop()!;
    this.flowLevel--;
    this.writeIndicator("}", false);
  }

  private blockSequence(items: YamlValue[]): void {
    const indentless =
      this.mappingContext && !this.indention && !this.indentSequences;
    this.increaseIndent(false, indentless);
    for (const item of items) {
      this.writeIndent();
      this.writeIndicator("-", true, false, true);
      this.node(item, { sequence: true });
    }
    this.indent = this.indents.pop()!;
  }

  private blockMapping(map: { [key: string]: YamlValue }): void {
    this.increaseIndent(false);
    for (const [key, value] of Object.entries(map)) {
      this.writeIndent();
      if (this.checkSimpleKey(key)) {
        this.node(key, { mapping: true, simpleKey: true });
        this.writeIndicator(":", false);
      } else {
        this.writeIndicator("?", true, false, true);
        this.node(key, { mapping: true });
        this.writeIndent();
        this.writeIndicator(":", true, false, true);
      }
      this.node(value, { mapping: true });
    }
    this.indent = this.indents.pop()!;
  }

  private checkSimpleKey(key: string): boolean {
    // The length counts the key's tag, "!!str", although it is not written.
    const analysis = analyzeScalar(key);
    return (
      Array.from(key).length + 5 < 128 && !analysis.empty && !analysis.multiline
    );
  }

  private scalar({ value, implicitPlain }: Scalar): void {
    const analysis = analyzeScalar(value);
    const split = !this.simpleKeyContext;
    let style: "" | "'" | '"' = '"';
    if (
      implicitPlain &&
      !(this.simpleKeyContext && (analysis.empty || analysis.multiline)) &&
      ((this.flowLevel && analysis.allowFlowPlain) ||
        (!this.flowLevel && analysis.allowBlockPlain))
    ) {
      style = "";
    } else if (
      analysis.allowSingleQuoted &&
      !(this.simpleKeyContext && analysis.multiline)
    ) {
      style = "'";
    }
    if (style === "") this.writePlain(value, split);
    else if (style === "'") this.writeSingleQuoted(value, split);
    else this.writeDoubleQuoted(value, split);
  }

  private writePlain(text: string, split: boolean): void {
    if (this.rootContext) this.openEnded = true;
    if (!text) return;
    if (!this.whitespace) this.write(" ");
    this.whitespace = false;
    this.indention = false;
    const chars = Array.from(text);
    let spaces = false;
    let breaks = false;
    let start = 0;
    for (let end = 0; end <= chars.length; end++) {
      const ch = end < chars.length ? chars[end]! : null;
      if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && this.column > BEST_WIDTH && split) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
          } else {
            this.write(chars.slice(start, end).join(""));
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (chars[start] === "\n") this.writeLineBreak();
          for (const br of chars.slice(start, end)) {
            this.writeLineBreak(br === "\n" ? "\n" : br);
          }
          this.writeIndent();
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else if (ch === null || (" " + BREAKS).includes(ch)) {
        this.write(chars.slice(start, end).join(""));
        start = end;
      }
      if (ch !== null) {
        spaces = ch === " ";
        breaks = BREAKS.includes(ch);
      }
    }
  }

  private writeSingleQuoted(text: string, split: boolean): void {
    this.writeIndicator("'", true);
    const chars = Array.from(text);
    let spaces = false;
    let breaks = false;
    let start = 0;
    for (let end = 0; end <= chars.length; end++) {
      const ch = end < chars.length ? chars[end]! : null;
      if (spaces) {
        if (ch === null || ch !== " ") {
          if (
            start + 1 === end &&
            this.column > BEST_WIDTH &&
            split &&
            start !== 0 &&
            end !== chars.length
          ) {
            this.writeIndent();
          } else {
            this.write(chars.slice(start, end).join(""));
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (chars[start] === "\n") this.writeLineBreak();
          for (const br of chars.slice(start, end)) {
            this.writeLineBreak(br === "\n" ? "\n" : br);
          }
          this.writeIndent();
          start = end;
        }
      } else if (ch === null || (" " + BREAKS).includes(ch) || ch === "'") {
        if (start < end) {
          this.write(chars.slice(start, end).join(""));
          start = end;
        }
      }
      if (ch === "'") {
        this.write("''");
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === " ";
        breaks = BREAKS.includes(ch);
      }
    }
    this.writeIndicator("'", false);
  }

  private writeDoubleQuoted(text: string, split: boolean): void {
    this.writeIndicator('"', true);
    const chars = Array.from(text);
    let start = 0;
    for (let end = 0; end <= chars.length; end++) {
      const ch = end < chars.length ? chars[end]! : null;
      const cp = ch === null ? 0 : ch.codePointAt(0)!;
      if (
        ch === null ||
        '"\\\x85\u2028\u2029\uFEFF'.includes(ch) ||
        !(
          (cp >= 0x20 && cp <= 0x7e) ||
          (cp >= 0xa0 && cp <= 0xd7ff) ||
          (cp >= 0xe000 && cp <= 0xfffd)
        )
      ) {
        if (start < end) {
          this.write(chars.slice(start, end).join(""));
          start = end;
        }
        if (ch !== null) {
          let data: string;
          if (ESCAPES[ch] !== undefined) data = "\\" + ESCAPES[ch];
          else if (cp <= 0xff)
            data = "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
          else if (cp <= 0xffff)
            data = "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
          else data = "\\U" + cp.toString(16).toUpperCase().padStart(8, "0");
          this.write(data);
          start = end + 1;
        }
      }
      if (
        end > 0 &&
        end < chars.length - 1 &&
        (ch === " " || start >= end) &&
        this.column + (end - start) > BEST_WIDTH &&
        split
      ) {
        const data = chars.slice(start, end).join("") + "\\";
        if (start < end) start = end;
        this.write(data);
        this.writeIndent();
        this.whitespace = false;
        this.indention = false;
        if (chars[start] === " ") this.write("\\");
      }
    }
    this.writeIndicator('"', false);
  }
}

interface Scalar {
  value: string;
  implicitPlain: boolean;
}

function isMapping(value: YamlValue): value is { [key: string]: YamlValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function represent(
  value: Exclude<YamlValue, YamlValue[] | { [key: string]: YamlValue }>,
): Scalar {
  if (value === null) return { value: "null", implicitPlain: true };
  if (typeof value === "boolean")
    return { value: value ? "true" : "false", implicitPlain: true };
  if (typeof value === "bigint")
    return { value: value.toString(), implicitPlain: true };
  if (typeof value === "number") {
    if (Number.isInteger(value))
      return { value: String(value), implicitPlain: true };
    let text: string;
    if (Number.isNaN(value)) text = ".nan";
    else if (value === Infinity) text = ".inf";
    else if (value === -Infinity) text = "-.inf";
    else {
      text = String(value).toLowerCase();
      if (!text.includes(".") && text.includes("e"))
        text = text.replace("e", ".0e");
    }
    return { value: text, implicitPlain: true };
  }
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const midnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;
    if (midnight) return { value: date, implicitPlain: true };
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
    return { value: `${date} ${time}`, implicitPlain: true };
  }
  return { value, implicitPlain: resolve(value) === "str" };
}

export function dumpYaml(value: YamlValue, options: DumpOptions = {}): string {
  return new Emitter(options).dump(value);
}
