// Unified diff of two line lists, with `context` lines around each change.
export function unifiedDiff(
  a: string[],
  b: string[],
  fromFile: string,
  toFile: string,
  context = 3,
): string[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { tag: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i]!, ai: i++, bi: j++ });
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ tag: "+", line: b[j]!, ai: i, bi: j++ });
    } else {
      ops.push({ tag: "-", line: a[i]!, ai: i++, bi: j });
    }
  }
  const changed = ops
    .map((op, k) => (op.tag !== " " ? k : -1))
    .filter((k) => k >= 0);
  if (changed.length === 0) return [];

  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k]! - context);
    let end = Math.min(ops.length, changed[k]! + context + 1);
    while (k + 1 < changed.length && changed[k + 1]! - context <= end) {
      k++;
      end = Math.min(ops.length, changed[k]! + context + 1);
    }
    const hunk = ops.slice(start, end);
    const aLines = hunk.filter((op) => op.tag !== "+").length;
    const bLines = hunk.filter((op) => op.tag !== "-").length;
    const aStart = hunk[0]!.ai + (aLines > 0 ? 1 : 0);
    const bStart = hunk[0]!.bi + (bLines > 0 ? 1 : 0);
    const range = (s: number, len: number): string =>
      len === 1 ? `${s}` : `${s},${len}`;
    out.push(`@@ -${range(aStart, aLines)} +${range(bStart, bLines)} @@`);
    for (const op of hunk) out.push(op.tag + op.line);
    k++;
  }
  return out;
}
