import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { EN_ARTICLES, REPO_ROOT, ZH_ARTICLES, isMain } from "./paths.ts";
import { WS_CLASS, readText } from "./text.ts";

const ARTICLE_LINK_PATTERN = new RegExp(
  `(https://www\\.ykiko\\.me|https://ykiko\\.me|)/zh-cn/articles/(\\p{Nd}+)(/?(?:[?#][^${WS_CLASS.slice(1, -1)})"'>]*)?)`,
  "gu",
);

export function collectArticleIds(root: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(root)) return ids;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (statSync(dir).isDirectory() && existsSync(path.join(dir, "index.md")))
      ids.add(name);
  }
  return ids;
}

export function rewriteArticleLinks(
  text: string,
  articleIds: Set<string>,
): [string, number] {
  let replacements = 0;
  const rewritten = text.replace(
    ARTICLE_LINK_PATTERN,
    (match: string, prefix: string, articleId: string, suffix: string) => {
      if (!articleIds.has(articleId)) return match;
      replacements++;
      return `${prefix}/en/articles/${articleId}${suffix}`;
    },
  );
  return [rewritten, replacements];
}

function rewriteFile(file: string, articleIds: Set<string>): number {
  const [rewritten, replacements] = rewriteArticleLinks(
    readText(file),
    articleIds,
  );
  if (replacements) writeFileSync(file, rewritten, "utf8");
  return replacements;
}

// Path order compares component by component.
export function comparePaths(a: string, b: string): number {
  const pa = a.split(path.sep);
  const pb = b.split(path.sep);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return pa.length - pb.length;
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return files.sort(comparePaths);
}

function main(): void {
  const opts = new Command("rewrite_en_article_links.ts")
    .description(
      "Rewrite internal zh-cn article links in English articles to en links.",
    )
    .option(
      "--en-root <path>",
      "English articles root. Default: website/content/en/articles",
      EN_ARTICLES,
    )
    .option(
      "--zh-root <path>",
      "Chinese articles root used to determine known article ids.",
      ZH_ARTICLES,
    )
    .parse()
    .opts<{ enRoot: string; zhRoot: string }>();
  const enRoot = path.resolve(opts.enRoot);
  const articleIds = collectArticleIds(path.resolve(opts.zhRoot));
  let updatedFiles = 0;
  let updatedLinks = 0;
  for (const file of walkFiles(enRoot).filter(
    (f) => path.basename(f) === "index.md",
  )) {
    const replacements = rewriteFile(file, articleIds);
    if (replacements) {
      updatedFiles++;
      updatedLinks += replacements;
      console.log(
        `rewrote ${replacements} links in ${path.relative(REPO_ROOT, file).split(path.sep).join("/")}`,
      );
    }
  }
  console.log(`updated ${updatedLinks} links across ${updatedFiles} files`);
}

if (isMain(import.meta.url)) main();
