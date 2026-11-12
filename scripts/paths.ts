import { realpathSync } from "node:fs";
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

// Whether the module is the script node was started with; node resolves
// symlinks in import.meta.url, so argv[1] is resolved the same way.
export function isMain(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === fileURLToPath(moduleUrl);
  } catch {
    return path.resolve(script) === fileURLToPath(moduleUrl);
  }
}
