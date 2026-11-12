import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEntry } from "../../src/domain/audit-entry.js";
import type { AuditEntry, ChainHead } from "../../src/domain/audit-entry.js";
import { ChainVerifier, GENESIS_HASH, canonicalEntry, computeHash, findBreak, verifyChain } from "../../src/domain/hash-chain.js";
import { EVENT_TIME, MARKET_ID, eventId, receivedEvent } from "../support/harness.js";

/** A log of `count` entries as the consumer would append them, each from its own event. */
function chain(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let head: ChainHead | null = null;
  for (let n = 1; n <= count; n += 1) {
    const event = receivedEvent({
      id: eventId(n),
      type: n % 2 === 0 ? "si.chance.payments.DepositSucceeded.v1" : "si.chance.markets.MarketOpened.v1",
      time: new Date(EVENT_TIME.getTime() + n * 1000).toISOString(),
      data: { marketId: MARKET_ID, userId: `user-${n}`, n },
    });
    const entry = buildEntry(event, new Date(EVENT_TIME.getTime() + n * 1000 + 50), head);
    entries.push(entry);
    head = { seq: entry.seq, hash: entry.hash };
  }
  return entries;
}

/** An attacker who changes an entry and also recomputes its hash. */
const reseal = (entry: AuditEntry, changes: Partial<AuditEntry>): AuditEntry => {
  const changed = { ...entry, ...changes };
  return { ...changed, hash: computeHash(changed) };
};

