// Pushing markdown to a Zhihu draft and reading the preview back, for the
// round-trip check and the feature tests. Both write to Zhihu.
import { setTimeout as sleep } from "node:timers/promises";
import { rstrip, splitlines, strip } from "./text.ts";
import {
  ZHUANLAN_API,
  ZHUANLAN_HEADERS,
  type ZhihuClient,
} from "./zhihu_client.ts";
import { Parser } from "./zhihu_parser.ts";

const PREVIEW_URL = (id: string): string =>
  `https://zhuanlan.zhihu.com/p/${id}/preview?comment=0&catalog=1`;

export const RESET = "\x1b[0m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const BOLD = "\x1b[1m";

// Lines without trailing spaces, runs of blank lines collapsed, no blank
// lines at either end.
export function normalise(text: string): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const raw of splitlines(text)) {
    const line = rstrip(raw);
    const blank = !strip(line);
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  while (out.length > 0 && !strip(out[0]!)) out.shift();
  while (out.length > 0 && !strip(out[out.length - 1]!)) out.pop();
  return out;
}

// Zhihu serves its image URLs on several pic hosts, with size suffixes and
// query strings; only the v2-hash part is compared.
export function normaliseImageUrls(line: string, suffixes: string): string {
  return line.replace(/(?<=\()([^)]*zhimg\.com[^)]*)/g, (url: string) =>
    url
      .replace(/\?.*$/, "")
      .replace(new RegExp(`_(${suffixes})\\.`), ".")
      .replace(/pic[a-z0-9]*\.zhimg\.com/, "pic.zhimg.com"),
  );
}

export function colourDiff(diff: string[]): string {
  return diff
    .map((line) => {
      if (line.startsWith("---") || line.startsWith("+++"))
        return BOLD + line + RESET;
      if (line.startsWith("-")) return RED + line + RESET;
      if (line.startsWith("+")) return GREEN + line + RESET;
      if (line.startsWith("@@")) return CYAN + line + RESET;
      return line;
    })
    .join("\n");
}

export async function pushAndParsePreview(
  client: ZhihuClient,
  articleId: string,
  draft: { content: string; title: string; titleImage: unknown },
  delaySeconds: number,
): Promise<string> {
  const patch = await client.session.patch(
    `${ZHUANLAN_API}/${articleId}/draft`,
    {
      json: {
        content: draft.content,
        title: draft.title,
        titleImage: draft.titleImage,
        isTitleImageFullScreen: false,
        table_of_contents: true,
      },
      headers: ZHUANLAN_HEADERS,
      timeout: 30,
    },
  );
  patch.raiseForStatus();
  await sleep(delaySeconds * 1000);

  const preview = await client.session.get(PREVIEW_URL(articleId), {
    timeout: 30,
  });
  preview.raiseForStatus();
  await sleep(delaySeconds * 1000);

  return new Parser().parseArticleFromHtml(preview.text).content.dump();
}
