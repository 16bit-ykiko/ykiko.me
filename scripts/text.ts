import { readFileSync } from "node:fs";

// String primitives with the semantics the article files were produced
// with: whitespace and word characters by Unicode category (the regex \s
// and \w of JavaScript are narrower or ASCII-only), strip over that
// whitespace, splitlines over every Unicode line boundary.

export const WS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const WS_CLASS = `[${WS}]`;
export const NON_WS_CLASS = `[^${WS}]`;
export const WORD_CLASS = "[\\p{L}\\p{N}_]";

const wsRun = new RegExp(`${WS_CLASS}+`, "u");
const leadingWs = new RegExp(`^${WS_CLASS}+`, "u");
const trailingWs = new RegExp(`${WS_CLASS}+$`, "u");
const isSpaceRe = new RegExp(`^${WS_CLASS}+$`, "u");
const alnumRe = /^[\p{L}\p{N}]$/u;

export function strip(text: string): string {
  return rstrip(lstrip(text));
}

export function lstrip(text: string): string {
  return text.replace(leadingWs, "");
}

export function rstrip(text: string): string {
  return text.replace(trailingWs, "");
}

export function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start++;
  while (end > start && chars.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

export function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

export function lstripChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start]!)) start++;
  return text.slice(start);
}

export function isSpace(text: string): boolean {
  return isSpaceRe.test(text);
}

export function hasSpace(text: string): boolean {
  return wsRun.test(text);
}

export function isAlnum(ch: string): boolean {
  return alnumRe.test(ch);
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function firstChar(text: string): string {
  for (const ch of text) return ch;
  return "";
}

export function lastChar(text: string): string {
  if (!text) return "";
  const cp = text.codePointAt(text.length - 1)!;
  if (cp >= 0xdc00 && cp <= 0xdfff && text.length > 1) {
    const hi = text.codePointAt(text.length - 2)!;
    if (hi > 0xffff) return String.fromCodePoint(hi);
  }
  return text[text.length - 1]!;
}

const lineBoundary = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/g;

export function splitlines(text: string, keepends = false): string[] {
  const lines: string[] = [];
  let start = 0;
  for (const m of text.matchAll(lineBoundary)) {
    const end = m.index + m[0].length;
    lines.push(text.slice(start, keepends ? end : m.index));
    start = end;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function removePrefix(text: string, prefix: string): string {
  return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function removeSuffix(text: string, suffix: string): string {
  return suffix && text.endsWith(suffix)
    ? text.slice(0, text.length - suffix.length)
    : text;
}

const utf8 = new TextDecoder("utf-8");

// urllib.parse.unquote: runs of %XX become UTF-8 bytes decoded with
// replacement characters; anything else, malformed escapes included, stays.
export function unquote(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return utf8.decode(bytes);
  });
}

export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

// Text files are read with universal newlines: "\r\n" and "\r" become "\n".
export function readText(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}
