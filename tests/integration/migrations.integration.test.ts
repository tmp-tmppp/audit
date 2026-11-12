import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEntry } from "../../src/domain/audit-entry.js";
import type { AuditEntry, ChainHead } from "../../src/domain/audit-entry.js";
import { GENESIS_HASH, verifyChain } from "../../src/domain/hash-chain.js";
import { migrateTenantSchema, runMigrations, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { createPool } from "../../src/adapters/postgres/postgres-store.js";
import { EVENT_TIME, MARKET_ID, RecordingLogger, eventId, receivedEvent } from "../support/harness.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test".

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const logger = new RecordingLogger();
const now = new Date("2026-11-01T10:00:00.000Z");
const T1 = "00000000-0000-7000-8000-000000000001";
const T2 = "00000000-0000-7000-8000-000000000002";
const T3 = "00000000-0000-7000-8000-000000000003";
const T4 = "00000000-0000-7000-8000-000000000004";
const T5 = "00000000-0000-7000-8000-000000000005";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("audit").start();
  pool = createPool(container.getConnectionUri(), 8);
  await runMigrations(pool, logger);
  for (const tenant of [T1, T2, T3, T4, T5]) await migrateTenantSchema(pool, tenant, now, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const columns = async (schema: string, table: string): Promise<string[]> =>
  (
    await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [schema, table],
    )
  ).rows.map((row) => row.column_name);

/** Runs statements with the tenant schema as the search path, like the tenant migrations do. */
async function inTenant<T>(tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${tenantSchemaName(tenantId)}"`);
    return await work(client);
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
}

/** The SQLSTATE code and the message of the error a statement raises, or null when it succeeds. */
const failure = async (promise: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code: code ?? "no code", message };
  }
};

const INSERT = `INSERT INTO audit_entries
  (seq, event_id, event_type, source, subject, actor, occurred_at, recorded_at, correlation_id, causation_id, payload, prev_hash, hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`;

const insert = (client: pg.PoolClient, entry: AuditEntry): Promise<unknown> =>
  client.query(INSERT, [
    entry.seq, entry.eventId, entry.eventType, entry.source, entry.subject, entry.actor, entry.occurredAt, entry.recordedAt,
    entry.correlationId, entry.causationId, JSON.stringify(entry.payload), entry.prevHash, entry.hash,
  ]);

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
  payload: AuditEntry["payload"];
  prev_hash: string;
  hash: string;
}

/** The whole log of a tenant in order of seq, as the verification will read it. */
async function readLog(client: pg.PoolClient): Promise<AuditEntry[]> {
  const result = await client.query<EntryRow>("SELECT * FROM audit_entries ORDER BY seq");
  return result.rows.map((row) => ({
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
  }));
}

/** `count` entries chained as the consumer will append them; `payload` shapes the data of each. */
function entries(count: number, payload: (n: number) => Record<string, unknown> = (n) => ({ marketId: MARKET_ID, n })): AuditEntry[] {
  const log: AuditEntry[] = [];
  let head: ChainHead | null = null;
  for (let n = 1; n <= count; n += 1) {
    const entry = buildEntry(receivedEvent({ id: eventId(n), time: new Date(EVENT_TIME.getTime() + n * 1000).toISOString(), data: payload(n) }), new Date(EVENT_TIME.getTime() + n * 1000 + 5), head);
    log.push(entry);
    head = { seq: entry.seq, hash: entry.hash };
  }
  return log;
}

