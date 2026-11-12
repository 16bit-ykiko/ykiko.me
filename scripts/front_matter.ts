import { writeFileSync } from "node:fs";
import {
  WORD_CLASS,
  WS_CLASS,
  lstripChars,
  readText,
  rstrip,
  strip,
} from "./text.ts";
import { dumpYaml, loadYaml, type YamlValue } from "./yaml_io.ts";

export type Metadata = { [key: string]: YamlValue };

const TO_DOUBLE_QUOTES = new RegExp(
  `(?:(?<![\\s\\S])|(?<=\\n))(${WS_CLASS}*(?:${WORD_CLASS}|-)+:) '((?:[^'\\\\]|\\\\[^\\n])*)'(?=\\n|(?![\\s\\S]))`,
  "gu",
);

// Single-quoted values are rewritten with double quotes, as prettier would
// print them, unless the text holds a double quote or a backslash, which
// would mean something else between double quotes.
function toDoubleQuotes(yamlText: string): string {
  return yamlText.replace(
    TO_DOUBLE_QUOTES,
    (m: string, key: string, value: string) =>
      /["\\]/.test(value) ? m : `${key} "${value}"`,
  );
}

function asMetadata(value: YamlValue): Metadata {
  if (value === null || value === false || value === 0 || value === "")
    return {};
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    throw new Error("Markdown front matter must be a YAML mapping.");
  }
  return value;
}

export function splitFrontMatter(markdownText: string): {
  metadata: Metadata;
  body: string;
  hasFrontMatter: boolean;
} {
  if (!markdownText.startsWith("---\n")) {
    return { metadata: {}, body: markdownText, hasFrontMatter: false };
  }
  const endIndex = markdownText.indexOf("\n---\n", 4);
  if (endIndex === -1)
    return { metadata: {}, body: markdownText, hasFrontMatter: false };
  const metadata = asMetadata(loadYaml(markdownText.slice(4, endIndex)));
  const body = lstripChars(markdownText.slice(endIndex + 5), "\n");
  return { metadata, body, hasFrontMatter: true };
}

export function extractFrontMatter(markdownText: string): [Metadata, string] {
  const { metadata, body } = splitFrontMatter(markdownText);
  return [metadata, body];
}

export function renderFrontMatter(
  metadata: Metadata,
  body: string,
  options: { trimLeadingNewlines?: boolean } = {},
): string {
  const frontMatter = strip(
    toDoubleQuotes(dumpYaml(metadata, { indentSequences: true })),
  );
  const strippedBody = rstrip(
    (options.trimLeadingNewlines ? lstripChars(body, "\n") : body)
      .split("\n")
      .map((line) => rstrip(line))
      .join("\n"),
  );
  return `---\n${frontMatter}\n---\n\n${strippedBody}\n`;
}

export function readMarkdownDocument(path: string): [Metadata, string] {
  return extractFrontMatter(readText(path));
}

export function writeMarkdownDocument(
  path: string,
  metadata: Metadata,
  body: string,
): void {
  writeFileSync(path, renderFrontMatter(metadata, body), "utf8");
}

export function metadataString(metadata: Metadata, key: string): string {
  const value = metadata[key];
  if (value === undefined || value === null) return "";
  return yamlToString(value);
}

// str() of a value loaded from YAML.
export function yamlToString(value: YamlValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}
