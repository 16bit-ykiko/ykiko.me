// Chinese Markdown formatter / linter (FORMAT_SPEC.md).
//
//   node scripts/md_format.ts [--fix] [files ...]
//   node scripts/md_format.ts [--fix]          # all zh-cn articles
//
// Without --fix it reports violations and exits 1 if there are any; with
// --fix it fixes the safe ones in place and reports the lint-only ones.
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ZH_ARTICLES, isMain } from "./paths.ts";
import {
  NON_WS_CLASS,
  WS_CLASS,
  escapeRegExp,
  lstrip,
  readText,
  rstrip,
  rstripChars,
  splitlines,
  strip,
} from "./text.ts";

// CJK ideographs and kana only: CJK punctuation (。，！？) takes no spacing.
const CJK_RANGE =
  "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RE = new RegExp(`[${CJK_RANGE}]`, "u");

// An ASCII term such as C++17, C#, x86-64, Node.js, ARMv8, Python3.12.
const ASCII_ATOM = /[A-Za-z0-9]+(?:[+\-#.][A-Za-z0-9]+)*[+#]*/g;

const NOUN_MAP: [string, string][] = [
  ["gcc", "GCC"],
  ["Gcc", "GCC"],
  ["clang", "Clang"],
  ["CLANG", "Clang"],
  ["msvc", "MSVC"],
  ["Msvc", "MSVC"],
  ["llvm", "LLVM"],
  ["Llvm", "LLVM"],
  ["cmake", "CMake"],
  ["Cmake", "CMake"],
  ["CMAKE", "CMake"],
  ["python", "Python"],
  ["PYTHON", "Python"],
  ["rust", "Rust"],
  ["RUST", "Rust"],
  ["c++", "C++"],
  ["CPP", "C++"],
  ["cpp", "C++"],
  ["cpu", "CPU"],
  ["Cpu", "CPU"],
  ["gpu", "GPU"],
  ["Gpu", "GPU"],
  ["abi", "ABI"],
  ["Abi", "ABI"],
  ["api", "API"],
  ["Api", "API"],
  ["elf", "ELF"],
  ["Elf", "ELF"],
  ["posix", "POSIX"],
  ["Posix", "POSIX"],
  ["github", "GitHub"],
  ["Github", "GitHub"],
  ["GITHUB", "GitHub"],
  ["linux", "Linux"],
  ["LINUX", "Linux"],
  ["windows", "Windows"],
  ["WINDOWS", "Windows"],
  ["macos", "macOS"],
  ["MacOS", "macOS"],
  ["MACOS", "macOS"],
  ["X86", "x86"],
  ["X86-64", "x86-64"],
  ["arm", "ARM"],
  ["Arm", "ARM"],
  ["vscode", "VSCode"],
  ["VSCODE", "VSCode"],
  ["docker", "Docker"],
  ["DOCKER", "Docker"],
  // Command names are wrapped in inline code rather than capitalised.
  ["clang++", "`clang++`"],
  ["g++", "`g++`"],
];

const NOUN_PATTERNS = [...NOUN_MAP]
  .sort((a, b) => b[0].length - a[0].length)
  .map(
    ([wrong, correct]) =>
      [
        wrong,
        correct,
        new RegExp(
          `(?<![A-Za-z0-9+#])${escapeRegExp(wrong)}(?![A-Za-z0-9+#])`,
          "g",
        ),
      ] as const,
  );

const TYPO_MAP: [string, string][] = [
  ["登陆", "登录"],
  ["帐号", "账号"],
  ["联接", "连接"],
  ["其它", "其他"],
  ["粘帖", "粘贴"],
  ["搜寻", "搜索"],
];

const FW_DIGIT_START = 0xff10;
const FW_UPPER_START = 0xff21;
const FW_LOWER_START = 0xff41;

type SpanKind = "text" | "code" | "link" | "image" | "md_syntax";

interface Span {
  kind: SpanKind;
  text: string;
  inner: string;
}

const span = (kind: SpanKind, text: string, inner = ""): Span => ({
  kind,
  text,
  inner,
});

const INLINE_RE = new RegExp(
  "(`+)(.+?)\\1" +
    "|!\\[([^\\]]*)\\]\\(([^)]*)\\)" +
    "|\\[([^\\]]*)\\]\\(([^)]*)\\)" +
    "|(\\*{1,3}|_{1,3})" +
    `|(\\\\${NON_WS_CLASS})`,
  "gsu",
);

export function tokenise(line: string): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    if (m.index > pos) spans.push(span("text", line.slice(pos, m.index)));
    if (m[1]) spans.push(span("code", m[0], m[2]));
    else if (m[3] !== undefined) spans.push(span("image", m[0], m[3]));
    else if (m[5] !== undefined) spans.push(span("link", m[0], m[5]));
    else if (m[7]) spans.push(span("md_syntax", m[0]));
    else if (m[8]) spans.push(span("text", m[0]));
    pos = m.index + m[0].length;
  }
  if (pos < line.length) spans.push(span("text", line.slice(pos)));
  return spans;
}