describe("the migrations", () => {
  it("create the shared schema with the registry and the inbox, and no outbox", async () => {
    expect(await columns("shared", "tenant_registry")).toEqual(["tenant_id", "schema_name", "created_at"]);
    expect(await columns("shared", "inbox")).toEqual(["consumer", "event_id", "event_type", "processed_at"]);
    expect(await columns("shared", "outbox")).toEqual([]);
    expect(await columns("shared", "schema_migrations")).toEqual(["version", "checksum", "applied_at"]);
  });

  it("create the same audit_entries table in every tenant schema, with the indexes of the filters", async () => {
    const expected = ["seq", "event_id", "event_type", "source", "subject", "actor", "occurred_at", "recorded_at", "correlation_id", "causation_id", "payload", "prev_hash", "hash"];
    for (const tenant of [T1, T2, T3, T4, T5]) expect(await columns(tenantSchemaName(tenant), "audit_entries")).toEqual(expected);
    const indexes = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'audit_entries' ORDER BY indexname", [tenantSchemaName(T1)]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "audit_entries_actor_idx",
      "audit_entries_correlation_idx",
      "audit_entries_event_id_key",
      "audit_entries_occurred_idx",
      "audit_entries_pkey",
      "audit_entries_subject_idx",
      "audit_entries_type_idx",
    ]);
  });

  it("keep a tenant's rows out of the other tenants' tables", async () => {
    await inTenant(T1, (client) => insert(client, entries(1)[0] as AuditEntry));
    expect(await inTenant(T2, async (client) => (await client.query("SELECT 1 FROM audit_entries")).rowCount)).toBe(0);
    expect(await inTenant(T1, async (client) => (await client.query("SELECT 1 FROM audit_entries")).rowCount)).toBe(1);
  });
});

describe("the constraints of audit_entries", () => {
  const first = entries(2)[0] as AuditEntry;
  const second = entries(2)[1] as AuditEntry;
  const clash = (overrides: Partial<AuditEntry>): AuditEntry => ({ ...(entries(3)[2] as AuditEntry), ...overrides });

  it("refuse a second entry with a seq or an event id that is taken (the idempotence and the gapless numbering rest on them)", async () => {
    await inTenant(T1, async (client) => {
      // T1 holds entry 1 from the test above.
      expect((await failure(insert(client, clash({ seq: 1, eventId: "another", prevHash: GENESIS_HASH }))))?.code).toBe("23505");
      expect((await failure(insert(client, clash({ seq: 2, eventId: first.eventId }))))?.code).toBe("23505");
      expect(await failure(insert(client, second))).toBeNull();
    });
  });

  it("let only the first entry start from the genesis hash", async () => {
    await inTenant(T2, async (client) => {
      expect((await failure(insert(client, { ...first, prevHash: "ab".repeat(32) })))?.code).toBe("23514");
      expect((await failure(insert(client, { ...second, prevHash: GENESIS_HASH })))?.code).toBe("23514");
      expect((await failure(insert(client, { ...first, seq: 0 })))?.code).toBe("23514");
      expect((await client.query("SELECT 1 FROM audit_entries")).rowCount).toBe(0);
    });
  });

  it("refuse a hash that is not 64 lower-case hex digits, and texts that are empty or too long", async () => {
    await inTenant(T2, async (client) => {
      for (const bad of [{ hash: "abc" }, { hash: "AB".repeat(32) }, { prevHash: "zz".repeat(32) }, { eventType: "" }, { source: "x".repeat(256) }, { subject: "" }, { actor: "" }, { correlationId: "x".repeat(256) }, { eventId: "" }]) {
        const result = await failure(insert(client, { ...first, ...bad }));
        expect(result?.code, JSON.stringify(Object.keys(bad))).toBe("23514");
      }
      expect(await failure(insert(client, { ...first, actor: null, correlationId: null, causationId: null }))).toBeNull();
    });
  });

  it("refuse a null in a column that must have a value", async () => {
    await inTenant(T3, async (client) => {
      // A JSON null as the payload is a value (the text "null"); only a missing one is refused.
      for (const bad of [{ occurredAt: null }, { subject: null }, { hash: null }, { eventType: null }]) {
        expect((await failure(insert(client, { ...first, ...bad } as unknown as AuditEntry)))?.code, JSON.stringify(bad)).toBe("23502");
      }
    });
  });
});

