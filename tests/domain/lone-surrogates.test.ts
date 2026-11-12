import { describe, expect, it } from "vitest";
import { boundedText, parseReceivedEvent } from "../../src/domain/envelope.js";
import { isStorableJson } from "../../src/domain/json.js";
import { eventId, cloudEvent } from "../support/harness.js";

// A lone UTF-16 surrogate is valid in a JavaScript string and in the escape "\ud800" of a JSON text, but it cannot be
// written to PostgreSQL: a text column stores U+FFFD in its place (the stored value would differ from the hashed one, and
// the chain of the tenant would be broken for good), and jsonb refuses the escape (the message would be redelivered
// for ever). So an envelope that holds one is not valid, and the consumer terminates it.

const LONE = ["\ud800", "a\udc00b", "\ud83dx", "x\ude00", "\udbff\udbff"];

/** What the consumer sees: the event as JSON text (JSON.stringify writes a lone surrogate as an escape), parsed again. */
const received = (overrides: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(cloudEvent(overrides)));

describe("isStorableJson and well-formed text", () => {
  it.each(LONE)("refuses %j as a value, as a key, and nested", (text) => {
    expect(isStorableJson(text)).toBe(false);
    expect(isStorableJson({ k: text })).toBe(false);
    expect(isStorableJson({ [text]: 1 })).toBe(false);
    expect(isStorableJson([[{ deep: [text] }]])).toBe(false);
  });

  it("accepts a surrogate pair (an astral character) and other non-ASCII text, as a value and as a key", () => {
    expect(isStorableJson("😀 Č \u{10FFFF} 𝄞")).toBe(true);
    expect(isStorableJson({ "😀": "𝄞", Č: ["š"] })).toBe(true);
  });
});

describe("boundedText and well-formed text", () => {
  it.each(LONE)("refuses %j", (text) => {
    expect(boundedText(text)).toBeNull();
  });

  it("accepts a surrogate pair", () => {
    expect(boundedText("id-😀")).toBe("id-😀");
  });
});

describe("parseReceivedEvent and well-formed text", () => {
  it.each(["id", "type", "source"])("refuses an event whose %s holds a lone surrogate", (attribute) => {
    for (const text of LONE) expect(parseReceivedEvent(received({ [attribute]: `x${text}` })), `${attribute} ${JSON.stringify(text)}`).toBeNull();
  });

  it("refuses an event whose data holds one, in a value or in a key, at any depth", () => {
    for (const text of LONE) {
      expect(parseReceivedEvent(received({ data: { marketId: text } }))).toBeNull();
      expect(parseReceivedEvent(received({ data: { [text]: 1 } }))).toBeNull();
      expect(parseReceivedEvent(received({ data: [{ list: [text] }] }))).toBeNull();
    }
  });

  it("drops a correlation or causation id that holds one (the entry stores null, which round-trips), and keeps the event", () => {
    const event = parseReceivedEvent(received({ correlationid: "c\ud800", causationid: "\udc00" }));
    expect(event).toMatchObject({ id: eventId(1), correlationId: null, causationId: null });
  });

  it("accepts an event whose text holds a surrogate pair", () => {
    expect(parseReceivedEvent(received({ id: "ev-😀", data: { marketId: "m-😀" } }))).toMatchObject({ id: "ev-😀", data: { marketId: "m-😀" } });
  });
});
