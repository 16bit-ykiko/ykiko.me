import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const ZH_ARTICLES = path.join(
  REPO_ROOT,
  "website",
  "content",
  "zh-cn",
  "articles",
);
export const EN_ARTICLES = path.join(
  REPO_ROOT,
  "website",
  "content",
  "en",
  "articles",
);

// Whether the module is the script node was started with.
export function isMain(moduleUrl: string): boolean {
  return (
    Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]!) === fileURLToPath(moduleUrl)
  );
}
