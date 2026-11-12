// Round-trip consistency check for all Zhihu articles. Per article: local
// markdown → HTML → PATCH draft → preview HTML → parser → markdown, diffed
// against the local file. Writes to the drafts on Zhihu.
//
//   node scripts/zhihu_roundtrip_check.ts [--delay SECONDS] [--article-id ID]
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { metadataString, readMarkdownDocument } from "./front_matter.ts";
import { truthy } from "./json.ts";
import { markdownToHtml } from "./markdown_html.ts";
import {
  BOLD,
  GREEN,
  RED,
  RESET,
  YELLOW,
  colourDiff,
  normalise,
  normaliseImageUrls,
  pushAndParsePreview,
} from "./roundtrip.ts";
import { strip } from "./text.ts";
import { unifiedDiff } from "./unified_diff.ts";
import { ZH_ARTICLES } from "./paths.ts";
import { ZhihuClient } from "./zhihu_client.ts";

interface Result {
  articleId: string;
  title: string;
  diff: string[];
}

// Differences that carry no meaning: Zhihu serves http links, rewrites image
// URLs, drops <code> in links and headings, and writes * emphasis; the local
// file may keep escapes, angle-bracket URLs and spaces the parser drops.
function applyNorms(lines: string[]): string[] {
  return lines.map((l) => {
    l = l.replaceAll("https://", "http://");
    l = normaliseImageUrls(l, "r|720w|1440w|b");
    l = l.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");
    l = l.replace(/`([^`]+?) +`/g, "`$1`");
    l = l.replace(/\(<(https?:\/\/[^>]+)>\)/g, "($1)");
    l = l.replace(/\[(http[^\]]+)\]\(\1\)/g, "$1");
    l = l.replace(/\[([^\]]+?) +\]/g, "[$1]");
    l = l.replace(/\\([_*[\]()~`>#+\-.!|{}])/g, "$1");
    l = l.replace(/\[`([^`]+)`\]/g, "[$1]");
    l = l.replace(/^(#{1,6}) `(.+)`$/, "$1 $2");
    return l;
  });
}

async function checkArticle(
  client: ZhihuClient,
  articleId: string,
  mdPath: string,
  delay: number,
): Promise<Result> {
  const [metadata, bodyMarkdown] = readMarkdownDocument(mdPath);
  const title = truthy(metadata["title"])
    ? String(metadata["title"])
    : path.basename(mdPath, ".md");
  const titleImage = truthy(metadata["zhihu_title_image_url"])
    ? metadata["zhihu_title_image_url"]
    : (metadata["title_image_url"] ?? null);
  const roundTrip = await pushAndParsePreview(
    client,
    articleId,
    { content: markdownToHtml(bodyMarkdown), title, titleImage },
    delay,
  );
  const diff = unifiedDiff(
    applyNorms(normalise(bodyMarkdown)),
    applyNorms(normalise(roundTrip)),
    "local",
    "round-trip",
    2,
  );
  return { articleId, title, diff };
}

const CATEGORIES: [string, RegExp][] = [
  ["linkcard", /linkcard|{{</],
  ["image", /!\[/],
  ["code_block", /^[+-]```/],
  ["heading", /^[+-]#{1,6} /],
  ["list_item", /^[+-]\s*[-*\d]/],
  ["bold_italic", /\*\*|__|\*[^*]|_[^_]/],
];

function categorise(diff: string[]): Set<string> {
  const cats = new Set<string>();
  for (const line of diff) {
    if (
      !(line.startsWith("+") || line.startsWith("-")) ||
      line.startsWith("+++") ||
      line.startsWith("---")
    ) {
      continue;
    }
    for (const [name, pattern] of CATEGORIES)
      if (pattern.test(line)) cats.add(name);
  }
  return cats;
}

function report(results: Result[]): void {
  const identical = results.filter((r) => r.diff.length === 0);
  const different = results.filter((r) => r.diff.length > 0);
  console.log(`\n${BOLD}=== Round-trip consistency check ===${RESET}`);
  console.log(
    `Total: ${results.length}  Identical: ${identical.length}  Different: ${different.length}\n`,
  );
  if (identical.length > 0) {
    console.log(`${GREEN}✓ Identical (${identical.length})${RESET}`);
    for (const r of identical)
      console.log(
        `  ${r.articleId}  ${Array.from(r.title).slice(0, 60).join("")}`,
      );
  }
  if (different.length > 0) {
    console.log(`\n${RED}✗ Different (${different.length})${RESET}`);
    for (const r of different) {
      const cats = [...categorise(r.diff)].sort();
      const added = r.diff.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      ).length;
      const removed = r.diff.filter(
        (l) => l.startsWith("-") && !l.startsWith("---"),
      ).length;
      console.log(
        `\n${BOLD}${r.articleId}  ${Array.from(r.title).slice(0, 60).join("")}${RESET}` +
          `  [${cats.length > 0 ? cats.join(", ") : "other"}]  +${added}/-${removed} lines`,
      );
      console.log(colourDiff(r.diff.slice(0, 80)));
      if (r.diff.length > 80)
        console.log(
          `  ${YELLOW}... ${r.diff.length - 80} more lines truncated${RESET}`,
        );
    }
  }
}

async function main(): Promise<void> {
  const opts = new Command("zhihu_roundtrip_check.ts")
    .description(
      "Round-trip consistency check for all Zhihu articles (writes to their drafts).",
    )
    .option(
      "--delay <seconds>",
      "Seconds between requests (default 1.5)",
      Number,
      1.5,
    )
    .option("--article-id <id>", "Check only this article id", "")
    .parse()
    .opts<{ delay: number; articleId: string }>();

  const client = await ZhihuClient.fromEnvOrCache({ allowLogin: false });

  let candidates: [string, string][];
  if (opts.articleId) {
    const mdPath = path.join(ZH_ARTICLES, opts.articleId, "index.md");
    if (!existsSync(mdPath)) {
      console.error(`Not found: ${mdPath}`);
      process.exit(1);
    }
    candidates = [[opts.articleId, mdPath]];
  } else {
    candidates = [];
    for (const name of readdirSync(ZH_ARTICLES).sort()) {
      const dir = path.join(ZH_ARTICLES, name);
      if (!statSync(dir).isDirectory()) continue;
      const md = path.join(dir, "index.md");
      if (!existsSync(md)) continue;
      const [meta] = readMarkdownDocument(md);
      candidates.push([
        strip(metadataString(meta, "zhihu_article_id")) || name,
        md,
      ]);
    }
  }

  const results: Result[] = [];
  for (const [i, [articleId, mdPath]] of candidates.entries()) {
    process.stdout.write(
      `[${i + 1}/${candidates.length}] Checking ${articleId} ... `,
    );
    try {
      const result = await checkArticle(client, articleId, mdPath, opts.delay);
      console.log(
        result.diff.length === 0 ? "OK" : `${result.diff.length} diff lines`,
      );
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`ERROR: ${message}`);
      results.push({
        articleId,
        title: path.basename(path.dirname(mdPath)),
        diff: [`ERROR: ${message}`],
      });
    }
  }
  report(results);
}

await main();
