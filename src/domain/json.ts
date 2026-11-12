// JSON values as events carry them, and the one canonical text of a JSON value that the hash chain is built on.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The deepest nesting a payload may have; a deeper one is refused, so no recursion below can run out of stack. */
export const MAX_JSON_DEPTH = 64;

// In unicode mode \p{Surrogate} matches a surrogate that is not half of a valid pair, and nothing else.
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * True for a text that PostgreSQL stores and returns exactly as it is: no NUL character (text and jsonb refuse it) and no
 * lone UTF-16 surrogate (it is valid in a JavaScript string and in the JSON escape "\ud800", but the driver writes UTF-8,
 * which turns it into U+FFFD: the stored text would differ from the text that was hashed, and jsonb rejects the escape).
 */
export function isStorableText(value: string): boolean {
  return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
}

/**
 * True for a value that can be stored in a PostgreSQL jsonb column and written back without a change: null, booleans,
 * finite numbers, strings and keys that are storable text (isStorableText), arrays and plain objects, at most
 * MAX_JSON_DEPTH levels deep. Undefined, functions, dates, NaN and the like are not JSON.
 */
export function isStorableJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isStorableText(value);
  if (Array.isArray(value)) return value.every((item) => isStorableJson(item, depth + 1));
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value).every(([key, item]) => isStorableText(key) && isStorableJson(item, depth + 1));
  }
  return false;
}

const compareKeys = (a: readonly [string, unknown], b: readonly [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * The canonical text of a JSON value: object keys sorted (by UTF-16 code unit, the order of a JavaScript string
 * comparison, which is plain alphabetical order for ASCII keys), no whitespace, strings and numbers as ECMAScript
 * JSON.stringify writes them, UTF-8 when the text is turned into bytes. Two values that mean the same JSON always give
 * the same text, whatever order their keys came in, and a changed value gives another text.
 * Throws TypeError for a value that is not JSON (undefined, a function, NaN, a date ...).
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_JSON_DEPTH) throw new TypeError("The value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("A number in JSON must be finite");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
      const members = Object.entries(value).sort(compareKeys);
      return `{${members.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`A ${typeof value} is not a JSON value`);
  }
}
