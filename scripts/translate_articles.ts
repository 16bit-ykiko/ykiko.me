// Translates changed zh-cn articles into en articles with agy, by hand: no
// workflow runs it.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DATE_FORMAT, formatTimestamp, parseInZone } from "./dates.ts";
import { renderFrontMatter, splitFrontMatter } from "./front_matter.ts";
import {
  collectArticleIds,
  comparePaths,
  rewriteArticleLinks,
  walkFiles,
} from "./rewrite_en_article_links.ts";
import { EN_ARTICLES, REPO_ROOT, ZH_ARTICLES, isMain } from "./paths.ts";
import { readText, strip } from "./text.ts";
import { AgyTranslator, DEFAULT_MODEL } from "./translate.ts";

const TZ_SHANGHAI = "Asia/Shanghai";
const TZ_NEW_YORK = "America/New_York";
const DEFAULT_WORKERS = 1;
const ZERO_SHA = "0".repeat(40);

export function convertDatesToNewYork(markdownText: string): string {
  const { metadata, body, hasFrontMatter } = splitFrontMatter(markdownText);
  if (!hasFrontMatter) return markdownText;
  let changed = false;
  for (const key of ["date", "updated"]) {
    const value = metadata[key];
    if (typeof value !== "string" || !DATE_FORMAT.test(value)) continue;
    const instant = parseInZone(value, TZ_SHANGHAI);
    if (instant === null) continue;
    metadata[key] = formatTimestamp(instant, TZ_NEW_YORK);
    changed = true;
  }
  if (!changed) return markdownText;
  return renderFrontMatter(metadata, body, { trimLeadingNewlines: true });
}

export interface FileChange {
  action: "upsert" | "delete";
  relativePath: string;
}

const posix = (p: string): string => p.split(path.sep).join("/");

function runGitDiff(...args: string[]): string[] {
  const stdout = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  return stdout.split("\n").filter((line) => strip(line));
}

function normalizePath(pathText: string, sourceRoot: string): string | null {
  const rootRelative = posix(path.relative(REPO_ROOT, sourceRoot));
  const prefix = `${rootRelative}/`;
  if (!pathText.startsWith(prefix)) return null;
  return pathText.slice(prefix.length).split("/").join(path.sep);
}

export function parseNameStatus(
  lines: string[],
  sourceRoot: string,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of lines) {
    const fields = line.split("\t");
    const kind = fields[0]![0];
    if (kind === "R") {
      const oldPath = normalizePath(fields[1]!, sourceRoot);
      const newPath = normalizePath(fields[2]!, sourceRoot);
      if (oldPath !== null)
        changes.push({ action: "delete", relativePath: oldPath });
      if (newPath !== null)
        changes.push({ action: "upsert", relativePath: newPath });
      continue;
    }
    if (kind === "C") {
      const newPath = normalizePath(fields[2]!, sourceRoot);
      if (newPath !== null)
        changes.push({ action: "upsert", relativePath: newPath });
      continue;
    }
    const p = normalizePath(fields[1]!, sourceRoot);
    if (p === null) continue;
    changes.push({
      action: kind === "D" ? "delete" : "upsert",
      relativePath: p,
    });
  }
  return changes;
}

function collectChanges(sourceRoot: string, baseRef: string): FileChange[] {
  const all = new Map<string, FileChange>();
  const rootRelative = posix(path.relative(REPO_ROOT, sourceRoot));
  if (baseRef && baseRef !== ZERO_SHA) {
    for (const change of parseNameStatus(
      runGitDiff(`${baseRef}...HEAD`, "--", rootRelative),
      sourceRoot,
    )) {
      all.set(`${change.action}\0${posix(change.relativePath)}`, change);
    }
  }
  for (const change of parseNameStatus(
    runGitDiff("--", rootRelative),
    sourceRoot,
  )) {
    all.set(`${change.action}\0${posix(change.relativePath)}`, change);
  }
  return [...all.values()];
}

function collectAllChanges(sourceRoot: string): FileChange[] {
  return walkFiles(sourceRoot).map((file) => ({
    action: "upsert" as const,
    relativePath: path.relative(sourceRoot, file),
  }));
}

function pruneEmptyDirectories(dir: string, stopAt: string): void {
  let current = dir;
  while (
    current !== stopAt &&
    existsSync(current) &&
    statSync(current).isDirectory()
  ) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function syncAsset(
  change: FileChange,
  sourceRoot: string,
  targetRoot: string,
): void {
  const sourcePath = path.join(sourceRoot, change.relativePath);
  const targetPath = path.join(targetRoot, change.relativePath);
  if (change.action === "delete") {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
      pruneEmptyDirectories(path.dirname(targetPath), targetRoot);
    }
    return;
  }
  if (!existsSync(sourcePath)) return;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  const { atime, mtime } = statSync(sourcePath);
  utimesSync(targetPath, atime, mtime);
  console.log(`copied asset: ${posix(change.relativePath)}`);
}