export interface Issue {
  lineNo: number;
  rule: string;
  message: string;
  fixable: boolean;
}

const issue = (
  lineNo: number,
  rule: string,
  message: string,
  fixable = true,
): Issue => ({
  lineNo,
  rule,
  message,
  fixable,
});

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch.charAt(0) === ch ? ch : (Array.from(ch)[0] ?? ""));
}

function isAsciiAlnum(ch: string): boolean {
  return /^[A-Za-z0-9]$/.test(ch);
}

function lastCodePoint(text: string): string {
  const chars = Array.from(text);
  return chars[chars.length - 1] ?? "";
}

function firstCodePoint(text: string): string {
  return Array.from(text)[0] ?? "";
}

function fixFullwidth(line: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  let out = "";
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    if (cp >= FW_DIGIT_START && cp <= FW_DIGIT_START + 9) {
      out += String.fromCodePoint(cp - FW_DIGIT_START + 0x30);
      issues.push(issue(lno, "fullwidth", `全角字符「${ch}」→半角`));
    } else if (cp >= FW_UPPER_START && cp <= FW_UPPER_START + 25) {
      out += String.fromCodePoint(cp - FW_UPPER_START + 0x41);
      issues.push(issue(lno, "fullwidth", `全角字符「${ch}」→半角`));
    } else if (cp >= FW_LOWER_START && cp <= FW_LOWER_START + 25) {
      out += String.fromCodePoint(cp - FW_LOWER_START + 0x61);
      issues.push(issue(lno, "fullwidth", `全角字符「${ch}」→半角`));
    } else {
      out += ch;
    }
  }
  return [out, issues];
}

