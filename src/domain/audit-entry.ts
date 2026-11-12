import { boundedText } from "./envelope.js";
import type { ReceivedEvent } from "./envelope.js";
import { GENESIS_HASH, computeHash } from "./hash-chain.js";
import type { JsonValue } from "./json.js";

// An entry of a tenant's audit log, built from an event the consumer received. Pure functions: the consumer decides
// when to append, the store decides where the entry is kept.

/** What the event gives: every field of an entry except its place in the chain. */
export interface EntryFields {
  eventId: string;
  eventType: string;
  source: string;
  /** The main id of the event, see SUBJECT_KEYS. */
  subject: string;
  /** The user who caused the event, see ACTOR_KEYS, or null. */
  actor: string | null;
  /** The CloudEvent time; the recording time when the event has none. */
  occurredAt: Date;
  /** When audit stored the entry. Not part of the hash. */
  recordedAt: Date;
  correlationId: string | null;
  causationId: string | null;
  /** The event's data as received. */
  payload: JsonValue;
}

/** An entry as it is stored: its fields and its place in the tenant's chain. */
export interface AuditEntry extends EntryFields {
  /** 1, 2, 3 ... per tenant, without gaps. */
  seq: number;
  /** The hash of the previous entry; the genesis hash (64 zeros) for seq 1. */
  prevHash: string;
  hash: string;
}

/** The last entry of a tenant's chain: what the next entry is chained to. */
export interface ChainHead {
  seq: number;
  hash: string;
}

/** The keys of the event data that name its subject, the first one present wins. The event's tenant id is the fallback. */
export const SUBJECT_KEYS = ["marketId", "depositId", "withdrawalId", "userId", "tenantId"] as const;

/** The keys of the event data that name the actor, the first one present wins. */
export const ACTOR_KEYS = ["actorId", "userId", "adminId"] as const;

/** The first of the keys whose value in the data is a usable text (1 to 255 characters), or null. */
function firstText(data: JsonValue, keys: readonly string[]): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  for (const key of keys) {
    const text = boundedText(data[key]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * The fields of the entry for a received event. The subject is the first of marketId, depositId, withdrawalId, userId and
 * tenantId that the data holds as a text, and the tenant id of the envelope when it holds none; the actor is the first
 * of actorId, userId and adminId, or null. The event's type is not looked at: an event type audit does not know is
 * recorded like any other, with whatever ids its data happens to hold.
 */
export function entryFields(event: ReceivedEvent, recordedAt: Date): EntryFields {
  return {
    eventId: event.id,
    eventType: event.type,
    source: event.source,
    subject: firstText(event.data, SUBJECT_KEYS) ?? event.tenantId,
    actor: firstText(event.data, ACTOR_KEYS),
    occurredAt: event.time ?? recordedAt,
    recordedAt,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.data,
  };
}

/**
 * The entry that follows `head` in the chain (the first entry when the tenant has none yet): the next number, the
 * previous hash taken from the head, and the entry's own hash.
 */
export function buildEntry(event: ReceivedEvent, recordedAt: Date, head: ChainHead | null): AuditEntry {
  const fields = entryFields(event, recordedAt);
  const chained = { ...fields, seq: head === null ? 1 : head.seq + 1, prevHash: head === null ? GENESIS_HASH : head.hash };
  return { ...chained, hash: computeHash(chained) };
}
