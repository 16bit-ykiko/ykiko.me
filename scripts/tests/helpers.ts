import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(TESTS_DIR, "fixtures");
export const EXPECTED = path.join(TESTS_DIR, "expected");

// Compares against a file under expected/; UPDATE_EXPECTED=1 rewrites it
// instead, for a change in behaviour that is meant.
export function assertMatchesFile(
  actual: string | Buffer,
  relative: string,
): void {
  const file = path.join(EXPECTED, relative);
  if (process.env["UPDATE_EXPECTED"] === "1") {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  const expected = readFileSync(file);
  if (typeof actual === "string")
    assert.equal(actual, expected.toString("utf8"), relative);
  else assert.ok(actual.equals(expected), relative);
}

export function captureLog<T>(fn: () => T): [T, string[]] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [fn(), lines];
  } finally {
    console.log = original;
  }
}

export async function captureLogAsync<T>(
  fn: () => Promise<T>,
): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [await fn(), lines];
  } finally {
    console.log = original;
  }
}
