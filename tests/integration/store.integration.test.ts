import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { runMigrations, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { verifyChain } from "../../src/domain/hash-chain.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { createUseCases } from "../../src/usecases/application.js";
import type { ListInput } from "../../src/usecases/list-entries.js";
import type { Store, UseCaseDeps } from "../../src/usecases/ports.js";
import { recordEventHandler } from "../../src/usecases/record-event.js";
import { verifyAuditChain } from "../../src/usecases/verify-chain.js";
import { MARKET_ID, RecordingLogger, TestClock, cloudEvent, eventId, receivedEvent, tenantCreated } from "../support/harness.js";

// Event ids are unique across tenants, as the publishers make them (UUIDv7): the inbox is keyed by consumer and event id.
// Needs a running Docker daemon: "npm run test:integration". The store, the repositories and the use cases run their real
// SQL against PostgreSQL 18; the memory store is fed the same events and has to answer the same.

const T_A = "018f3c1e-7a00-7000-8000-0000000000a1";
const T_B = "018f3c1e-7a00-7000-8000-0000000000a2";
const T_C = "018f3c1e-7a00-7000-8000-0000000000a3";
const T_D = "018f3c1e-7a00-7000-8000-0000000000a4";
const T_E = "018f3c1e-7a00-7000-8000-0000000000a5";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
const logger = new RecordingLogger();
const clock = new TestClock();
const depsOf = (over: Store): UseCaseDeps => ({ store: over, clock, logger });

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("audit").start();
  pool = createPool(container.getConnectionUri(), 8);
  store = new PostgresStore(pool, logger);
  await runMigrations(pool, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const schemaExists = async (tenantId: string): Promise<boolean> =>
  ((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [tenantSchemaName(tenantId)])).rowCount ?? 0) > 0;
const inboxRows = async (consumer: string, id: string): Promise<number> =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shared.inbox WHERE consumer = $1 AND event_id = $2", [consumer, id])).rows[0]?.n ?? 0;

describe("TenantCreated and tenant schemas", () => {
  it("TenantCreated creates and registers the schema in the transaction of its entry, and is the first entry", async () => {
    const handler = recordEventHandler(depsOf(store), "audit-tenants");
    expect(await schemaExists(T_A)).toBe(false);
    await handler(receivedEvent({ ...tenantCreated(T_A, 1) }));

    expect(await schemaExists(T_A)).toBe(true);
    expect((await pool.query("SELECT schema_name FROM shared.tenant_registry WHERE tenant_id = $1", [T_A])).rows).toEqual([{ schema_name: tenantSchemaName(T_A) }]);
    const page = await createUseCases(depsOf(store)).listEntries(T_A, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ seq: 1, eventId: eventId(1), eventType: "si.chance.tenants.TenantCreated.v1", subject: T_A, prevHash: "0".repeat(64) });
    expect(await inboxRows("audit-tenants", eventId(1))).toBe(1);
  });

  it("an event of a tenant without a schema is TenantNotReady, and leaves no inbox row and no schema", async () => {
    const handler = recordEventHandler(depsOf(store), "audit-markets");
    await expect(handler(receivedEvent({ id: eventId(2), tenantid: T_B }))).rejects.toBeInstanceOf(TenantNotReady);
    expect(await inboxRows("audit-markets", eventId(2))).toBe(0);
    expect(await schemaExists(T_B)).toBe(false);
  });

  it("a transaction that fails after the provisioning leaves no schema and no registry row behind", async () => {
    await expect(
      store.tenantTransaction(
        T_C,
        () => {
          throw new Error("the entry could not be written");
        },
        { provisionAt: clock.now() },
      ),
    ).rejects.toThrow("could not be written");
    expect(await schemaExists(T_C)).toBe(false);
    expect((await pool.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [T_C])).rowCount).toBe(0);
    await expect(store.tenantTransaction(T_C, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("refuses an id that is no UUID before any statement touches a schema", async () => {
    await expect(store.tenantTransaction("x'; DROP SCHEMA shared; --", () => Promise.resolve(1))).rejects.toThrow("UUID");
    expect(((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'shared'")).rowCount ?? 0) > 0).toBe(true);
  });

  it("the search path is local to the transaction: the connection is clean afterwards", async () => {
    await store.tenantTransaction(T_A, () => Promise.resolve(undefined));
    const client = await pool.connect();
    try {
      expect((await client.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path).not.toContain("tenant_");
    } finally {
      client.release();
    }
  });
});

describe("appending", () => {
  it("a redelivery changes nothing, and an event id another consumer recorded already is not recorded twice (no gap in seq)", async () => {
    const tenants = recordEventHandler(depsOf(store), "audit-tenants");
    const payments = recordEventHandler(depsOf(store), "audit-payments");
    await tenants(receivedEvent({ ...tenantCreated(T_D, 40) }));
    await payments(receivedEvent({ id: eventId(30), tenantid: T_D }));
    await payments(receivedEvent({ id: eventId(30), tenantid: T_D }));
    await tenants(receivedEvent({ id: eventId(30), tenantid: T_D }));
    await payments(receivedEvent({ id: eventId(31), tenantid: T_D }));

    const log = (await createUseCases(depsOf(store)).listEntries(T_D, {})).items.reverse();
    expect(log.map((entry) => [entry.seq, entry.eventId])).toEqual([[1, eventId(40)], [2, eventId(30)], [3, eventId(31)]]);
    expect(verifyChain(log).valid).toBe(true);
  });

  it("thirty events recorded at once by three consumers are numbered 1 to 31 without a gap and chain correctly", async () => {
    const consumers = ["audit-tenants", "audit-payments", "audit-markets"].map((name) => recordEventHandler(depsOf(store), name));
    await consumers[0]?.(receivedEvent({ ...tenantCreated(T_E, 60) }));
    await Promise.all(
      Array.from({ length: 30 }, async (_, n) => {
        await consumers[n % 3]?.(receivedEvent({ id: eventId(100 + n), tenantid: T_E, data: { marketId: `m-${n}` } }));
      }),
    );

    const log = (await createUseCases(depsOf(store)).listEntries(T_E, { limit: 100 })).items.reverse();
    expect(log.map((entry) => entry.seq)).toEqual(Array.from({ length: 31 }, (_, n) => n + 1));
    expect(verifyChain(log)).toEqual({ valid: true, entries: 31, brokenAtSeq: null });
    expect(await verifyAuditChain(depsOf(store), T_E, 7)).toEqual({ valid: true, entries: 31, brokenAtSeq: null });
  });
});

describe("the PostgreSQL store and the memory store answer the same", () => {
  const T_P = "018f3c1e-7a00-7000-8000-0000000000b1";
  const T_Q = "018f3c1e-7a00-7000-8000-0000000000b2";
  const queries: ListInput[] = [
    {},
    { limit: 3 },
    { type: ["si.chance.markets.MarketOpened.v1"] },
    { type: ["si.chance.markets.MarketOpened.v1,si.chance.trading.TradeExecuted.v1"] },
    { from: "2026-11-01T12:00:00Z", to: "2026-11-01T14:00:00Z" },
    { correlationId: "c-2" },
    { actor: "user-1" },
    { subject: MARKET_ID },
    { type: ["si.chance.markets.MarketOpened.v1"], actor: "admin-1", from: "2026-11-01T11:00:00Z" },
  ];

  it("lists, pages and verifies identically, hashes included", async () => {
    const memory = new MemoryStore();
    const stores: Store[] = [store, memory];
    const at = (hour: number): string => `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const events = [
      tenantCreated(T_P, 200),
      cloudEvent({ id: eventId(201), tenantid: T_P, time: at(11), correlationid: "c-1", data: { marketId: MARKET_ID, adminId: "admin-1" } }),
      cloudEvent({ id: eventId(202), tenantid: T_P, type: "si.chance.payments.DepositSucceeded.v1", time: at(12), correlationid: "c-2", data: { depositId: "d-1", userId: "user-1" } }),
      cloudEvent({ id: eventId(203), tenantid: T_P, type: "si.chance.trading.TradeExecuted.v1", time: at(13), correlationid: "c-2", data: { marketId: MARKET_ID, userId: "user-1", text: "Čšž \u{1F600} \\ \"quoted\"", big: 12345678901, float: 0.1, nested: { b: [1, { z: null, a: true }], a: "x" } } }),
      cloudEvent({ id: eventId(204), tenantid: T_P, type: "si.chance.future.WidgetRetired.v9", time: at(14), correlationid: undefined, causationid: undefined, data: [1, "two"] }),
      cloudEvent({ id: eventId(205), tenantid: T_P, time: at(15), data: {} }),
      cloudEvent({ id: eventId(206), tenantid: T_P }),
    ];
    for (const target of stores) {
      const handler = recordEventHandler(depsOf(target), "audit-parity");
      for (const event of events) await handler(receivedEvent(event));
    }
    const [real, mirror] = stores.map((target) => createUseCases(depsOf(target)));
    for (const query of queries) expect(await real?.listEntries(T_P, query), JSON.stringify(query)).toEqual(await mirror?.listEntries(T_P, query));
    const pagesOf = async (cases: ReturnType<typeof createUseCases> | undefined) => {
      const pages: number[][] = [];
      let cursor: string | undefined;
      do {
        const page = await cases?.listEntries(T_P, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        pages.push(page?.items.map((entry) => entry.seq) ?? []);
        cursor = page?.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return pages;
    };
    expect(await pagesOf(real)).toEqual([[7, 6], [5, 4], [3, 2], [1]]);
    expect(await pagesOf(mirror)).toEqual([[7, 6], [5, 4], [3, 2], [1]]);
    expect(await real?.verifyChain(T_P)).toEqual({ valid: true, entries: 7, brokenAtSeq: null });
    expect(await mirror?.verifyChain(T_P)).toEqual({ valid: true, entries: 7, brokenAtSeq: null });
  });

  it("never mixes tenants: another tenant's log has its own entries and its own chain", async () => {
    await recordEventHandler(depsOf(store), "audit-parity")(receivedEvent({ ...tenantCreated(T_Q, 400) }));
    const own = (await createUseCases(depsOf(store)).listEntries(T_Q, {})).items;
    expect(own.map((entry) => entry.eventId)).toEqual([eventId(400)]);
    expect((await createUseCases(depsOf(store)).listEntries(T_P, { actor: "user-1" })).items.every((entry) => entry.actor === "user-1")).toBe(true);
  });
});

describe("verification against a log that was changed behind the service's back", () => {
  it("finds a payload that was changed by the database owner, at the changed entry, and the entries after it still count", async () => {
    const tenant = "018f3c1e-7a00-7000-8000-0000000000c1";
    const handler = recordEventHandler(depsOf(store), "audit-tamper");
    await handler(receivedEvent({ ...tenantCreated(tenant, 500) }));
    for (let n = 1; n <= 8; n += 1) await handler(receivedEvent({ id: eventId(500 + n), tenantid: tenant, data: { marketId: `m-${n}`, n } }));
    expect(await verifyAuditChain(depsOf(store), tenant, 4)).toEqual({ valid: true, entries: 9, brokenAtSeq: null });

    const schema = `"${tenantSchemaName(tenant)}"`;
    await pool.query(`ALTER TABLE ${schema}.audit_entries DISABLE TRIGGER audit_entries_append_only`);
    try {
      await pool.query(`UPDATE ${schema}.audit_entries SET payload = '{"marketId": "m-4", "n": 40}'::jsonb WHERE seq = 5`);
      expect(await verifyAuditChain(depsOf(store), tenant, 4)).toEqual({ valid: false, entries: 9, brokenAtSeq: 5 });
      await pool.query(`DELETE FROM ${schema}.audit_entries WHERE seq = 7`);
      expect(await verifyAuditChain(depsOf(store), tenant, 4)).toEqual({ valid: false, entries: 8, brokenAtSeq: 5 });
    } finally {
      await pool.query(`ALTER TABLE ${schema}.audit_entries ENABLE TRIGGER audit_entries_append_only`);
    }
  });
});
