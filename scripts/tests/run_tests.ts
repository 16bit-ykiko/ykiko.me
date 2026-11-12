// Zhihu markdown feature tests: pushes each tests/data/*.md as the draft of
// a target article, reads the preview back through the parser and diffs it
// against the original. Writes to Zhihu; never run in CI.
//
//   node scripts/tests/run_tests.ts --article-id <ID> [--delay SECONDS] [--test NAME]
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { markdownToHtml } from "../markdown_html.ts";
import {
  BOLD,
  GREEN,
  RED,
  RESET,
  colourDiff,
  normalise,
  normaliseImageUrls,
  pushAndParsePreview,
} from "../roundtrip.ts";
import { readText } from "../text.ts";
import { unifiedDiff } from "../unified_diff.ts";
import { ZhihuClient } from "../zhihu_client.ts";

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data",
);

interface Result {
  name: string;
  diff: string[];
}

function norm(lines: string[]): string[] {
  return lines.map((l) =>
    normaliseImageUrls(l.replaceAll("https://", "http://"), "r|720w|1440w"),
  );
}

async function runTest(
  client: ZhihuClient,
  articleId: string,
  mdPath: string,
  delay: number,
): Promise<Result> {
  const name = path.basename(mdPath, ".md");
  const body = readText(mdPath);
  const roundTrip = await pushAndParsePreview(
    client,
    articleId,
    { content: markdownToHtml(body), title: `[test] ${name}`, titleImage: "" },
    delay,
  );
  const diff = unifiedDiff(
    norm(normalise(body)),
    norm(normalise(roundTrip)),
    "local",
    "round-trip",
    2,
  );
  return { name, diff };
}

function report(results: Result[]): void {
  const passed = results.filter((r) => r.diff.length === 0);
  const failed = results.filter((r) => r.diff.length > 0);
  console.log(`\n${BOLD}=== Zhihu feature tests ===${RESET}`);
  console.log(
    `Passed: ${passed.length}  Failed: ${failed.length}  Total: ${results.length}\n`,
  );
  for (const r of passed) console.log(`${GREEN}✓ ${r.name}${RESET}`);
  for (const r of failed) {
    const added = r.diff.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++"),
    ).length;
    const removed = r.diff.filter(
      (l) => l.startsWith("-") && !l.startsWith("---"),
    ).length;
    console.log(`\n${RED}✗ ${r.name}${RESET}  +${added}/-${removed} lines`);
    console.log(colourDiff(r.diff));
  }
  if (failed.length > 0) process.exit(1);
}

async function main(): Promise<void> {
  const opts = new Command("run_tests.ts")
    .description(
      "Zhihu markdown feature tests (round trip through a draft of the given article).",
    )
    .requiredOption(
      "--article-id <id>",
      "Zhihu article ID to use as test target",
    )
    .option("--delay <seconds>", "Seconds between requests", Number, 1.5)
    .option("--test <name>", "Run only tests matching this name pattern", "")
    .parse()
    .opts<{ articleId: string; delay: number; test: string }>();

  let testFiles = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(DATA_DIR, f));
  if (opts.test)
    testFiles = testFiles.filter((f) =>
      path.basename(f, ".md").includes(opts.test),
    );
  if (testFiles.length === 0) {
    console.error("No test files found.");
    process.exit(1);
  }

  const client = await ZhihuClient.fromEnvOrCache({ allowLogin: false });
  const results: Result[] = [];
  for (const [i, mdPath] of testFiles.entries()) {
    const name = path.basename(mdPath, ".md");
    process.stdout.write(`[${i + 1}/${testFiles.length}] ${name} ... `);
    try {
      const result = await runTest(client, opts.articleId, mdPath, opts.delay);
      console.log(
        result.diff.length === 0 ? "OK" : `${result.diff.length} diff lines`,
      );
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`ERROR: ${message}`);
      results.push({ name, diff: [`ERROR: ${message}`] });
    }
  }
  report(results);
}

await main();
