import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NatsEventConsumer } from "../../src/adapters/nats/nats-event-consumer.js";
import { runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { systemClock } from "../../src/adapters/system.js";
import { verifyChain } from "../../src/domain/hash-chain.js";
import { createUseCases } from "../../src/usecases/application.js";
import { streamHandlers } from "../../src/usecases/record-event.js";
import { RecordingLogger, eventId } from "../support/harness.js";

// Needs a running Docker daemon: "npm run test:integration". PostgreSQL 18 and NATS with JetStream run in containers; the
// service's own store and consumers run against them. The publishers (tenants, payments, markets, trading) are played here.

const NATS_IMAGE = "nats:2.15.2-alpine";
const T_1 = "018f3c1e-7a00-7000-8000-0000000000d1";
const T_2 = "018f3c1e-7a00-7000-8000-0000000000d2";

let postgres: StartedPostgreSqlContainer;
let broker: StartedTestContainer;
let pool: pg.Pool;
let store: PostgresStore;
let natsUrl: string;
let admin: NatsConnection;
let manager: JetStreamManager;
const logger = new RecordingLogger();
const useCases = () => createUseCases({ store, clock: systemClock, logger });

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:18").withDatabase("audit").start();
  pool = createPool(postgres.getConnectionUri(), 8);
  store = new PostgresStore(pool, logger);
  await runMigrations(pool, logger);
  broker = await new GenericContainer(NATS_IMAGE).withCommand(["--jetstream"]).withExposedPorts(4222).withWaitStrategy(Wait.forLogMessage(/Server is ready/)).start();
  natsUrl = `nats://${broker.getHost()}:${broker.getMappedPort(4222)}`;
  admin = await connect({ servers: natsUrl });
  manager = await jetstreamManager(admin);
}, 240_000);

afterAll(async () => {
  await admin?.drain();
  await pool?.end();
  await broker?.stop();
  await postgres?.stop();
});

async function eventually<T>(read: () => Promise<T | null | false>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A CloudEvent as another service publishes it. */
function envelope(id: string, type: string, tenantId: string, data: unknown, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ specversion: "1.0", id, type, source: "/chance/test", time: new Date().toISOString(), datacontenttype: "application/json", tenantid: tenantId, correlationid: "corr", causationid: "cause", data, ...extra }),
  );
}
const publish = (subject: string, data: Uint8Array): Promise<unknown> => jetstream(admin).publish(subject, data);
const entriesOf = async (tenantId: string) => (await useCases().listEntries(tenantId, { limit: 100 })).items.reverse();

