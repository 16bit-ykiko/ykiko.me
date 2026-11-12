// Translation through Google's Antigravity CLI (agy). agy reads the files in
// its working folder and writes there without asking, so each call runs in
// a fresh temporary folder outside the repository that holds only the text
// to translate, and the answer is read from its output between marker lines.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  renderFrontMatter,
  splitFrontMatter,
  type Metadata,
} from "./front_matter.ts";
import type { YamlValue } from "./yaml_io.ts";
import { REPO_ROOT, isMain } from "./paths.ts";
import { readText, strip } from "./text.ts";

export const DEFAULT_MODEL = "gemini-4-argon-high";
export const DEFAULT_FRONT_MATTER_KEYS = ["title", "description", "summary"];
const MARKDOWN_SUFFIXES = new Set([".md", ".markdown"]);
const PRINT_TIMEOUT = "40m";
const KILL_AFTER_MS = 45 * 60 * 1000;

export interface Field {
  name: string;
  text: string;
}

const begin = (name: string): string => `@@@ BEGIN ${name} @@@`;
const end = (name: string): string => `@@@ END ${name} @@@`;

export function buildPrompt(
  fields: Field[],
  options: {
    sourceLang: string;
    targetLang: string;
    markdown: boolean;
    file: string | null;
    lines: number;
  },
): string {
  const lines = [
    options.markdown
      ? "You are an expert technical translator."
      : "You are an expert bilingual translator.",
    `Source language: ${options.sourceLang}`,
    `Target language: ${options.targetLang}`,
    "",
  ];
  if (options.file) {
    lines.push(
      options.markdown
        ? `Translate the Markdown file ${options.file} in the current folder into the target language. It has ${options.lines} lines; read all of them.`
        : `Translate the text in the file ${options.file} in the current folder into the target language, naturally and accurately. It has ${options.lines} lines; read all of them.`,
    );
    if (options.markdown) {
      lines.push(
        "Preserve Markdown structure, headings, list structure, block quotes, tables, and emphasis markers.",
        "Preserve URLs exactly. Preserve fenced code blocks, inline code, and code identifiers unless a",
        "human-language comment inside code clearly needs translation.",
      );
    }
  }
  const others = fields.filter((f) => f.name !== "BODY");
  if (others.length > 0) {
    lines.push(
      "",
      options.file
        ? "Also translate each of these values:"
        : "Translate each of these values:",
    );
    for (const field of others) lines.push(`${field.name}: ${field.text}`);
  }
  lines.push(
    "",
    "Do not create, modify or delete any file. Do not add explanations, notes or a notice about the",
    "translation, and do not wrap the answer in code fences. Print the translations in exactly this",
    "format, each marker on a line of its own:",
    "",
  );
  for (const field of fields) {
    lines.push(
      begin(field.name),
      `<the translated ${field.name === "BODY" ? "file" : field.name}>`,
      end(field.name),
    );
  }
  return lines.join("\n");
}

export function parseAnswer(
  output: string,
  names: string[],
): Map<string, string> {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  const markers = lines.map((line) => line.trim());
  const result = new Map<string, string>();
  for (const name of names) {
    const start = markers.lastIndexOf(begin(name));
    const stop = start === -1 ? -1 : markers.indexOf(end(name), start + 1);
    if (start === -1 || stop === -1) {
      throw new Error(
        `agy's answer has no ${begin(name)} ... ${end(name)} block`,
      );
    }
    result.set(name, lines.slice(start + 1, stop).join("\n"));
  }
  return result;
}

// Settles once agy exits: a daemon it leaves behind may keep the output
// pipes open, so their end is not waited for beyond a short grace period.
function runAgy(prompt: string, model: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "agy",
      ["-p", prompt, "--model", model, "--print-timeout", PRINT_TIMEOUT],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, KILL_AFTER_MS);
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
        return;
      }
      const stderr = Buffer.concat(err)
        .toString("utf8")
        .trim()
        .split("\n")
        .slice(-20)
        .join("\n");
      reject(
        new Error(
          `agy exited with ${signal ?? code}${stderr ? `:\n${stderr}` : ""}`,
        ),
      );
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to run agy: ${error.message}`));
    });
    child.on("close", settle);
    child.on("exit", (code, signal) => {
      setTimeout(() => settle(code, signal), 2000).unref();
    });
  });
}

// agy reads the file through a tool that shows it in pieces; an answer that
// lost part of the article still comes back between its markers, so the
// code fences and headings are counted on both sides.
export function checkComplete(source: string, translated: string): void {
  const count = (text: string, re: RegExp): number =>
    text.split("\n").filter((line) => re.test(line)).length;
  for (const [what, re] of [
    ["code fences", /^\s*(```|~~~)/],
    ["headings", /^#{1,6}\s/],
  ] as const) {
    const expected = count(source, re);
    const got = count(translated, re);
    if (expected !== got) {
      throw new Error(
        `the translation looks incomplete: ${got} ${what} where the article has ${expected}`,
      );
    }
  }
}

function scratchFolder(): string {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "agy-translate-")),
  );
  const relative = path.relative(REPO_ROOT, dir);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `The temporary folder ${dir} is inside the repository; set TMPDIR elsewhere.`,
    );
  }
  return dir;
}

export class AgyTranslator {
  readonly model: string;

  constructor(model: string = DEFAULT_MODEL) {
    this.model = model;
  }