describe("append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE with an error that says so, also for statements that touch no row, and leaves the rows as they were", async () => {
    const log = entries(3);
    await inTenant(T5, async (client) => {
      for (const entry of log) await insert(client, entry);
      const statements = [
        ["UPDATE", "UPDATE audit_entries SET payload = '{}'::jsonb WHERE seq = 1"],
        ["UPDATE", "UPDATE audit_entries SET actor = 'mallory'"],
        ["UPDATE", "UPDATE audit_entries SET hash = hash WHERE false"],
        ["DELETE", "DELETE FROM audit_entries WHERE seq = 3"],
        ["DELETE", "DELETE FROM audit_entries"],
        ["DELETE", "DELETE FROM audit_entries WHERE false"],
        ["TRUNCATE", "TRUNCATE audit_entries"],
      ] as const;
      for (const [operation, sql] of statements) {
        const result = await failure(client.query(sql));
        expect(result?.code, sql).toBe("23001");
        expect(result?.message, sql).toBe(`audit_entries is append-only: ${operation} is not allowed`);
      }
      expect((await readLog(client)).map((entry) => entry.hash)).toEqual(log.map((entry) => entry.hash));
    });
  });

  it("refuses them in every tenant schema, and never in a transaction that later rolls back, either", async () => {
    await inTenant(T1, async (client) => {
      expect((await failure(client.query("DELETE FROM audit_entries")))?.code).toBe("23001");
      await client.query("BEGIN");
      expect((await failure(client.query("UPDATE audit_entries SET subject = 'x'")))?.code).toBe("23001");
      await client.query("ROLLBACK");
    });
  });

  it("still takes new entries", async () => {
    const log = entries(4);
    await inTenant(T5, async (client) => {
      expect(await failure(insert(client, log[3] as AuditEntry))).toBeNull();
      expect((await readLog(client)).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    });
  });
});

describe("the hash chain through the database", () => {
  const awkward = (n: number): Record<string, unknown> => ({
    marketId: MARKET_ID,
    userId: `user-${n}`,
    question: "Will čokolada ☕ cost more than \"2€\"? 😀",
    // PostgreSQL jsonb sorts the keys by length and then by text, and drops the spaces: the chain does not depend on that.
    zzz: 1,
    a: { nested: [1, 2.5, -0.125, 1e21, null, true, "x"], empty: {}, list: [] },
    longer_key_name: { b: 2, a: 1 },
    big: 123456789012345,
    n,
  });

  it("reads back exactly what was written, so that the stored hashes verify (jsonb, timestamptz and bigint round trip)", async () => {
    const log = entries(12, awkward);
    await inTenant(T3, async (client) => {
      for (const entry of log) await insert(client, entry);
      const stored = await readLog(client);
      expect(stored.map((entry) => entry.payload)).toEqual(log.map((entry) => entry.payload));
      expect(stored.map((entry) => entry.occurredAt.getTime())).toEqual(log.map((entry) => entry.occurredAt.getTime()));
      expect(verifyChain(stored)).toEqual({ valid: true, entries: 12, brokenAtSeq: null });
    });
  });

  it("shows a change that only someone with more rights than the service can make (the trigger switched off)", async () => {
    const log = entries(6);
    await inTenant(T4, async (client) => {
      for (const entry of log) await insert(client, entry);
      expect(verifyChain(await readLog(client)).valid).toBe(true);

      await client.query("ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_append_only");
      try {
        await client.query("UPDATE audit_entries SET payload = jsonb_set(payload, '{n}', '999') WHERE seq = 3");
        expect(verifyChain(await readLog(client))).toEqual({ valid: false, entries: 6, brokenAtSeq: 3 });
        await client.query("DELETE FROM audit_entries WHERE seq = 5");
        expect(verifyChain(await readLog(client))).toEqual({ valid: false, entries: 5, brokenAtSeq: 3 });
        await client.query("DELETE FROM audit_entries WHERE seq = 3");
        expect(verifyChain(await readLog(client))).toEqual({ valid: false, entries: 4, brokenAtSeq: 4 });
      } finally {
        await client.query("ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_append_only");
      }
      expect((await failure(client.query("DELETE FROM audit_entries")))?.code).toBe("23001");
    });
  });
});
