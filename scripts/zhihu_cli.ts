import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { metadataString, readMarkdownDocument } from "./front_matter.ts";
import { REPO_ROOT, ZH_ARTICLES } from "./paths.ts";
import { strip } from "./text.ts";
import {
  COOKIE_FILE,
  ZhihuClient,
  type ZhihuColumn,
  formatCookieHeader,
  saveCookieCache,
  saveGithubSecret,
} from "./zhihu_client.ts";

function resolveUserPath(raw: string): string {
  const expanded =
    raw === "~" || raw.startsWith("~/")
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  const absolute = path.resolve(expanded);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function requireFile(raw: string): string {
  const file = resolveUserPath(raw);
  if (!existsSync(file))
    throw new Error(`No such file or directory: '${file}'`);
  return file;
}

function buildClient(): Promise<ZhihuClient> {
  return ZhihuClient.fromEnvOrCache({ allowLogin: false });
}

async function syncArticles(client: ZhihuClient): Promise<void> {
  const delaySeconds = Number(process.env["ZHIHU_DELAY_SECONDS"] ?? "0");
  await client.syncArticles(ZH_ARTICLES, delaySeconds);
  runMarkdownFormat();
}

function runMarkdownFormat(): void {
  if (!existsSync(path.join(REPO_ROOT, "pixi.toml"))) {
    console.log("Skip formatting: pixi.toml not found.");
    return;
  }
  if (spawnSync("pixi", ["--version"], { stdio: "ignore" }).error) {
    throw new Error(
      "pixi is required to format synced markdown. Install pixi and rerun the sync.",
    );
  }
  console.log("Formatting repository via pixi...");
  const result = spawnSync("pixi", ["run", "-e", "format", "format"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Command 'pixi run -e format format' returned non-zero exit status ${result.status}.`,
    );
  }
}

function exportCookie(
  client: ZhihuClient,
  options: { savePath: string; ghSecret: string; showValue: boolean },
): void {
  const cookieHeader = formatCookieHeader(client.session);
  if (options.savePath) {
    mkdirSync(path.dirname(path.resolve(options.savePath)), {
      recursive: true,
    });
    writeFileSync(options.savePath, `${cookieHeader}\n`, "utf8");
    console.log(`Saved cookie to ${options.savePath}`);
  }
  if (options.ghSecret) {
    saveGithubSecret(options.ghSecret, cookieHeader);
    console.log(`Updated GitHub secret ${options.ghSecret}`);
  }
  if (options.showValue) {
    if (!process.stdout.isTTY) console.log(`::add-mask::${cookieHeader}`);
    console.log(`ZHIHU_COOKIE=${cookieHeader}`);
  }
}

async function findColumn(
  client: ZhihuClient,
  columnId: string,
): Promise<ZhihuColumn | null> {
  if (!columnId) return null;
  const column = (await client.listColumns()).find((c) => c.id === columnId);
  if (!column)
    throw new Error(`No column ${columnId} among your Zhihu columns.`);
  return column;
}

async function resolveArticle(
  command: Command,
  markdownPathArg: string,
  articleIdOption: string,
): Promise<{ markdownPath: string; articleId: string }> {
  let articleId = strip(articleIdOption);
  let rawPath = strip(markdownPathArg);
  if (!rawPath) {
    if (!articleId) {
      command.error(
        "error: Either provide markdown_path or --article-id to derive the local file path.",
        { exitCode: 2 },
      );
    }
    rawPath = path.join(ZH_ARTICLES, articleId, "index.md");
  }
  const markdownPath = requireFile(rawPath);
  if (!articleId) {
    const [metadata] = readMarkdownDocument(markdownPath);
    articleId = strip(metadataString(metadata, "zhihu_article_id"));
  }
  if (!articleId) {
    throw new Error(
      "No article id provided. Use --article-id or add zhihu_article_id to front matter.",
    );
  }
  return { markdownPath, articleId };
}

const MARKDOWN_PATH_HELP =
  "Path to the markdown file. Defaults to website/content/zh-cn/articles/<article-id>/index.md.";
const COLUMN_HELP =
  "Zhihu column id to publish into, e.g. c_1852831599382646784. Without it, no column.";

function buildProgram(): Command {
  const program = new Command("zhihu_cli.ts")
    .description(
      "Zhihu toolkit: QR login, syncing articles, publishing and updating them.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  node scripts/zhihu_cli.ts sync\n" +
        "  node scripts/zhihu_cli.ts login --gh-secret ZHIHU_COOKIE\n" +
        "  node scripts/zhihu_cli.ts publish path/to/article.md --column c_1852831599382646784\n" +
        "  node scripts/zhihu_cli.ts update-article --article-id 2090994886531100694\n",
    );

  program
    .command("sync")
    .description("Sync all Zhihu articles into the website content directory.")
    .action(async () => syncArticles(await buildClient()));

  program
    .command("login")
    .description(
      "Log in by scanning a QR code with the Zhihu app and cache the cookie in .cookie/zhihu.yaml.",
    )
    .option("--save <path>", "Also write the cookie header to this file.", "")
    .option(
      "--gh-secret <name>",
      "Also store the cookie header in this GitHub secret (gh).",
      "",
    )
    .option(
      "--stdout",
      "Print the cookie header (masked in GitHub Actions logs).",
    )
    .action(
      async (opts: { save: string; ghSecret: string; stdout?: boolean }) => {
        const client = await ZhihuClient.fromEnvOrCache({
          allowLogin: true,
          forceLogin: true,
        });
        saveCookieCache(client.session, COOKIE_FILE);
        console.log(`Logged in as ${await client.profileName()}`);
        console.log(`Cookie cache ${COOKIE_FILE}`);
        exportCookie(client, {
          savePath: opts.save,
          ghSecret: opts.ghSecret,
          showValue: Boolean(opts.stdout),
        });
      },
    );

  program
    .command("publish")
    .description("Publish a local markdown file as a new Zhihu article.")
    .argument("<markdown_path>")
    .option("--column <id>", COLUMN_HELP, "")
    .action(async (markdownPathArg: string, opts: { column: string }) => {
      const client = await buildClient();
      const markdownPath = requireFile(markdownPathArg);
      const column = await findColumn(client, strip(opts.column));
      const articleId = await client.createOrUpdateArticle(
        markdownPath,
        null,
        column,
      );
      console.log(
        `Published new article: https://zhuanlan.zhihu.com/p/${articleId}`,
      );
    });

  program
    .command("update-article")
    .description("Update an existing Zhihu article from a markdown file.")
    .argument("[markdown_path]", MARKDOWN_PATH_HELP, "")
    .option(
      "--article-id <id>",
      "The Zhihu article; defaults to zhihu_article_id in the front matter.",
      "",
    )
    .option("--column <id>", COLUMN_HELP, "")
    .action(
      async (
        markdownPathArg: string,
        opts: { articleId: string; column: string },
        command: Command,
      ) => {
        const client = await buildClient();
        const { markdownPath, articleId } = await resolveArticle(
          command,
          markdownPathArg,
          opts.articleId,
        );
        const column = await findColumn(client, strip(opts.column));
        const updatedId = await client.createOrUpdateArticle(
          markdownPath,
          articleId,
          column,
        );
        console.log(
          `Updated article: https://zhuanlan.zhihu.com/p/${updatedId}`,
        );
      },
    );

  program
    .command("preview")
    .description("Push draft content and print the Zhihu preview URL.")
    .argument("[markdown_path]", MARKDOWN_PATH_HELP, "")
    .option(
      "--article-id <id>",
      "The Zhihu article; defaults to zhihu_article_id in the front matter.",
      "",
    )
    .action(
      async (
        markdownPathArg: string,
        opts: { articleId: string },
        command: Command,
      ) => {
        const client = await buildClient();
        const { markdownPath, articleId } = await resolveArticle(
          command,
          markdownPathArg,
          opts.articleId,
        );
        console.log(
          `Preview URL: ${await client.previewArticle(markdownPath, articleId)}`,
        );
      },
    );

  return program;
}

try {
  await buildProgram().parseAsync();
} catch (error) {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exit(1);
}
