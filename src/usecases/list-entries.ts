import type { AuditEntry } from "../domain/audit-entry.js";
import { ValidationFailed } from "./errors.js";
import type { FieldError } from "./errors.js";
import type { EntryQuery, UseCaseDeps } from "./ports.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_TYPES = 20;
const TEXT_MAX_LENGTH = 255;

/** The filters and the paging of a list, as the caller sent them (not yet checked). */
export interface ListInput {
  /** Event types; each item may be a comma-separated list. */
  type?: readonly string[];
  /** ISO 8601 time with a zone. */
  from?: string;
  to?: string;
  correlationId?: string;
  actor?: string;
  subject?: string;
  limit?: number;
  cursor?: string;
}

export interface EntryPage {
  /** Newest first. */
  items: AuditEntry[];
  /** Pass it as the cursor of the next call for the next, older page; null on the last page. */
  nextCursor: string | null;
}

// The cursor is a position in seq: "the entries below this number". Opaque to the caller, so that its shape can change.
const CURSOR_PATTERN = /^[1-9]\d{0,15}$/;

export function encodeCursor(seq: number): string {
  return Buffer.from(`seq:${seq}`, "utf8").toString("base64url");
}

/** The seq a cursor stands for, or null when it is not a cursor this service made. */
export function decodeCursor(cursor: string): number | null {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  // Decoding is lenient (characters outside the alphabet are skipped): only the exact text this service made is accepted.
  if (!text.startsWith("seq:") || Buffer.from(text, "utf8").toString("base64url") !== cursor) return null;
  const digits = text.slice(4);
  if (!CURSOR_PATTERN.test(digits)) return null;
  const seq = Number(digits);
  return Number.isSafeInteger(seq) ? seq : null;
}

function parseTime(field: string, value: string | undefined, errors: FieldError[]): Date | null {
  if (value === undefined) return null;
  const time = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value) ? new Date(value) : null;
  if (time === null || Number.isNaN(time.getTime())) {
    errors.push({ field, message: "must be an ISO 8601 date-time with a zone, for example 2026-11-01T10:00:00Z" });
    return null;
  }
  return time;
}

function parseText(field: string, value: string | undefined, errors: FieldError[]): string | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > TEXT_MAX_LENGTH) {
    errors.push({ field, message: `must be 1 to ${TEXT_MAX_LENGTH} characters` });
    return null;
  }
  return value;
}

/** The event types of the filter: the items split at commas, trimmed, without empty parts and repeats. */
function parseTypes(input: readonly string[] | undefined, errors: FieldError[]): string[] {
  const types = [...new Set((input ?? []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter((item) => item !== ""))];
  if (types.length > MAX_TYPES) errors.push({ field: "type", message: `at most ${MAX_TYPES} event types` });
  if (types.some((type) => type.length > TEXT_MAX_LENGTH)) errors.push({ field: "type", message: `each event type is at most ${TEXT_MAX_LENGTH} characters` });
  return types;
}

/**
 * A page of the tenant's log, newest first, narrowed by every filter that is given. The tenant is the caller's own,
 * taken from the verified token by the web layer: no input names one. The page holds at most `limit` entries (1 to 100,
 * 50 when absent); `nextCursor` is set when older entries follow. A bad filter, limit or cursor is a ValidationFailed
 * naming the fields; a tenant without a log yet is TenantNotReady.
 */
export async function listEntries(deps: UseCaseDeps, tenantId: string, input: ListInput = {}): Promise<EntryPage> {
  const errors: FieldError[] = [];
  const types = parseTypes(input.type, errors);
  const from = parseTime("from", input.from, errors);
  const to = parseTime("to", input.to, errors);
  if (from !== null && to !== null && from.getTime() > to.getTime()) errors.push({ field: "from", message: "must not be after to" });
  const correlationId = parseText("correlationId", input.correlationId, errors);
  const actor = parseText("actor", input.actor, errors);
  const subject = parseText("subject", input.subject, errors);
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) errors.push({ field: "limit", message: `must be a whole number from 1 to ${MAX_LIMIT}` });
  let before: number | null = null;
  if (input.cursor !== undefined) {
    before = decodeCursor(input.cursor);
    if (before === null) errors.push({ field: "cursor", message: "is not a cursor returned by this API" });
  }
  if (errors.length > 0) throw new ValidationFailed(errors);

  const query: EntryQuery = { types, from, to, correlationId, actor, subject, before, limit: limit + 1 };
  const found = await deps.store.tenantTransaction(tenantId, (repositories) => repositories.entries.list(query));
  const items = found.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: found.length > limit && last !== undefined ? encodeCursor(last.seq) : null };
}