describe("the four durable consumers over NATS and PostgreSQL", () => {
  it("starts while three of the four streams are missing, retries with a log line, and records the events once every stream exists", async () => {
    await manager.streams.add({ name: "TENANTS", subjects: ["chance.tenants.>"] });
    await publish(`chance.tenants.TenantCreated.${T_1}`, envelope(eventId(1), "si.chance.tenants.TenantCreated.v1", T_1, { tenantId: T_1, name: "Acme" }));
    await publish(`chance.tenants.TenantCreated.${T_1}`, envelope(eventId(1), "si.chance.tenants.TenantCreated.v1", T_1, { tenantId: T_1, name: "Acme" }));

    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      streamHandlers({ store, clock: systemClock, logger }).map(({ stream, handler }) => ({ stream: stream.stream, durable: stream.consumer, filterSubject: stream.subjects, handler })),
      { retryMs: 200, maxRetryMs: 500 },
    );
    consumer.start();
    try {
      await eventually(async () => (await entriesOf(T_1)).length === 1, "the TenantCreated entry");
      await eventually(() => Promise.resolve(logger.lines.some((line) => line.message === "The stream of a consumer does not exist yet; trying again")), "the missing-stream warning");

      for (const [name, subject] of [["PAYMENTS", "chance.payments.>"], ["MARKETS", "chance.markets.>"], ["TRADING", "chance.trading.>"]] as const) {
        await manager.streams.add({ name, subjects: [subject] });
      }
      await publish(`chance.payments.DepositSucceeded.${T_1}`, envelope(eventId(2), "si.chance.payments.DepositSucceeded.v1", T_1, { depositId: "dep-1", userId: "user-1", amount: 500 }));
      await publish(`chance.markets.MarketOpened.${T_1}`, envelope(eventId(3), "si.chance.markets.MarketOpened.v1", T_1, { marketId: "m-1", adminId: "admin-1" }));
      await publish(`chance.trading.TradeExecuted.${T_1}`, envelope(eventId(4), "si.chance.trading.TradeExecuted.v1", T_1, { marketId: "m-1", userId: "user-1" }));
      await publish(`chance.payments.DepositSucceeded.${T_1}`, envelope(eventId(2), "si.chance.payments.DepositSucceeded.v1", T_1, { depositId: "dep-1", userId: "user-1", amount: 500 }));
      // A type nobody has heard of, on a known stream.
      await publish(`chance.markets.WidgetRetired.${T_1}`, envelope(eventId(5), "si.chance.future.WidgetRetired.v9", T_1, ["anything", 1]));

      const log = await eventually(async () => {
        const entries = await entriesOf(T_1);
        return entries.length === 5 ? entries : null;
      }, "the five entries");
      expect(log.map((entry) => entry.eventId).sort()).toEqual([eventId(1), eventId(2), eventId(3), eventId(4), eventId(5)]);
      expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(verifyChain(log).valid).toBe(true);
      expect(await useCases().verifyChain(T_1)).toEqual({ valid: true, entries: 5, brokenAtSeq: null });
      expect(log.find((entry) => entry.eventId === eventId(3))).toMatchObject({ subject: "m-1", actor: "admin-1", correlationId: "corr", causationId: "cause" });
      expect(log.find((entry) => entry.eventId === eventId(5))?.payload).toEqual(["anything", 1]);

      // Acknowledged after the commit: nothing is left pending on any of the four durable consumers.
      for (const [stream, durable] of [["TENANTS", "audit-tenants"], ["PAYMENTS", "audit-payments"], ["MARKETS", "audit-markets"], ["TRADING", "audit-trading"]] as const) {
        await eventually(async () => {
          const info = await manager.consumers.info(stream, durable);
          return info.num_pending === 0 && info.num_ack_pending === 0;
        }, `${durable} to have nothing pending`);
      }
    } finally {
      await consumer.stop();
    }
  });

  it("terminates a message that is no valid envelope, goes on with the next one, and an event of a tenant that is created later is recorded after it", async () => {
    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      streamHandlers({ store, clock: systemClock, logger }).map(({ stream, handler }) => ({ stream: stream.stream, durable: stream.consumer, filterSubject: stream.subjects, handler })),
      { retryMs: 200, maxRetryMs: 500 },
    );
    // Not JSON, no tenant id, an id that is missing: terminated. Then an event of tenant 2, whose TenantCreated is published later.
    await publish(`chance.markets.Broken.${T_2}`, new TextEncoder().encode("{ this is not json"));
    await publish(`chance.markets.Broken.${T_2}`, new TextEncoder().encode(JSON.stringify({ specversion: "1.0", id: "x", type: "t", source: "s", data: { secret: "do-not-log" } })));
    await publish(`chance.payments.DepositSucceeded.${T_2}`, envelope(eventId(11), "si.chance.payments.DepositSucceeded.v1", T_2, { depositId: "dep-2", userId: "user-2" }));
    consumer.start();
    try {
      await eventually(() => Promise.resolve(logger.lines.some((line) => line.level === "info" && line.message?.includes("has no log yet"))), "the nak of the event of the tenant without a log");
      await publish(`chance.tenants.TenantCreated.${T_2}`, envelope(eventId(10), "si.chance.tenants.TenantCreated.v1", T_2, { tenantId: T_2, name: "Beta" }));

      const log = await eventually(async () => {
        const entries = await entriesOf(T_2);
        return entries.length === 2 ? entries : null;
      }, "both entries of tenant 2");
      expect(log.map((entry) => [entry.seq, entry.eventType])).toEqual([[1, "si.chance.tenants.TenantCreated.v1"], [2, "si.chance.payments.DepositSucceeded.v1"]]);
      expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
      expect(JSON.stringify(logger.lines)).not.toContain("do-not-log");
      expect((await entriesOf(T_1)).length).toBe(5);

      for (const [stream, durable] of [["MARKETS", "audit-markets"], ["PAYMENTS", "audit-payments"], ["TENANTS", "audit-tenants"]] as const) {
        await eventually(async () => {
          const info = await manager.consumers.info(stream, durable);
          return info.num_pending === 0 && info.num_ack_pending === 0;
        }, `${durable} to have nothing pending`);
      }
    } finally {
      await consumer.stop();
    }
  });

  it("a restarted service starts at its saved position: nothing is recorded twice", async () => {
    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      streamHandlers({ store, clock: systemClock, logger }).map(({ stream, handler }) => ({ stream: stream.stream, durable: stream.consumer, filterSubject: stream.subjects, handler })),
      { retryMs: 200, maxRetryMs: 500 },
    );
    consumer.start();
    try {
      await publish(`chance.trading.TradeExecuted.${T_1}`, envelope(eventId(20), "si.chance.trading.TradeExecuted.v1", T_1, { marketId: "m-1", userId: "user-9" }));
      const log = await eventually(async () => {
        const entries = await entriesOf(T_1);
        return entries.length === 6 ? entries : null;
      }, "the sixth entry");
      expect(log.at(-1)).toMatchObject({ seq: 6, eventId: eventId(20), actor: "user-9" });
      expect((await entriesOf(T_2)).length).toBe(2);
      expect(await useCases().verifyChain(T_1)).toEqual({ valid: true, entries: 6, brokenAtSeq: null });
    } finally {
      await consumer.stop();
    }
  });

  const newConsumer = (): NatsEventConsumer =>
    new NatsEventConsumer(
      natsUrl,
      logger,
      streamHandlers({ store, clock: systemClock, logger }).map(({ stream, handler }) => ({ stream: stream.stream, durable: stream.consumer, filterSubject: stream.subjects, handler })),
      { retryMs: 200, maxRetryMs: 500 },
    );
  const errorLines = (): number => logger.lines.filter((line) => line.level === "error").length;

  it("terminates an event with a lone surrogate in its id or its data (PostgreSQL could not keep it as it was) and records the next one; the chain stays valid", async () => {
    const before = (await entriesOf(T_1)).length;
    const errorsBefore = errorLines();
    const consumer = newConsumer();
    consumer.start();
    try {
      const type = "si.chance.markets.MarketOpened.v1";
      await publish(`chance.markets.MarketOpened.${T_1}`, envelope("ev-\ud800", type, T_1, { marketId: "m-1" }));
      await publish(`chance.markets.MarketOpened.${T_1}`, envelope(eventId(40), type, T_1, { marketId: "m-\udc00" }));
      await publish(`chance.markets.MarketOpened.${T_1}`, envelope(eventId(41), type, T_1, { "k\ud83d": 1 }));
      await publish(`chance.markets.MarketOpened.${T_1}`, envelope(eventId(42), type, T_1, { marketId: "m-ok" }));

      const log = await eventually(async () => {
        const entries = await entriesOf(T_1);
        return entries.length === before + 1 ? entries : null;
      }, "the one valid entry");
      expect(log.at(-1)).toMatchObject({ eventId: eventId(42), subject: "m-ok" });
      await eventually(() => Promise.resolve(errorLines() - errorsBefore === 3), "three terminated messages");
      expect(await useCases().verifyChain(T_1)).toEqual({ valid: true, entries: before + 1, brokenAtSeq: null });
      await eventually(async () => {
        const info = await manager.consumers.info("MARKETS", "audit-markets");
        return info.num_pending === 0 && info.num_ack_pending === 0;
      }, "audit-markets to have nothing pending");
    } finally {
      await consumer.stop();
    }
  });

  it("goes on recording after a stream was deleted and created again while the service runs", async () => {
    const consumer = newConsumer();
    consumer.start();
    try {
      const before = (await entriesOf(T_1)).length;
      await publish(`chance.trading.TradeExecuted.${T_1}`, envelope(eventId(50), "si.chance.trading.TradeExecuted.v1", T_1, { marketId: "m-1", userId: "user-1" }));
      await eventually(async () => (await entriesOf(T_1)).length === before + 1, "the entry before the stream is deleted");

      const warnings = (): number => logger.lines.filter((line) => line.level === "warn" && (line.fields as { stream?: string }).stream === "TRADING").length;
      const warnedBefore = warnings();
      await manager.streams.delete("TRADING");
      await eventually(() => Promise.resolve(warnings() > warnedBefore), "the consumer to notice that its stream is gone", 60_000);

      await manager.streams.add({ name: "TRADING", subjects: ["chance.trading.>"] });
      await publish(`chance.trading.TradeExecuted.${T_1}`, envelope(eventId(51), "si.chance.trading.TradeExecuted.v1", T_1, { marketId: "m-1", userId: "user-2" }));
      await eventually(async () => (await entriesOf(T_1)).length === before + 2, "the entry after the stream was created again", 60_000);
      expect(await useCases().verifyChain(T_1)).toEqual({ valid: true, entries: before + 2, brokenAtSeq: null });
    } finally {
      await consumer.stop();
    }
  }, 240_000);
});
