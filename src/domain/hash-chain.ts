import { createHash } from "node:crypto";
import type { AuditEntry, ChainHead } from "./audit-entry.js";
import { canonicalJson } from "./json.js";

// The hash chain of a tenant's log. Every entry carries the hash of the entry before it and a hash of its own, so a
// changed, removed, inserted or reordered entry breaks the chain from that point on. contracts/README.md describes the
// rule for someone who wants to verify a log without this code; the tests pin it with a fixed example.

/** The "previous hash" of the first entry: 32 zero bytes, as 64 hex digits. */
export const GENESIS_HASH = "0".repeat(64);

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The fields that the hash covers: all of an entry except its own hash and recorded_at. */
export type HashedFields = Omit<AuditEntry, "hash" | "recordedAt">;

/**
 * The canonical text of an entry's hashed fields: one JSON object whose keys are the names of the database columns
 * (actor, causation_id, correlation_id, event_id, event_type, occurred_at, payload, prev_hash, seq, source, subject),
 * sorted, without whitespace. occurred_at is the UTC time with milliseconds ("2026-11-01T10:00:00.000Z"), seq a JSON
 * number, the absent actor, correlation id and causation id are null.
 */
export function canonicalEntry(entry: HashedFields): string {
  return canonicalJson({
    actor: entry.actor,
    causation_id: entry.causationId,
    correlation_id: entry.correlationId,
    event_id: entry.eventId,
    event_type: entry.eventType,
    occurred_at: entry.occurredAt.toISOString(),
    payload: entry.payload,
    prev_hash: entry.prevHash,
    seq: entry.seq,
    source: entry.source,
    subject: entry.subject,
  });
}

/** SHA-256 over the 32 bytes of the previous hash followed by the UTF-8 bytes of the canonical entry text, as lower-case hex. */
export function computeHash(entry: HashedFields): string {
  if (!HASH_PATTERN.test(entry.prevHash)) throw new TypeError("prevHash must be 64 lower-case hex digits");
  return createHash("sha256").update(Buffer.from(entry.prevHash, "hex")).update(canonicalEntry(entry), "utf8").digest("hex");
}

/** What is wrong with an entry: its number does not follow the previous one, it points at another predecessor, or its own hash is not the one its fields give. */
export type ChainBreak = "seq" | "prev_hash" | "hash";

/** The entry as stored: everything but recorded_at, which no check needs. */
export type ChainedEntry = Omit<AuditEntry, "recordedAt">;

/**
 * Checks one entry against the entry before it (null for the first entry of the log): the number is the next one, the
 * previous hash is the hash of the predecessor (or the genesis hash), and the stored hash is the hash of the fields.
 * Returns the first thing that is wrong, or null.
 */
export function findBreak(entry: ChainedEntry, previous: ChainHead | null): ChainBreak | null {
  if (entry.seq !== (previous === null ? 1 : previous.seq + 1)) return "seq";
  if (entry.prevHash !== (previous === null ? GENESIS_HASH : previous.hash) || !HASH_PATTERN.test(entry.prevHash)) return "prev_hash";
  if (!HASH_PATTERN.test(entry.hash) || computeHash(entry) !== entry.hash) return "hash";
  return null;
}

export interface VerifyResult {
  /** True when no entry is wrong. */
  valid: boolean;
  /** How many entries were checked: all of them, also after the first wrong one. */
  entries: number;
  /** The seq of the first wrong entry, or null. For a removed entry it is the entry after the gap. */
  brokenAtSeq: number | null;
}

/**
 * Verifies a log entry by entry, in order of seq starting at the first entry, so that a caller can feed it pages read
 * from the database without holding the whole log. After the first wrong entry it goes on (comparing each entry with
 * the one stored before it), so that `entries` counts the whole log.
 */
export class ChainVerifier {
  private previous: ChainHead | null = null;
  private count = 0;
  private broken: number | null = null;

  push(entry: ChainedEntry): void {
    this.count += 1;
    if (this.broken === null && findBreak(entry, this.previous) !== null) this.broken = entry.seq;
    this.previous = { seq: entry.seq, hash: entry.hash };
  }

  result(): VerifyResult {
    return { valid: this.broken === null, entries: this.count, brokenAtSeq: this.broken };
  }
}

/** Verifies a whole log held in memory. An empty log is valid. */
export function verifyChain(entries: Iterable<ChainedEntry>): VerifyResult {
  const verifier = new ChainVerifier();
  for (const entry of entries) verifier.push(entry);
  return verifier.result();
}