async function translateMarkdownFiles(
  relativePaths: string[],
  sourceRoot: string,
  targetRoot: string,
  options: {
    sourceLang: string;
    targetLang: string;
    model: string;
    workers: number;
    dryRun: boolean;
  },
): Promise<void> {
  if (relativePaths.length === 0) return;
  const total = relativePaths.length;
  const sorted = [...relativePaths].sort(comparePaths);
  if (options.dryRun) {
    sorted.forEach((relativePath, i) => {
      const targetPath = path.join(targetRoot, relativePath);
      console.log(
        `[dry-run ${i + 1}/${total}] translate ${posix(relativePath)} -> ${posix(path.relative(REPO_ROOT, targetPath))}`,
      );
    });
    return;
  }

  const knownArticleIds = collectArticleIds(sourceRoot);
  const translator = new AgyTranslator(options.model);

  const translateOne = async (
    index: number,
    relativePath: string,
  ): Promise<string> => {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    const startedAt = performance.now();
    console.log(`[start ${index}/${total}] translating ${posix(relativePath)}`);
    let translated = await translator.translateMarkdownDocument(
      readText(sourcePath),
      {
        sourceLang: options.sourceLang,
        targetLang: options.targetLang,
      },
    );
    let rewrittenLinks = 0;
    if (strip(options.targetLang).toLowerCase().startsWith("english")) {
      [translated, rewrittenLinks] = rewriteArticleLinks(
        translated,
        knownArticleIds,
      );
      translated = convertDatesToNewYork(translated);
    }
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, translated, "utf8");
    const elapsed = (performance.now() - startedAt) / 1000;
    return (
      `[done ${index}/${total}] translated ${posix(relativePath)} -> ` +
      `${posix(path.relative(REPO_ROOT, targetPath))} ` +
      `(rewrote ${rewrittenLinks} links, ${elapsed.toFixed(1)}s)`
    );
  };

  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sorted.length) {
      const index = ++next;
      const relativePath = sorted[index - 1]!;
      try {
        console.log(await translateOne(index, relativePath));
      } catch (error) {
        const message = `[fail ${index}/${total}] ${posix(relativePath)}: ${error instanceof Error ? error.message : String(error)}`;
        failures.push(message);
        console.log(message);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, options.workers) }, worker),
  );
  if (failures.length > 0) {
    throw new Error(
      `One or more article translations failed:\n${failures.join("\n")}`,
    );
  }
}

function deleteMarkdownFiles(
  relativePaths: string[],
  targetRoot: string,
): void {
  for (const relativePath of [...relativePaths].sort(comparePaths)) {
    const targetPath = path.join(targetRoot, relativePath);
    if (!existsSync(targetPath)) continue;
    unlinkSync(targetPath);
    pruneEmptyDirectories(path.dirname(targetPath), targetRoot);
    console.log(`deleted translation: ${posix(relativePath)}`);
  }
}

async function main(): Promise<void> {
  const opts = new Command("translate_articles.ts")
    .description(
      "Incrementally translate changed zh-cn articles into en articles with agy.",
    )
    .option("--base-ref <ref>", "Git base ref for committed diffs.", "")
    .option(
      "--source-root <path>",
      "Source articles root. Default: website/content/zh-cn/articles",
      ZH_ARTICLES,
    )
    .option(
      "--target-root <path>",
      "Target articles root. Default: website/content/en/articles",
      EN_ARTICLES,
    )
    .option("--source-lang <lang>", "Source language.", "zh-CN")
    .option("--target-lang <lang>", "Target language.", "English")
    .option(
      "--model <name>",
      `agy model. Default: ${DEFAULT_MODEL}.`,
      DEFAULT_MODEL,
    )
    .option("--all", "Translate all source articles instead of using git diff.")
    .option(
      "--dry-run",
      "Print planned work without writing files or calling agy.",
    )
    .option(
      "--workers <n>",
      `Article translation concurrency. Default: ${DEFAULT_WORKERS}.`,
      (value: string) => {
        const n = Number(value);
        if (!Number.isInteger(n))
          throw new Error(`invalid int value: '${value}'`);
        return n;
      },
      DEFAULT_WORKERS,
    )
    .parse()
    .opts<{
      baseRef: string;
      sourceRoot: string;
      targetRoot: string;
      sourceLang: string;
      targetLang: string;
      model: string;
      all?: boolean;
      dryRun?: boolean;
      workers: number;
    }>();

  const sourceRoot = path.resolve(opts.sourceRoot);
  const targetRoot = path.resolve(opts.targetRoot);
  const changes = opts.all
    ? collectAllChanges(sourceRoot)
    : collectChanges(sourceRoot, strip(opts.baseRef));
  if (changes.length === 0) {
    console.log("No article changes to translate.");
    return;
  }

  const toTranslate = new Set<string>();
  const toDelete = new Set<string>();
  for (const change of changes) {
    if (path.basename(change.relativePath) === "index.md") {
      (change.action === "delete" ? toDelete : toTranslate).add(
        change.relativePath,
      );
      continue;
    }
    if (opts.dryRun) {
      console.log(
        `[dry-run] ${change.action} asset ${posix(change.relativePath)}`,
      );
      continue;
    }
    syncAsset(change, sourceRoot, targetRoot);
  }

  deleteMarkdownFiles([...toDelete], targetRoot);
  await translateMarkdownFiles([...toTranslate], sourceRoot, targetRoot, {
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
    model: opts.model,
    workers: opts.workers,
    dryRun: Boolean(opts.dryRun),
  });
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
