import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { GENESIS_HASH, verifyChain } from "../../src/domain/hash-chain.js";
import { CONSUMED_STREAMS } from "../../src/domain/streams.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import type { Store } from "../../src/usecases/ports.js";
import { recordEventHandler, streamHandlers } from "../../src/usecases/record-event.js";
import { EVENT_TIME, MARKET_ID, TENANT_A, TENANT_B, cloudEvent, createCore, eventId, receivedEvent, tenantCreated } from "../support/harness.js";

const readAll = async (core: ReturnType<typeof createCore>, tenant: string) => (await core.useCases.listEntries(tenant, { limit: 100 })).items.reverse();

describe("recordEventHandler", () => {
  it("TenantCreated creates the tenant's log and is its first entry, chained to the genesis hash", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));

    const [first, ...rest] = await readAll(core, TENANT_A);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      seq: 1,
      eventId: eventId(1),
      eventType: "si.chance.tenants.TenantCreated.v1",
      source: "/chance/tenants",
      subject: TENANT_A,
      actor: null,
      prevHash: GENESIS_HASH,
      payload: { tenantId: TENANT_A, name: "Acme" },
    });
    expect(first?.occurredAt).toEqual(EVENT_TIME);
    expect(core.events.lines.some((line) => line.message === "Recorded an event" && (line.fields as { seq: number }).seq === 1)).toBe(true);
  });

  it("records the events that follow, in order, as a chain without gaps", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    core.clock.advanceMs(1000);
    await core.record(cloudEvent({ id: eventId(2), data: { marketId: MARKET_ID, adminId: "admin-1" } }));
    await core.record(cloudEvent({ id: eventId(3), type: "si.chance.payments.DepositSucceeded.v1", source: "/chance/payments", data: { depositId: "dep-1", userId: "user-1", amount: 500 } }));

    const entries = await readAll(core, TENANT_A);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[1]).toMatchObject({ subject: MARKET_ID, actor: "admin-1", correlationId: "corr-1", causationId: "req-1" });
    expect(entries[2]).toMatchObject({ subject: "dep-1", actor: "user-1" });
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(entries[2]?.prevHash).toBe(entries[1]?.hash);
    expect(entries[1]?.recordedAt.getTime()).toBe(EVENT_TIME.getTime() + 1000);
    expect(verifyChain(entries)).toEqual({ valid: true, entries: 3, brokenAtSeq: null });
  });

  it("records an event type it does not know, with whatever its data holds", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    await core.record(cloudEvent({ id: eventId(2), type: "si.chance.future.WidgetRetired.v9", source: "/chance/future", data: [1, "x", { y: null }] }));

    const [, entry] = await readAll(core, TENANT_A);
    expect(entry).toMatchObject({ eventType: "si.chance.future.WidgetRetired.v9", subject: TENANT_A, actor: null, payload: [1, "x", { y: null }] });
  });

  it("a redelivery changes nothing: the inbox of the consumer has the event already", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    await core.record(cloudEvent({ id: eventId(2) }));
    await core.record(cloudEvent({ id: eventId(2) }));
    await core.record(tenantCreated(TENANT_A, 1));

    expect((await readAll(core, TENANT_A)).map((entry) => entry.seq)).toEqual([1, 2]);
    // The redelivery is acknowledged without a trace in the log of entries, but not without a line in the service log.
    const skipped = core.events.lines.filter((line) => line.message?.startsWith("An event with this id came in before on this consumer"));
    expect(skipped.map((line) => (line.fields as { eventId: string }).eventId)).toEqual([eventId(2), eventId(1)]);
  });

  it("an event id that another consumer recorded already is not recorded twice, and leaves no gap in the numbers", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    await core.record(cloudEvent({ id: eventId(2) }));
    const other = recordEventHandler(core.deps, "audit-other");
    await other(receivedEvent({ id: eventId(2) }));
    await core.record(cloudEvent({ id: eventId(3) }));

    const entries = await readAll(core, TENANT_A);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(verifyChain(entries).valid).toBe(true);
    expect(core.events.lines.some((line) => line.level === "warn" && line.message?.includes("recorded already"))).toBe(true);
  });

  it("an event of a tenant that has no log yet is TenantNotReady and leaves nothing behind, the inbox included", async () => {
    const core = createCore();
    await expect(core.record(cloudEvent({ id: eventId(2) }))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(core.useCases.listEntries(TENANT_A, {})).rejects.toBeInstanceOf(TenantNotReady);

    // Once TenantCreated has been processed, the same message is recorded.
    await core.record(tenantCreated(TENANT_A, 1));
    await core.record(cloudEvent({ id: eventId(2) }));
    expect((await readAll(core, TENANT_A)).map((entry) => entry.eventId)).toEqual([eventId(1), eventId(2)]);
  });

  it("keeps the tenants apart: each has its own numbers and chain", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    await core.record(tenantCreated(TENANT_B, 2));
    await core.record(cloudEvent({ id: eventId(3), tenantid: TENANT_A }));
    await core.record(cloudEvent({ id: eventId(5), tenantid: TENANT_B }));
    await core.record(cloudEvent({ id: eventId(4), tenantid: TENANT_B, data: { marketId: "m-b" } }));

    const a = await readAll(core, TENANT_A);
    const b = await readAll(core, TENANT_B);
    expect(a.map((entry) => [entry.seq, entry.eventId])).toEqual([[1, eventId(1)], [2, eventId(3)]]);
    expect(b.map((entry) => [entry.seq, entry.eventId])).toEqual([[1, eventId(2)], [2, eventId(5)], [3, eventId(4)]]);
    expect(a[0]?.hash).not.toBe(b[0]?.hash);
    expect(verifyChain(a).valid && verifyChain(b).valid).toBe(true);
  });

  it("twenty events recorded at the same time are numbered 1 to 20 without a gap and chain correctly", async () => {
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    await Promise.all(Array.from({ length: 20 }, (_, n) => core.record(cloudEvent({ id: eventId(100 + n), data: { marketId: `m-${n}` } }))));

    const entries = await readAll(core, TENANT_A);
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 21 }, (_, n) => n + 1));
    expect(verifyChain(entries)).toEqual({ valid: true, entries: 21, brokenAtSeq: null });
  });

  it("a failure inside the transaction records neither the entry nor the inbox row", async () => {
    const memory = new MemoryStore();
    let failing = true;
    const store: Store = {
      ping: () => memory.ping(),
      tenantTransaction: (tenantId, work, options) =>
        memory.tenantTransaction(
          tenantId,
          async (repositories) => {
            const result = await work(repositories);
            if (failing) throw new Error("the commit failed");
            return result;
          },
          options,
        ),
    };
    const core = createCore();
    const handler = recordEventHandler({ ...core.deps, store }, "audit-test");

    await expect(handler(receivedEvent({ ...tenantCreated(TENANT_A, 1) }))).rejects.toThrow("the commit failed");
    // Nothing was kept: the tenant is still unknown and the same event is processed afresh once the store works.
    await expect(memory.tenantTransaction(TENANT_A, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    failing = false;
    await handler(receivedEvent({ ...tenantCreated(TENANT_A, 1) }));
    const page = await memory.tenantTransaction(TENANT_A, (repositories) => repositories.entries.list({ types: [], from: null, to: null, correlationId: null, actor: null, subject: null, before: null, limit: 10 }));
    expect(page).toHaveLength(1);
  });
});

