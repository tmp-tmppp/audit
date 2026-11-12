import type pg from "pg";
import type { AuditEntry, ChainHead } from "../../domain/audit-entry.js";
import type { JsonValue } from "../../domain/json.js";
import type { EntryQuery, EntryRepository, InboxRepository } from "../../usecases/ports.js";

type Queryable = Pick<pg.PoolClient, "query">;

// The shared tables are written with the prefix "shared."; the tenant's table unqualified, under the search path that
// useTenantSchema (tenant-scope.ts) set for the transaction. No statement here names a tenant schema, and none changes or
// removes a row of audit_entries or empties it: the log is only appended to and read (the trigger of the migration
// refuses a change, a removal and an emptying anyway, and tests/adapters/append-only.test.ts scans this folder for them).

/** The first key of the two-key advisory lock that serializes the appends of one tenant; the second key is the hash of the tenant id. */
export const APPEND_LOCK_NAMESPACE = 726_010;

export function inboxRepository(db: Queryable): InboxRepository {
  return {
    async markProcessed(consumer, event, at) {
      const result = await db.query(
        "INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (consumer, event_id) DO NOTHING",
        [consumer, event.id, event.type, at],
      );
      return result.rowCount === 1;
    },
  };
}

interface EntryRow {
  seq: string;
  event_id: string;
  event_type: string;
  source: string;
  subject: string;
  actor: string | null;
  occurred_at: Date;
  recorded_at: Date;
  correlation_id: string | null;
  causation_id: string | null;
  payload: JsonValue;
  prev_hash: string;
  hash: string;
}

const COLUMNS = "seq, event_id, event_type, source, subject, actor, occurred_at, recorded_at, correlation_id, causation_id, payload, prev_hash, hash";

// seq is a bigint, which pg returns as text; every seq the service assigns is far below 2^53.
const toEntry = (row: EntryRow): AuditEntry => ({
  seq: Number(row.seq),
  eventId: row.event_id,
  eventType: row.event_type,
  source: row.source,
  subject: row.subject,
  actor: row.actor,
  occurredAt: row.occurred_at,
  recordedAt: row.recorded_at,
  correlationId: row.correlation_id,
  causationId: row.causation_id,
  payload: row.payload,
  prevHash: row.prev_hash,
  hash: row.hash,
});

/** The log of the tenant whose schema is the search path of the connection, which must be inside a transaction. */
export function entryRepository(db: Queryable, tenantId: string): EntryRepository {
  return {
    async append(build) {
      // The lock belongs to the transaction: it is released by COMMIT or ROLLBACK, also when the connection breaks, so
      // a consumer that crashes cannot keep it. It is taken before the end of the chain is read, so the next append of
      // this tenant waits and then reads this entry as the end.
      await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPEND_LOCK_NAMESPACE, tenantId.toLowerCase()]);
      const last = await db.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_entries ORDER BY seq DESC LIMIT 1");
      const row = last.rows[0];
      const head: ChainHead | null = row === undefined ? null : { seq: Number(row.seq), hash: row.hash };
      const entry = build(head);
      const result = await db.query(
        `INSERT INTO audit_entries (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          entry.seq,
          entry.eventId,
          entry.eventType,
          entry.source,
          entry.subject,
          entry.actor,
          entry.occurredAt,
          entry.recordedAt,
          entry.correlationId,
          entry.causationId,
          JSON.stringify(entry.payload),
          entry.prevHash,
          entry.hash,
        ],
      );
      return result.rowCount === 1 ? entry : null;
    },

    async list(query: EntryQuery) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: (placeholder: string) => string, value: unknown): void => {
        params.push(value);
        where.push(clause(`$${params.length}`));
      };
      if (query.types.length > 0) add((p) => `event_type = ANY(${p}::text[])`, query.types);
      if (query.from !== null) add((p) => `occurred_at >= ${p}`, query.from);
      if (query.to !== null) add((p) => `occurred_at <= ${p}`, query.to);
      if (query.correlationId !== null) add((p) => `correlation_id = ${p}`, query.correlationId);
      if (query.actor !== null) add((p) => `actor = ${p}`, query.actor);
      if (query.subject !== null) add((p) => `subject = ${p}`, query.subject);
      if (query.before !== null) add((p) => `seq < ${p}`, query.before);
      params.push(query.limit);
      const sql = `SELECT ${COLUMNS} FROM audit_entries ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT $${params.length}`;
      return (await db.query<EntryRow>(sql, params)).rows.map(toEntry);
    },

    async readChain(afterSeq, limit) {
      const result = await db.query<EntryRow>(`SELECT ${COLUMNS} FROM audit_entries WHERE seq > $1 ORDER BY seq LIMIT $2`, [afterSeq, limit]);
      return result.rows.map(toEntry);
    },
  };
}
