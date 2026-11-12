import { describe, expect, it } from "vitest";
import { ACTOR_KEYS, SUBJECT_KEYS, buildEntry, entryFields } from "../../src/domain/audit-entry.js";
import { GENESIS_HASH, computeHash } from "../../src/domain/hash-chain.js";
import { EVENT_TIME, MARKET_ID, TENANT_A, eventId, receivedEvent } from "../support/harness.js";

const RECORDED = new Date("2026-11-01T10:00:05.000Z");
const ID = "018f3c1e-7a00-7000-8000-0000000000c1";

describe("the subject of an entry", () => {
  it("is the first of marketId, depositId, withdrawalId, userId and tenantId that the data holds, whatever the order in the data", () => {
    expect(SUBJECT_KEYS).toEqual(["marketId", "depositId", "withdrawalId", "userId", "tenantId"]);
    const all = { tenantId: "t", userId: "u", withdrawalId: "w", depositId: "d", marketId: "m" };
    const subjects: string[] = [];
    let data: Record<string, string> = { ...all };
    for (const key of SUBJECT_KEYS) {
      subjects.push(entryFields(receivedEvent({ data }), RECORDED).subject);
      const { [key]: _removed, ...rest } = data;
      data = rest;
    }
    expect(subjects).toEqual(["m", "d", "w", "u", "t"]);
  });

  it("is the tenant id of the envelope when the data holds none of them", () => {
    expect(entryFields(receivedEvent({ data: { question: "Q?" } }), RECORDED).subject).toBe(TENANT_A);
    expect(entryFields(receivedEvent({ data: {} }), RECORDED).subject).toBe(TENANT_A);
  });

  it("is the envelope's tenant id for data that is no object (a list, a text, a number)", () => {
    for (const data of [[MARKET_ID], MARKET_ID, 5]) expect(entryFields(receivedEvent({ data }), RECORDED).subject).toBe(TENANT_A);
  });

  it("skips a value that is no text, is empty or is longer than 255 characters, and takes the next key", () => {
    expect(entryFields(receivedEvent({ data: { marketId: 5, depositId: "", withdrawalId: "w-1" } }), RECORDED).subject).toBe("w-1");
    expect(entryFields(receivedEvent({ data: { marketId: null, depositId: ["d"], userId: "x".repeat(256), tenantId: "t-1" } }), RECORDED).subject).toBe("t-1");
    expect(entryFields(receivedEvent({ data: { marketId: "x".repeat(255) } }), RECORDED).subject).toBe("x".repeat(255));
  });

  it("does not read the subject attribute of the CloudEvent", () => {
    expect(entryFields(receivedEvent({ subject: "market/other", data: { question: "Q?" } }), RECORDED).subject).toBe(TENANT_A);
  });
});

describe("the actor of an entry", () => {
  it("is the first of actorId, userId and adminId that the data holds, or null", () => {
    expect(ACTOR_KEYS).toEqual(["actorId", "userId", "adminId"]);
    expect(entryFields(receivedEvent({ data: { adminId: "a", userId: "u", actorId: "x" } }), RECORDED).actor).toBe("x");
    expect(entryFields(receivedEvent({ data: { adminId: "a", userId: "u" } }), RECORDED).actor).toBe("u");
    expect(entryFields(receivedEvent({ data: { adminId: "a" } }), RECORDED).actor).toBe("a");
    expect(entryFields(receivedEvent({ data: { marketId: MARKET_ID } }), RECORDED).actor).toBeNull();
  });

  it("skips values that are not usable texts", () => {
    expect(entryFields(receivedEvent({ data: { actorId: 1, userId: "", adminId: "a-1" } }), RECORDED).actor).toBe("a-1");
    expect(entryFields(receivedEvent({ data: { actorId: "x".repeat(256) } }), RECORDED).actor).toBeNull();
    expect(entryFields(receivedEvent({ data: ["a"] }), RECORDED).actor).toBeNull();
  });

  it("can be the same id as the subject (a user's own event)", () => {
    const fields = entryFields(receivedEvent({ data: { userId: "user-7" } }), RECORDED);
    expect(fields.subject).toBe("user-7");
    expect(fields.actor).toBe("user-7");
  });
});