describe("the hash rule, pinned with a fixed example", () => {
  // The same numbers are in contracts/README.md; the digest was computed separately with Python's hashlib:
  //   hashlib.sha256(bytes(32) + text.encode()).hexdigest()
  const entry = {
    seq: 1,
    prevHash: GENESIS_HASH,
    eventId: "018f3c1e-7a00-7000-8000-000000000001",
    eventType: "si.chance.markets.MarketOpened.v1",
    source: "/chance/markets",
    subject: MARKET_ID,
    actor: "admin-1",
    occurredAt: EVENT_TIME,
    correlationId: "corr-1",
    causationId: null,
    payload: { version: 1, question: "Q?", marketId: MARKET_ID },
  };
  const TEXT =
    '{"actor":"admin-1","causation_id":null,"correlation_id":"corr-1","event_id":"018f3c1e-7a00-7000-8000-000000000001",' +
    '"event_type":"si.chance.markets.MarketOpened.v1","occurred_at":"2026-11-01T10:00:00.000Z",' +
    '"payload":{"marketId":"018f3c1e-7a00-7000-8000-0000000000b1","question":"Q?","version":1},' +
    `"prev_hash":"${"0".repeat(64)}","seq":1,"source":"/chance/markets","subject":"018f3c1e-7a00-7000-8000-0000000000b1"}`;

  it("serializes the fields but the hash and the recording time as one compact object with sorted keys", () => {
    expect(canonicalEntry(entry)).toBe(TEXT);
  });

  it("hashes the 32 bytes of the previous hash followed by that text", () => {
    expect(computeHash(entry)).toBe("0b487b0e0b75b1c20225a09b502c73a8f6fae58764565e93837e347bae5f2449");
    expect(createHash("sha256").update(Buffer.alloc(32)).update(TEXT, "utf8").digest("hex")).toBe(computeHash(entry));
  });

  it("starts from 32 zero bytes: 64 zero digits", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it("does not depend on the order of the payload's keys or on the recording time", () => {
    const reordered = { ...entry, payload: { marketId: MARKET_ID, version: 1, question: "Q?" } };
    expect(computeHash(reordered)).toBe(computeHash(entry));
    expect(canonicalEntry({ ...entry, payload: { a: 1, b: 2 } })).toBe(canonicalEntry({ ...entry, payload: { b: 2, a: 1 } }));
  });

  it("takes the time as UTC with milliseconds, whatever offset the event carried", () => {
    const event = receivedEvent({ time: "2026-11-01T12:00:00.000+02:00", data: { adminId: "admin-1", marketId: MARKET_ID, question: "Q?", version: 1 } });
    expect(buildEntry(event, EVENT_TIME, null).occurredAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("refuses a previous hash that is not 64 lower-case hex digits", () => {
    for (const prevHash of ["", "zz".repeat(32), "AB".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
      expect(() => computeHash({ ...entry, prevHash })).toThrow("64 lower-case hex digits");
    }
  });
});

describe("verifyChain on a log that was not touched", () => {
  it("is valid for no entry, one entry and a long log, and counts the entries", () => {
    expect(verifyChain([])).toEqual({ valid: true, entries: 0, brokenAtSeq: null });
    expect(verifyChain(chain(1))).toEqual({ valid: true, entries: 1, brokenAtSeq: null });
    expect(verifyChain(chain(25))).toEqual({ valid: true, entries: 25, brokenAtSeq: null });
  });

  it("links every entry to the one before it", () => {
    const entries = chain(4);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    for (let index = 1; index < entries.length; index += 1) expect(entries[index]?.prevHash).toBe(entries[index - 1]?.hash);
    expect(new Set(entries.map((entry) => entry.hash)).size).toBe(4);
  });

  it("does not look at the recording time", () => {
    const entries = chain(3).map((entry) => ({ ...entry, recordedAt: new Date(0) }));
    expect(verifyChain(entries).valid).toBe(true);
  });

  it("gives the same result when the entries are fed one by one, as pages read from the database are", () => {
    const entries = chain(7);
    const verifier = new ChainVerifier();
    for (const entry of entries) verifier.push(entry);
    expect(verifier.result()).toEqual(verifyChain(entries));
    expect(new ChainVerifier().result()).toEqual({ valid: true, entries: 0, brokenAtSeq: null });
  });
});

describe("tamper detection", () => {
  it.each([
    ["the payload", (entry: AuditEntry) => ({ ...entry, payload: { ...(entry.payload as object), n: 999 } })],
    ["a value deep in the payload", (entry: AuditEntry) => ({ ...entry, payload: { nested: { list: [1, 2, 3] } } })],
    ["the event type", (entry: AuditEntry) => ({ ...entry, eventType: "si.chance.markets.MarketResolved.v1" })],
    ["the source", (entry: AuditEntry) => ({ ...entry, source: "/chance/other" })],
    ["the subject", (entry: AuditEntry) => ({ ...entry, subject: "someone-else" })],
    ["the actor", (entry: AuditEntry) => ({ ...entry, actor: "mallory" })],
    ["the actor, removed", (entry: AuditEntry) => ({ ...entry, actor: null })],
    ["the time of the event", (entry: AuditEntry) => ({ ...entry, occurredAt: new Date(entry.occurredAt.getTime() + 1) })],
    ["the correlation id", (entry: AuditEntry) => ({ ...entry, correlationId: "other" })],
    ["the causation id", (entry: AuditEntry) => ({ ...entry, causationId: "other" })],
    ["the event id", (entry: AuditEntry) => ({ ...entry, eventId: "forged" })],
  ])("finds a changed %s at that entry", (_what, change) => {
    const entries = chain(5);
    const changed = entries.map((entry, index) => (index === 2 ? change(entry) : entry));
    expect(verifyChain(changed)).toEqual({ valid: false, entries: 5, brokenAtSeq: 3 });
    expect(findBreak(changed[2] as AuditEntry, entries[1] as AuditEntry)).toBe("hash");
  });

  it("finds a changed payload in the first and in the last entry", () => {
    const first = chain(4);
    first[0] = { ...(first[0] as AuditEntry), payload: { forged: true } };
    expect(verifyChain(first).brokenAtSeq).toBe(1);
    const last = chain(4);
    last[3] = { ...(last[3] as AuditEntry), payload: { forged: true } };
    expect(verifyChain(last).brokenAtSeq).toBe(4);
  });

  it("finds a removed entry at the entry after the gap", () => {
    const entries = chain(5);
    const result = verifyChain([entries[0], entries[1], entries[3], entries[4]] as AuditEntry[]);
    expect(result).toEqual({ valid: false, entries: 4, brokenAtSeq: 4 });
    expect(findBreak(entries[3] as AuditEntry, entries[1] as AuditEntry)).toBe("seq");
  });

  it("finds a removed first entry", () => {
    expect(verifyChain(chain(4).slice(1))).toEqual({ valid: false, entries: 3, brokenAtSeq: 2 });
  });

  it("finds a removed entry even when the next entries were renumbered but not rehashed", () => {
    const entries = chain(4);
    const renumbered = [entries[0], { ...(entries[2] as AuditEntry), seq: 2 }, { ...(entries[3] as AuditEntry), seq: 3 }] as AuditEntry[];
    const result = verifyChain(renumbered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("finds reordered entries at the first place that is out of order", () => {
    const entries = chain(5);
    const swapped = [entries[0], entries[2], entries[1], entries[3], entries[4]] as AuditEntry[];
    expect(verifyChain(swapped)).toEqual({ valid: false, entries: 5, brokenAtSeq: 3 });
    expect(verifyChain([...entries].reverse())).toMatchObject({ valid: false, brokenAtSeq: 5 });
  });

  it("finds a changed previous hash, whether it names another entry or nothing", () => {
    const entries = chain(4);
    for (const forged of [entries[0]?.hash, "ef".repeat(32), GENESIS_HASH, "not a hash"]) {
      const changed = entries.map((entry, index) => (index === 2 ? { ...entry, prevHash: forged as string } : entry));
      expect(verifyChain(changed), String(forged)).toEqual({ valid: false, entries: 4, brokenAtSeq: 3 });
      expect(findBreak(changed[2] as AuditEntry, entries[1] as AuditEntry)).toBe("prev_hash");
    }
  });

  it("finds a changed first previous hash: the first entry must start from the genesis hash", () => {
    const entries = chain(3);
    entries[0] = { ...(entries[0] as AuditEntry), prevHash: "ab".repeat(32) };
    expect(verifyChain(entries).brokenAtSeq).toBe(1);
    expect(findBreak(entries[0], null)).toBe("prev_hash");
  });

  it("finds a stored hash that was replaced, also by a text that is no hash", () => {
    const entries = chain(4);
    for (const forged of ["ab".repeat(32), "", "zz".repeat(32), entries[0]?.hash as string]) {
      const changed = entries.map((entry, index) => (index === 1 ? { ...entry, hash: forged } : entry));
      expect(verifyChain(changed), forged).toEqual({ valid: false, entries: 4, brokenAtSeq: 2 });
    }
  });

  it("finds a changed seq", () => {
    const entries = chain(4);
    const changed = entries.map((entry, index) => (index === 2 ? { ...entry, seq: 9 } : entry));
    expect(verifyChain(changed).brokenAtSeq).toBe(9);
    expect(findBreak(changed[2] as AuditEntry, entries[1] as AuditEntry)).toBe("seq");
  });

  it("finds a forged entry whose own hash is right but that does not belong to the chain", () => {
    const entries = chain(4);
    const forged = reseal(entries[2] as AuditEntry, { payload: { forged: true } });
    // Its own hash now fits its fields, but the entry after it still names the old hash.
    expect(verifyChain([entries[0], entries[1], forged, entries[3]] as AuditEntry[])).toEqual({ valid: false, entries: 4, brokenAtSeq: 4 });
  });

  it("reports the first wrong entry and goes on counting", () => {
    const entries = chain(6);
    const changed = entries.map((entry, index) => (index === 1 || index === 4 ? { ...entry, payload: { forged: index } } : entry));
    expect(verifyChain(changed)).toEqual({ valid: false, entries: 6, brokenAtSeq: 2 });
  });

  it("does not see a change made to the recording time: it is not part of the hash, and the log does not claim it is", () => {
    const entries = chain(3);
    entries[1] = { ...(entries[1] as AuditEntry), recordedAt: new Date(0) };
    expect(verifyChain(entries).valid).toBe(true);
  });

  it("does not see missing entries at the end, nor a log whose later hashes were all recomputed: the head hash has to be kept elsewhere", () => {
    const entries = chain(5);
    expect(verifyChain(entries.slice(0, 3)).valid).toBe(true);

    const rewritten: AuditEntry[] = [];
    let previous: ChainHead | null = null;
    for (const [index, entry] of entries.entries()) {
      const changed: AuditEntry = reseal(entry, { prevHash: previous === null ? GENESIS_HASH : previous.hash, ...(index === 1 ? { payload: { forged: true } } : {}) });
      rewritten.push(changed);
      previous = { seq: changed.seq, hash: changed.hash };
    }
    expect(verifyChain(rewritten).valid).toBe(true);
    expect(rewritten[4]?.hash).not.toBe(entries[4]?.hash);
  });
});
