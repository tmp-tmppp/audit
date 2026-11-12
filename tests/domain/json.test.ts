import { describe, expect, it } from "vitest";
import { MAX_JSON_DEPTH, canonicalJson, isStorableJson } from "../../src/domain/json.js";

const nested = (levels: number): unknown => (levels === 0 ? 1 : [nested(levels - 1)]);

describe("canonicalJson", () => {
  it("sorts the keys at every level, writes no whitespace and keeps the order of arrays", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null }, "": true })).toBe('{"":true,"a":{"c":null,"d":[3,1,2]},"b":1}');
  });

  it("gives one text for the same JSON whatever the order the keys came in", () => {
    const first = JSON.parse('{"x":1,"y":{"p":"q","a":[1,{"k":2,"j":3}]}}') as unknown;
    const second = JSON.parse('{"y":{"a":[1,{"j":3,"k":2}],"p":"q"},"x":1}') as unknown;
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("writes strings and numbers as JSON.stringify does, non-ASCII text as it is", () => {
    expect(canonicalJson({ text: 'a"b\\c\nèš', n: [0, -0, 1.5, 1e21, 123456789012] })).toBe('{"n":[0,0,1.5,1e+21,123456789012],"text":"a\\"b\\\\c\\nèš"}');
  });

  it("tells values apart: a changed value, key or type gives another text", () => {
    const base = canonicalJson({ a: 1 });
    expect(canonicalJson({ a: 2 })).not.toBe(base);
    expect(canonicalJson({ b: 1 })).not.toBe(base);
    expect(canonicalJson({ a: "1" })).not.toBe(base);
    expect(canonicalJson({ a: [1] })).not.toBe(base);
  });

  it("sorts keys by UTF-16 code unit, which is alphabetical order for ASCII", () => {
    expect(canonicalJson({ B: 1, a: 2, _: 3, "1": 4 })).toBe('{"1":4,"B":1,"_":3,"a":2}');
  });

  it.each([[undefined], [() => 1], [Number.NaN], [Number.POSITIVE_INFINITY], [10n], [Symbol("s")]])("refuses %s, which is not JSON", (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => canonicalJson({ inside: value })).toThrow(TypeError);
  });

  it("refuses a value nested more than MAX_JSON_DEPTH levels", () => {
    expect(() => canonicalJson(nested(MAX_JSON_DEPTH))).not.toThrow();
    expect(() => canonicalJson(nested(MAX_JSON_DEPTH + 1))).toThrow("nested too deeply");
  });
});

describe("isStorableJson", () => {
  it.each([[null], [true], [0], [-1.5], ["text"], [[]], [{}], [{ a: [1, { b: null }] }], ["è😀"]])("accepts %j", (value) => {
    expect(isStorableJson(value)).toBe(true);
  });

  it.each([
    [undefined, "undefined"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinity"],
    [() => 1, "a function"],
    [new Date(), "a date"],
    ["a\u0000b", "a NUL in a string"],
    [{ "a\u0000b": 1 }, "a NUL in a key"],
    [{ a: undefined }, "an undefined member"],
    [[1, undefined], "an undefined item"],
    [new Map(), "a map"],
    [nested(MAX_JSON_DEPTH + 1), "too deep a nesting"],
  ])("refuses %j (%s)", (value) => {
    expect(isStorableJson(value)).toBe(false);
  });

  it("refuses a bigint and a symbol", () => {
    expect(isStorableJson(10n)).toBe(false);
    expect(isStorableJson(Symbol("s"))).toBe(false);
  });

  it("accepts a nesting of exactly MAX_JSON_DEPTH levels", () => {
    expect(isStorableJson(nested(MAX_JSON_DEPTH))).toBe(true);
  });

  it("accepts an object without a prototype", () => {
    expect(isStorableJson(Object.assign(Object.create(null) as object, { a: 1 }))).toBe(true);
  });
});