describe("entryFields", () => {
  it("takes the rest from the envelope and keeps the data as the payload", () => {
    const data = { marketId: MARKET_ID, question: "Will it rain?", nested: { a: [1, 2] } };
    expect(entryFields(receivedEvent({ data }), RECORDED)).toEqual({
      eventId: eventId(1),
      eventType: "si.chance.markets.MarketOpened.v1",
      source: "/chance/markets",
      subject: MARKET_ID,
      actor: null,
      occurredAt: EVENT_TIME,
      recordedAt: RECORDED,
      correlationId: "corr-1",
      causationId: "req-1",
      payload: data,
    });
  });

  it("takes the recording time as the time of the event when the event has none", () => {
    const fields = entryFields(receivedEvent({ time: undefined }), RECORDED);
    expect(fields.occurredAt).toEqual(RECORDED);
    expect(fields.recordedAt).toEqual(RECORDED);
  });

  it("records an event of an unknown type, from an unknown source, with whatever ids its data holds", () => {
    const fields = entryFields(
      receivedEvent({ type: "si.chance.future.WidgetRetired.v3", source: "/chance/future", data: { widgetId: "w-9", userId: "u-1", note: "anything" } }),
      RECORDED,
    );
    expect(fields).toMatchObject({ eventType: "si.chance.future.WidgetRetired.v3", source: "/chance/future", subject: "u-1", actor: "u-1", payload: { widgetId: "w-9", userId: "u-1", note: "anything" } });
  });

  it("gives null for a correlation and a causation id the event lacks", () => {
    const fields = entryFields(receivedEvent({ correlationid: undefined, causationid: undefined }), RECORDED);
    expect(fields.correlationId).toBeNull();
    expect(fields.causationId).toBeNull();
  });
});

describe("buildEntry", () => {
  it("makes the first entry of a tenant: seq 1, the genesis hash as previous hash, its own hash", () => {
    const entry = buildEntry(receivedEvent({ data: { marketId: ID, adminId: "admin-1" } }), RECORDED, null);
    expect(entry).toMatchObject({ seq: 1, prevHash: GENESIS_HASH, subject: ID, actor: "admin-1" });
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.hash).toBe(computeHash(entry));
  });

  it("chains the next entry to the head: the next seq and the head's hash as previous hash", () => {
    const first = buildEntry(receivedEvent(), RECORDED, null);
    const second = buildEntry(receivedEvent({ id: eventId(2) }), RECORDED, { seq: first.seq, hash: first.hash });
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash, eventId: eventId(2) });
    expect(second.hash).not.toBe(first.hash);
    const far = buildEntry(receivedEvent({ id: eventId(3) }), RECORDED, { seq: 41, hash: "ab".repeat(32) });
    expect(far).toMatchObject({ seq: 42, prevHash: "ab".repeat(32) });
  });

  it("gives the same entry for the same event and head, and a recording time that does not change the hash", () => {
    const first = buildEntry(receivedEvent(), RECORDED, null);
    expect(buildEntry(receivedEvent(), RECORDED, null)).toEqual(first);
    const later = buildEntry(receivedEvent(), new Date(RECORDED.getTime() + 60_000), null);
    expect(later.recordedAt).not.toEqual(first.recordedAt);
    expect(later.hash).toBe(first.hash);
  });

  it("gives another hash for another event, another payload or another head", () => {
    const base = buildEntry(receivedEvent(), RECORDED, null).hash;
    expect(buildEntry(receivedEvent({ id: eventId(2) }), RECORDED, null).hash).not.toBe(base);
    expect(buildEntry(receivedEvent({ data: { marketId: MARKET_ID, question: "Will it snow?", version: 1 } }), RECORDED, null).hash).not.toBe(base);
    expect(buildEntry(receivedEvent(), RECORDED, { seq: 1, hash: "cd".repeat(32) }).hash).not.toBe(base);
  });
});
