// JSON.parse loses two things the Zhihu payloads need: integers past 2^53
// (article ids) and the source order of integer-like keys, which JavaScript
// objects sort ahead of the others.

export type Json =
  | null
  | boolean
  | number
  | bigint
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

const keyOrder = new WeakMap<object, string[]>();

export function keysInOrder(obj: JsonObject): string[] {
  return keyOrder.get(obj) ?? Object.keys(obj);
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

export function parseJson(text: string): Json {
  let pos = 0;

  const fail = (what: string): never => {
    throw new SyntaxError(`Invalid JSON: ${what} at position ${pos}`);
  };

  const skip = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      pos++;
    }
  };

  const parseString = (): string => {
    const start = pos;
    pos++;
    while (pos < text.length) {
      const c = text[pos];
      if (c === "\\") pos += 2;
      else if (c === '"') {
        pos++;
        return JSON.parse(text.slice(start, pos)) as string;
      } else pos++;
    }
    return fail("unterminated string");
  };

  const parseValue = (): Json => {
    skip();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const obj: JsonObject = {};
      const order: string[] = [];
      skip();
      if (text[pos] === "}") {
        pos++;
        keyOrder.set(obj, order);
        return obj;
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail("expected key");
        const key = parseString();
        skip();
        if (text[pos] !== ":") fail("expected ':'");
        pos++;
        const value = parseValue();
        if (!Object.hasOwn(obj, key)) order.push(key);
        Object.defineProperty(obj, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          keyOrder.set(obj, order);
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      pos++;
      const arr: Json[] = [];
      skip();
      if (text[pos] === "]") {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (m) {
      pos += m[0].length;
      if (m[1] === undefined && m[2] === undefined) {
        const n = Number(m[0]);
        return Number.isSafeInteger(n) ? n : BigInt(m[0]);
      }
      return Number(m[0]);
    }
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return value;
      }
    }
    return fail("unexpected token");
  };

  const value = parseValue();
  skip();
  if (pos !== text.length) fail("trailing data");
  return value;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Whether a value counts as set: null, false, 0, "" and empty lists or
// objects don't.
export function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === 0n || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return true;
  if (typeof value === "object")
    return keysInOrder(value as JsonObject).length > 0;
  return true;
}