describe("streamHandlers", () => {
  it("makes one handler per consumed stream, each with the inbox name of its durable consumer", async () => {
    const core = createCore();
    const handlers = streamHandlers(core.deps);
    expect(handlers.map(({ stream }) => stream.stream)).toEqual(["TENANTS", "PAYMENTS", "MARKETS", "TRADING"]);
    expect(handlers.map(({ stream }) => stream)).toEqual(CONSUMED_STREAMS);

    // The same event id through two streams' handlers is one event of two inboxes: recorded once, and told so in the log.
    const [tenants, payments] = handlers;
    await tenants?.handler(receivedEvent({ ...tenantCreated(TENANT_A, 1) }));
    await payments?.handler(receivedEvent({ id: eventId(1) }));
    expect((await readAll(core, TENANT_A)).map((entry) => entry.seq)).toEqual([1]);
  });

  it("only the TENANTS stream creates a tenant's log: a TenantCreated on another stream is TenantNotReady and creates nothing", async () => {
    const core = createCore();
    const [, payments] = streamHandlers(core.deps);
    await expect(payments?.handler(receivedEvent({ ...tenantCreated(TENANT_B, 7) }))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(core.useCases.listEntries(TENANT_B, {})).rejects.toBeInstanceOf(TenantNotReady);
  });
});
