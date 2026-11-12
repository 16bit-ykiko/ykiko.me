import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  extractFrontMatter,
  renderFrontMatter,
  type Metadata,
} from "../front_matter.ts";
import { dumpYaml } from "../yaml_io.ts";
import { FIXTURES, assertMatchesFile } from "./helpers.ts";

interface Case {
  name: string;
  metadata: Metadata;
  body: string;
}

const cases = JSON.parse(
  readFileSync(path.join(FIXTURES, "front_matter.json"), "utf8"),
) as Case[];

for (const c of cases) {
  test(`front matter: ${c.name}`, () => {
    assertMatchesFile(
      renderFrontMatter(c.metadata, c.body),
      `front_matter/${c.name}.md`,
    );
  });
}

test("front matter read back is written the same way", () => {
  for (const c of cases) {
    const [metadata, body] = extractFrontMatter(
      renderFrontMatter(c.metadata, c.body),
    );
    assert.equal(
      renderFrontMatter(metadata, body),
      renderFrontMatter(c.metadata, body),
      c.name,
    );
  }
});

test("cookie cache: long values fold at 80 columns", () => {
  const cookie = JSON.parse(
    readFileSync(path.join(FIXTURES, "cookie_cache.json"), "utf8"),
  ) as Metadata;
  assertMatchesFile(dumpYaml(cookie), "front_matter/cookie_cache.yaml");
});

test("text without front matter is all body", () => {
  assert.deepEqual(extractFrontMatter("# title\n"), [{}, "# title\n"]);
  assert.deepEqual(extractFrontMatter("---\nno end\n"), [{}, "---\nno end\n"]);
});
