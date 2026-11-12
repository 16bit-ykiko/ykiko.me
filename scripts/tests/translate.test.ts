import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgyTranslator, parseAnswer } from "../translate.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Stands in for agy: checks it runs outside the repository with nothing but
// the article in its folder, records what it was given, and answers with
// "EN:" in front of every translated value and line.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const cwd = process.cwd();
const files = fs.readdirSync(cwd);
fs.appendFileSync(process.env.AGY_STUB_LOG, JSON.stringify({ args: args.filter((a) => a !== prompt), cwd, files, prompt }) + "\\n");
if (path.relative(process.env.AGY_STUB_REPO, cwd).split(path.sep)[0] !== "..") { console.error("inside the repository"); process.exit(3); }
const out = ["Thinking...", "Here is the translation:"];
for (const line of prompt.split("\\n")) {
  const m = /^(TITLE|DESCRIPTION|TAGS \\d+): (.*)$/.exec(line);
  if (m) out.push("@@@ BEGIN " + m[1] + " @@@", "EN: " + m[2], "@@@ END " + m[1] + " @@@");
}
if (files.includes("article.md")) {
  const body = fs.readFileSync(path.join(cwd, "article.md"), "utf8").trimEnd();
  out.push("@@@ BEGIN BODY @@@", ...body.split("\\n").map((l) => (l.trim() ? "EN: " + l : l)), "@@@ END BODY @@@");
}
out.push("Done.");
console.log(out.join("\\n"));
`;

let scratch: string;
let env: NodeJS.ProcessEnv;
let originalPath: string | undefined;

before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "agy-stub-"));
  mkdirSync(path.join(scratch, "bin"));
  writeFileSync(path.join(scratch, "bin", "agy"), STUB);
  chmodSync(path.join(scratch, "bin", "agy"), 0o755);
  originalPath = process.env["PATH"];
  env = {
    ...process.env,
    PATH: `${path.join(scratch, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
    AGY_STUB_LOG: path.join(scratch, "calls.jsonl"),
    AGY_STUB_REPO: REPO_ROOT,
  };
  Object.assign(process.env, {
    PATH: env["PATH"],
    AGY_STUB_LOG: env["AGY_STUB_LOG"],
    AGY_STUB_REPO: REPO_ROOT,
  });
});

after(() => {
  process.env["PATH"] = originalPath;
  rmSync(scratch, { recursive: true, force: true });
});

interface Call {
  args: string[];
  cwd: string;
  files: string[];
  prompt: string;
}

function calls(): Call[] {
  const log = path.join(scratch, "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Call);
}

test("one agy call translates the title and the body, outside the repository", async () => {
  rmSync(path.join(scratch, "calls.jsonl"), { force: true });
  const source =
    '---\ntitle: 标题\ntags:\n  - 甲\n  - 3\ndate: "2024-12-18 21:46:01"\n---\n\n第一段\n\n第二段\n';
  const translated = await new AgyTranslator().translateMarkdownDocument(
    source,
    {
      sourceLang: "zh-CN",
      targetLang: "English",
      frontMatterKeys: ["title", "tags"],
    },
  );
  assert.equal(
    translated,
    `---\ntitle: "EN: 标题"\ntags:\n  - 'EN: 甲'\n  - 3\ndate: "2024-12-18 21:46:01"\n---\n\nEN: 第一段\n\nEN: 第二段\n`,
  );
  const [call] = calls();
  assert.ok(call);
  assert.deepEqual(call.args, [
    "-p",
    "--model",
    "gemini-4-argon-high",
    "--print-timeout",
    "40m",
  ]);
  assert.deepEqual(call.files, ["article.md"]);
  assert.ok(!existsSync(call.cwd), "the scratch folder is removed afterwards");
  assert.match(call.prompt, /Translate the Markdown file article\.md/);
  assert.doesNotMatch(
    call.prompt,
    /第一段/,
    "the body is read from the file, not the prompt",
  );
});

test("an answer without its markers is an error", () => {
  assert.throws(
    () => parseAnswer("just text", ["BODY"]),
    /no @@@ BEGIN BODY @@@/,
  );
  assert.deepEqual(
    parseAnswer("noise\n@@@ BEGIN BODY @@@\na\n\nb\n@@@ END BODY @@@\nmore", [
      "BODY",
    ]),
    new Map([["BODY", "a\n\nb"]]),
  );
});

test("translate_articles writes en articles: title, /en/ links, New York dates, assets", () => {
  rmSync(path.join(scratch, "calls.jsonl"), { force: true });
  const zh = path.join(scratch, "zh");
  const en = path.join(scratch, "en");
  mkdirSync(path.join(zh, "111"), { recursive: true });
  mkdirSync(path.join(zh, "222"), { recursive: true });
  writeFileSync(
    path.join(zh, "111", "index.md"),
    '---\ntitle: 第一篇\ndate: "2024-12-18 21:46:01"\nupdated: "2026-03-29 15:08:54"\nzhihu_article_id: "111"\n---\n\n见 [第二篇](https://www.ykiko.me/zh-cn/articles/222) 和 [外部](https://ykiko.me/zh-cn/articles/999)。\n',
  );
  writeFileSync(path.join(zh, "111", "featured.png"), "png");
  writeFileSync(
    path.join(zh, "222", "index.md"),
    "---\ntitle: 第二篇\n---\n\n正文\n",
  );

  const run = (...args: string[]): string =>
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts", "translate_articles.ts"),
        "--all",
        "--source-root",
        zh,
        "--target-root",
        en,
        ...args,
      ],
      { env, encoding: "utf8" },
    );

  const dry = run("--dry-run");
  assert.match(dry, /\[dry-run\] upsert asset 111\/featured\.png/);
  assert.match(dry, /\[dry-run 1\/2\] translate 111\/index\.md/);
  assert.equal(calls().length, 0);
  assert.ok(!existsSync(en));

  const out = run();
  assert.match(out, /copied asset: 111\/featured\.png/);
  assert.match(
    out,
    /\[done 1\/2\] translated 111\/index\.md .* \(rewrote 1 links, /,
  );
  assert.equal(calls().length, 2);
  assert.equal(
    readFileSync(path.join(en, "111", "featured.png"), "utf8"),
    "png",
  );
  const first = readFileSync(path.join(en, "111", "index.md"), "utf8");
  assert.equal(
    first,
    '---\ntitle: "EN: 第一篇"\ndate: "2024-12-18 08:46:01"\nupdated: "2026-03-29 03:08:54"\nzhihu_article_id: "111"\n---\n\nEN: 见 [第二篇](https://www.ykiko.me/en/articles/222) 和 [外部](https://ykiko.me/zh-cn/articles/999)。\n',
  );
  assert.doesNotMatch(
    first + readFileSync(path.join(en, "222", "index.md"), "utf8"),
    /translated by AI/i,
  );
  assert.deepEqual(readdirSync(en).sort(), ["111", "222"]);
});