// Spaces at CJK/ASCII boundaries inside a plain-text segment; code and URLs
// never reach it.
function fixSpacingText(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  if (!text) return [text, issues];
  const atoms: string[] = [];
  let pos = 0;
  for (const m of text.matchAll(ASCII_ATOM)) {
    if (m.index > pos) atoms.push(...Array.from(text.slice(pos, m.index)));
    atoms.push(m[0]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) atoms.push(...Array.from(text.slice(pos)));

  const out: string[] = [];
  atoms.forEach((tok, i) => {
    if (i > 0) {
      const prevLast = lastCodePoint(atoms[i - 1]!);
      const curFirst = firstCodePoint(tok);
      const needSpace =
        (isCjk(prevLast) && isAsciiAlnum(curFirst)) ||
        (isAsciiAlnum(prevLast) && isCjk(curFirst));
      if (needSpace && out.length > 0 && out[out.length - 1] !== " ") {
        issues.push(
          issue(
            lno,
            "spacing",
            `缺少空格：「${prevLast}${curFirst}」→「${prevLast} ${curFirst}」`,
          ),
        );
        out.push(" ");
      }
    }
    out.push(tok);
  });
  return [out.join(""), issues];
}

// Spaces where a text span meets code, a link or an image; only the
// outermost character of each span is looked at.
function fixSpacingBoundary(spans: Span[], lno: number): [Span[], Issue[]] {
  const issues: Issue[] = [];
  const lastNonspace = (s: Span): string => lastCodePoint(rstrip(s.text));
  const firstNonspace = (s: Span): string => firstCodePoint(lstrip(s.text));
  const result: Span[] = [];
  spans.forEach((cur, i) => {
    if (i > 0 && result.length > 0) {
      const prev = result[result.length - 1]!;
      if (
        prev.kind === "text" &&
        ["code", "link", "image"].includes(cur.kind)
      ) {
        const lc = lastNonspace(prev);
        if (lc && isCjk(lc) && !prev.text.endsWith(" ")) {
          issues.push(
            issue(lno, "spacing", `「${lc}」与 ${cur.kind} 之间缺少空格`),
          );
          result.push(span("text", " "));
        }
      } else if (
        ["code", "link", "image"].includes(prev.kind) &&
        cur.kind === "text"
      ) {
        const fc = firstNonspace(cur);
        if (fc && isCjk(fc) && !cur.text.startsWith(" ")) {
          issues.push(
            issue(lno, "spacing", `${prev.kind} 与「${fc}」之间缺少空格`),
          );
          result.push(span("text", " "));
        }
      }
    }
    result.push(cur);
  });
  return [result, issues];
}

function fixNouns(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  for (const [wrong, correct, pattern] of NOUN_PATTERNS) {
    text = text.replace(pattern, () => {
      issues.push(issue(lno, "noun", `「${wrong}」→「${correct}」`));
      return correct;
    });
  }
  return [text, issues];
}

function fixTypos(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  for (const [wrong, correct] of TYPO_MAP) {
    if (text.includes(wrong)) {
      const count = text.split(wrong).length - 1;
      text = text.replaceAll(wrong, correct);
      for (let i = 0; i < count; i++)
        issues.push(issue(lno, "typo", `「${wrong}」→「${correct}」`));
    }
  }
  return [text, issues];
}

// ... becomes …… and -- becomes —— next to CJK, spaces in between allowed.
function fixEllipsisDash(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  const cjkAround = (source: string, start: number, end: number): boolean => {
    const before = rstrip(source.slice(0, start));
    const after = lstrip(source.slice(end));
    return (
      (before !== "" && isCjk(lastCodePoint(before))) ||
      (after !== "" && isCjk(firstCodePoint(after)))
    );
  };
  const original = text;
  text = original.replace(/\.{3,}/g, (m: string, offset: number) => {
    if (cjkAround(original, offset, offset + m.length)) {
      issues.push(issue(lno, "punct", "「...」→「……」"));
      return "……";
    }
    return m;
  });
  const afterEllipsis = text;
  text = afterEllipsis.replace(/--(?!-)/g, (m: string, offset: number) => {
    if (cjkAround(afterEllipsis, offset, offset + m.length)) {
      issues.push(issue(lno, "punct", "「--」→「——」"));
      return "——";
    }
    return m;
  });
  return [text, issues];
}

// Repeated stop and pause marks collapse; tone marks (！？), : and ; (C++ ::)
// and . (handled as an ellipsis) are left alone.
function fixDupPunct(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  text = text.replace(/([，。,])\1+/g, (m: string, first: string) => {
    issues.push(issue(lno, "punct", `重复标点「${m}」→「${first}」`));
    return first;
  });
  return [text, issues];
}

// A space between a number and its unit (8GB → 8 GB), for units of two or
// more letters or one of B, K, M, G, T ("2w" and "3d" are words); none
// before % and °.
const UNIT_RE = /(\p{Nd})([A-Za-z]{2,}|[BKMGT])(?![+\-#.A-Za-z])/gu;
const PCT_RE = new RegExp(`(${WS_CLASS}?)([%°])`, "gu");

function fixNumberUnit(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  text = text.replace(UNIT_RE, (m: string, digit: string, unit: string) => {
    issues.push(issue(lno, "spacing", `「${m}」→「${digit} ${unit}」`));
    return `${digit} ${unit}`;
  });
  text = text.replace(PCT_RE, (m: string, space: string, sign: string) => {
    if (space)
      issues.push(issue(lno, "spacing", `「${strip(m)}」前不应有空格`));
    return sign;
  });
  return [text, issues];
}

function fixQuotes(text: string, lno: number): [string, Issue[]] {
  const issues: Issue[] = [];
  if (!CJK_RE.test(text)) return [text, issues];
  text = text.replace(/“([^”]*)”/g, (_m, inner: string) => {
    issues.push(issue(lno, "quote", "「」替换弯引号"));
    return `「${inner}」`;
  });
  text = text.replace(/‘([^’]*)’/g, (_m, inner: string) => {
    issues.push(issue(lno, "quote", "『』替换弯引号"));
    return `『${inner}』`;
  });
  return [text, issues];
}

const PUNCT_ASCII_RE = new RegExp(
  `([A-Za-z\`])[,\\.!?:;](${WS_CLASS}|$)`,
  "gu",
);

function lintPunctAscii(text: string, lno: number): Issue[] {
  const issues: Issue[] = [];
  if (!CJK_RE.test(text)) return issues;
  for (const m of text.matchAll(PUNCT_ASCII_RE)) {
    if (!lstrip(text.slice(0, m.index))) continue;
    issues.push(
      issue(lno, "punct", `中文语境下「${strip(m[0])}」后应用中文标点`, false),
    );
  }
  return issues;
}

const HEADING_RE = new RegExp(`^(#{1,6})(${WS_CLASS}*)([^\\n]*)`, "u");

function fixHeadingSpace(line: string, lno: number): [string, Issue[]] {
  const m = HEADING_RE.exec(line);
  if (!m) return [line, []];
  const [, hashes, spaces, rest] = m as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (spaces !== " ") {
    return [
      hashes + " " + rest,
      [issue(lno, "structure", "标题「#」后应有且仅有一个空格")],
    ];
  }
  return [line, []];
}

const LIST_SPACE_RE = new RegExp(
  `^(${WS_CLASS}*)([-*+]|(\\p{Nd}+)\\.)(${NON_WS_CLASS})`,
  "u",
);

function fixListSpace(line: string, lno: number): [string, Issue[]] {
  const m = LIST_SPACE_RE.exec(line);
  if (!m) return [line, []];
  const start4 = m[0].length - m[4]!.length;
  return [
    line.slice(0, start4) + " " + line.slice(start4),
    [issue(lno, "structure", "列表标记符后缺少空格")],
  ];
}

function lintCodeBlockLang(fence: string, lno: number): Issue[] {
  if (new RegExp(`^(\`{3,}|~{3,})${WS_CLASS}*$`, "u").test(fence)) {
    return [
      issue(lno, "code_block", "代码块未声明语言（如 ```python）", false),
    ];
  }
  return [];
}

export interface FileResult {
  path: string;
  issues: Issue[];
  fixedLines: string[] | null;
}

const FENCE_RE = /^(`{3,}|~{3,})/;
const HEADING_A = new RegExp(`^#{1,6}${WS_CLASS}`, "u");
const HEADING_B = new RegExp(`^#{1,6}[^${WS_CLASS.slice(1, -1)}#]`, "u");
const LIST_A = new RegExp(`^${WS_CLASS}*[-+]${NON_WS_CLASS}`, "u");
const LIST_B = new RegExp(`^${WS_CLASS}*\\*(?!\\*)${NON_WS_CLASS}`, "u");
const LIST_C = new RegExp(`^${WS_CLASS}*\\p{Nd}+\\.${NON_WS_CLASS}`, "u");

export function processText(
  filePath: string,
  source: string,
  fix: boolean,
): FileResult {
  const lines = splitlines(source, true);
  const result: FileResult = { path: filePath, issues: [], fixedLines: null };
  const outLines: string[] = [];
  let inFrontmatter = false;
  let inCodeBlock = false;
  let codeFence = "";

  lines.forEach((rawLine, i) => {
    const lno = i + 1;
    let line = rstripChars(rstripChars(rawLine, "\n"), "\r");
    const suffix = rawLine.slice(line.length);

    if (lno === 1 && strip(line) === "---") {
      inFrontmatter = true;
      outLines.push(rawLine);
      return;
    }
    if (inFrontmatter) {
      if (strip(line) === "---") inFrontmatter = false;
      outLines.push(rawLine);
      return;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fence[1]!;
        result.issues.push(...lintCodeBlockLang(line, lno));
      } else if (line.startsWith(codeFence)) {
        inCodeBlock = false;
        codeFence = "";
      }
      outLines.push(rawLine);
      return;
    }
    if (inCodeBlock) {
      outLines.push(rawLine);
      return;
    }

    let iss: Issue[];
    if (HEADING_A.test(line) || HEADING_B.test(line)) {
      [line, iss] = fixHeadingSpace(line, lno);
      result.issues.push(...iss);
    }
    if (LIST_A.test(line) || LIST_B.test(line) || LIST_C.test(line)) {
      [line, iss] = fixListSpace(line, lno);
      result.issues.push(...iss);
    }
    [line, iss] = fixFullwidth(line, lno);
    result.issues.push(...iss);

    let spans = tokenise(line);
    [spans, iss] = fixSpacingBoundary(spans, lno);
    result.issues.push(...iss);

    const newSpans: Span[] = [];
    for (const s of spans) {
      if (s.kind === "text") {
        let t = s.text;
        for (const fixer of [
          fixSpacingText,
          fixNouns,
          fixTypos,
          fixEllipsisDash,
          fixDupPunct,
          fixNumberUnit,
          fixQuotes,
        ]) {
          [t, iss] = fixer(t, lno);
          result.issues.push(...iss);
        }
        result.issues.push(...lintPunctAscii(t, lno));
        newSpans.push(span("text", t));
      } else if (s.kind === "link" || s.kind === "image") {
        let inner = s.inner;
        if (!inner.startsWith("http://") && !inner.startsWith("https://")) {
          [inner, iss] = fixSpacingText(inner, lno);
          result.issues.push(...iss);
          [inner, iss] = fixNouns(inner, lno);
          result.issues.push(...iss);
        }
        const opener = s.kind === "link" ? /^\[([^\]]*)\]/ : /^!\[([^\]]*)\]/;
        const prefix = s.kind === "link" ? "[" : "![";
        newSpans.push(
          span(
            s.kind,
            s.text.replace(opener, () => `${prefix}${inner}]`),
            inner,
          ),
        );
      } else {
        newSpans.push(s);
      }
    }
    line = newSpans.map((s) => s.text).join("");
    outLines.push(line + suffix);
  });

  if (outLines.length > 0 && !outLines[outLines.length - 1]!.endsWith("\n")) {
    result.issues.push(issue(lines.length, "structure", "文件末尾缺少换行符"));
    outLines[outLines.length - 1] += "\n";
  }

  const compressed: string[] = [];
  let blankCount = 0;
  for (const raw of outLines) {
    if (strip(raw) === "") {
      blankCount++;
      if (blankCount > 1) {
        result.issues.push(issue(0, "structure", "连续空行已压缩"));
        continue;
      }
    } else {
      blankCount = 0;
    }
    compressed.push(raw);
  }
  if (fix) result.fixedLines = compressed;
  return result;
}

export function processFile(filePath: string, fix: boolean): FileResult {
  return processText(filePath, readText(filePath), fix);
}

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

export function report(results: FileResult[], fix: boolean): void {
  const totalIssues = results.reduce((n, r) => n + r.issues.length, 0);
  const fixable = results.reduce(
    (n, r) => n + r.issues.filter((i) => i.fixable).length,
    0,
  );
  const lintOnly = totalIssues - fixable;
  console.log(`\n${BOLD}=== md_format ===${RESET}`);
  console.log(
    `Mode: ${fix ? "fix" : "lint"}  Files: ${results.length}  Issues: ${totalIssues}  ` +
      `(auto-fixed: ${fix ? fixable : 0}  lint-only: ${lintOnly})\n`,
  );
  for (const r of results) {
    if (r.issues.length === 0) {
      console.log(`${GREEN}✓${RESET} ${r.path}`);
      continue;
    }
    const fixableCount = r.issues.filter((i) => i.fixable).length;
    console.log(
      `${RED}✗${RESET} ${r.path}  (${fixableCount} fixable, ${r.issues.length - fixableCount} lint-only)`,
    );
    for (const i of r.issues) {
      const color = !i.fixable ? YELLOW : fix ? GREEN : RED;
      const ln = i.lineNo ? `:${i.lineNo}` : "";
      console.log(`  ${color}[${i.rule}]${RESET}${ln} ${i.message}`);
    }
  }
}

function articlePaths(): string[] {
  if (!existsSync(ZH_ARTICLES)) return [];
  return readdirSync(ZH_ARTICLES)
    .map((name) => path.join(ZH_ARTICLES, name, "index.md"))
    .filter((p) => existsSync(p))
    .sort();
}

function main(): void {
  const program = new Command("md_format.ts")
    .description("Chinese Markdown formatter / linter.")
    .option("--fix", "Auto-fix safe violations in-place")
    .argument(
      "[files...]",
      "Markdown files to check (default: all zh-cn articles)",
    )
    .parse();
  const fix = Boolean(program.opts<{ fix?: boolean }>().fix);
  const files = program.args;
  const paths = files.length > 0 ? files : articlePaths();
  if (paths.length === 0) {
    console.error("No files found.");
    process.exit(1);
  }
  const results: FileResult[] = [];
  for (const p of paths) {
    const result = processFile(p, fix);
    results.push(result);
    if (fix && result.fixedLines !== null)
      writeFileSync(p, result.fixedLines.join(""), "utf8");
  }
  report(results, fix);
  const lintOnlyIssues = results.reduce(
    (n, r) => n + r.issues.filter((i) => !i.fixable).length,
    0,
  );
  if (lintOnlyIssues > 0 || (!fix && results.some((r) => r.issues.length > 0)))
    process.exit(1);
}

if (isMain(import.meta.url)) main();