  // Translates the body (kept in a file of the scratch folder) and the other
  // fields in one call.
  async translate(
    body: string | null,
    others: Field[],
    options: { sourceLang: string; targetLang: string; markdown: boolean },
  ): Promise<Map<string, string>> {
    const fields: Field[] = [
      ...(body !== null ? [{ name: "BODY", text: body }] : []),
      ...others,
    ];
    if (fields.length === 0) return new Map();
    const dir = scratchFolder();
    try {
      const file =
        body === null ? null : options.markdown ? "article.md" : "text.txt";
      if (file !== null)
        writeFileSync(path.join(dir, file), body ?? "", "utf8");
      const lines = (body ?? "").split("\n").length;
      const prompt = buildPrompt(fields, { ...options, file, lines });
      console.error(
        `[agy] translating model=${this.model} (${fields.map((f) => f.name).join(", ")})`,
      );
      const output = await runAgy(prompt, this.model, dir);
      const answer = parseAnswer(
        output,
        fields.map((f) => f.name),
      );
      if (body !== null && options.markdown) {
        checkComplete(body, answer.get("BODY")!);
      }
      return answer;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async translateText(
    text: string,
    options: { sourceLang: string; targetLang: string; markdown: boolean },
  ): Promise<string> {
    if (!strip(text)) return text;
    return (await this.translate(text, [], options)).get("BODY")!;
  }

  async translateMarkdownDocument(
    markdownText: string,
    options: {
      sourceLang: string;
      targetLang: string;
      frontMatterKeys?: string[];
    },
  ): Promise<string> {
    const { metadata, body, hasFrontMatter } = splitFrontMatter(markdownText);
    const keys = hasFrontMatter
      ? (options.frontMatterKeys ?? DEFAULT_FRONT_MATTER_KEYS)
      : [];
    const others: Field[] = [];
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && strip(value))
        others.push({ name: key.toUpperCase(), text: value });
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (typeof item === "string" && strip(item)) {
            others.push({ name: `${key.toUpperCase()} ${i + 1}`, text: item });
          }
        });
      }
    }
    const answer = await this.translate(strip(body) ? body : null, others, {
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      markdown: true,
    });
    const translatedBody = answer.get("BODY") ?? body;
    if (!hasFrontMatter) return translatedBody;

    const translated: Metadata = { ...metadata };
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string") {
        translated[key] = answer.get(key.toUpperCase()) ?? value;
      } else if (Array.isArray(value)) {
        translated[key] = value.map(
          (item, i): YamlValue =>
            typeof item === "string"
              ? (answer.get(`${key.toUpperCase()} ${i + 1}`) ?? item)
              : item,
        );
      }
    }
    return renderFrontMatter(translated, translatedBody, {
      trimLeadingNewlines: true,
    });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const program = new Command("translate.ts")
    .description(
      "Translate text or Markdown files with Google's Antigravity CLI (agy).",
    )
    .argument("[text]", "Inline text to translate.")
    .option("--file <path>", "Input file path.", "")
    .option("--output <path>", "Write translated content to this path.", "")
    .option("--in-place", "Overwrite the input file.")
    .option("--source <lang>", "Source language. Default: auto.", "auto")
    .option("--target <lang>", "Target language. Default: English.", "English")
    .option(
      "--model <name>",
      `agy model. Default: ${DEFAULT_MODEL}.`,
      DEFAULT_MODEL,
    )
    .option("--markdown", "Force Markdown translation mode.")
    .option(
      "--front-matter-key <key>",
      "Front matter key to translate for Markdown files. Can be repeated.",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--no-front-matter",
      "Do not translate front matter values, only the Markdown body.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        '  node scripts/translate.ts "你好，世界" --target English\n' +
        "  node scripts/translate.ts --file article.md --target English --markdown --output article.en.md\n" +
        "  cat note.txt | node scripts/translate.ts --target zh-CN\n",
    )
    .parse();
  const opts = program.opts<{
    file: string;
    output: string;
    inPlace?: boolean;
    source: string;
    target: string;
    model: string;
    markdown?: boolean;
    frontMatterKey: string[];
    frontMatter: boolean;
  }>();
  const text = program.args[0];

  let rawInput: string;
  let inputPath: string | null = null;
  if (opts.file) {
    inputPath = path.resolve(opts.file);
    rawInput = readText(inputPath);
  } else if (text !== undefined) {
    rawInput = text;
  } else if (!process.stdin.isTTY) {
    rawInput = await readStdin();
  } else {
    throw new Error("Provide text, --file, or pipe content through stdin.");
  }
  if (opts.inPlace && inputPath === null)
    throw new Error("--in-place requires --file.");
  if (opts.inPlace && opts.output)
    throw new Error("--in-place cannot be combined with --output.");

  const markdownMode =
    Boolean(opts.markdown) ||
    (inputPath !== null &&
      MARKDOWN_SUFFIXES.has(path.extname(inputPath).toLowerCase()));
  const translator = new AgyTranslator(opts.model);
  let translated: string;
  if (markdownMode) {
    const frontMatterKeys = !opts.frontMatter
      ? []
      : opts.frontMatterKey.length > 0
        ? opts.frontMatterKey
        : DEFAULT_FRONT_MATTER_KEYS;
    translated = await translator.translateMarkdownDocument(rawInput, {
      sourceLang: opts.source,
      targetLang: opts.target,
      frontMatterKeys,
    });
  } else {
    translated = await translator.translateText(rawInput, {
      sourceLang: opts.source,
      targetLang: opts.target,
      markdown: false,
    });
  }

  if (opts.output) {
    const out = path.resolve(opts.output);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, translated, "utf8");
    console.log(out);
  } else if (opts.inPlace && inputPath !== null) {
    writeFileSync(inputPath, translated, "utf8");
    console.log(inputPath);
  } else {
    process.stdout.write(
      translated.endsWith("\n") ? translated : `${translated}\n`,
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    process.exit(1);
  });
}
