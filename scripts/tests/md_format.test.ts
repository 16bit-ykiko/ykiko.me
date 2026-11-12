import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { processText, report } from "../md_format.ts";
import { FIXTURES, assertMatchesFile, captureLog } from "./helpers.ts";

const source = readFileSync(
  path.join(FIXTURES, "md_format", "tricky.md"),
  "utf8",
);

for (const mode of ["lint", "fix"] as const) {
  test(`md_format ${mode} report`, () => {
    const result = processText("tricky.md", source, mode === "fix");
    const [, lines] = captureLog(() => report([result], mode === "fix"));
    assertMatchesFile(`${lines.join("\n")}\n`, `md_format/tricky.${mode}.txt`);
    if (mode === "fix")
      assertMatchesFile(result.fixedLines!.join(""), "md_format/tricky.md");
  });
}
