import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { buildEntry } from "../../src/domain/audit-entry.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import type { EntryQuery } from "../../src/usecases/ports.js";
import { EVENT_TIME, TENANT_A, TENANT_B, eventId, receivedEvent } from "../support/harness.js";

const ALL: EntryQuery = { types: [], from: null, to: null, correlationId: null, actor: null, subject: null, before: null, limit: 100 };
const NOW = new Date("2026-11-01T10:00:00.000Z");

describe("MemoryStore", () => {
  it("answers the readiness ping", async () => {
    await expect(new MemoryStore().ping()).resolves.toBeUndefined();
  });

  it("refuses a tenant that was not provisioned, and an id that is no UUID before it looks anything up", async () => {
    const store = new MemoryStore();
    await expect(store.tenantTransaction(TENANT_A, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(store.tenantTransaction("x'; DROP SCHEMA shared; --", () => Promise.resolve(1))).rejects.toThrow("UUID");
  });

  it("provisions a tenant with the transaction, case-insensitively, and keeps it only when the work succeeds", async () => {
    const store = new MemoryStore();
    await expect(
      store.tenantTransaction(
        TENANT_A.toUpperCase(),
        () => {
          throw new Error("rolled back");
        },
        { provisionAt: NOW },
      ),
    ).rejects.toThrow("rolled back");
    await expect(store.tenantTransaction(TENANT_A, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);

    await store.tenantTransaction(TENANT_A.toUpperCase(), () => Promise.resolve(1), { provisionAt: NOW });
    await expect(store.tenantTransaction(TENANT_A, () => Promise.resolve(2))).resolves.toBe(2);
    await expect(store.tenantTransaction(TENANT_B, () => Promise.resolve(2))).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("stages the entries and the inbox of a transaction and drops them when the work throws", async () => {
    const store = new MemoryStore();
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(), { provisionAt: NOW });
    await expect(
      store.tenantTransaction(TENANT_A, async ({ inbox, entries }) => {
        expect(await inbox.markProcessed("c", { id: "e1", type: "t" }, NOW)).toBe(true);
        expect(await inbox.markProcessed("c", { id: "e1", type: "t" }, NOW)).toBe(false);
        await entries.append((head) => buildEntry(receivedEvent(), NOW, head));
        expect(await entries.list(ALL)).toHaveLength(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    await store.tenantTransaction(TENANT_A, async ({ inbox, entries }) => {
      expect(await entries.list(ALL)).toEqual([]);
      expect(await inbox.markProcessed("c", { id: "e1", type: "t" }, NOW)).toBe(true);
    });
  });

  it("keeps the inbox per consumer, and an event id once per tenant log, without gaps in seq", async () => {
    const store = new MemoryStore();
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(), { provisionAt: NOW });
    await store.tenantTransaction(TENANT_A, async ({ inbox, entries }) => {
      expect(await inbox.markProcessed("one", { id: "e1", type: "t" }, NOW)).toBe(true);
      expect(await inbox.markProcessed("two", { id: "e1", type: "t" }, NOW)).toBe(true);
      expect((await entries.append((head) => buildEntry(receivedEvent({ id: eventId(1) }), NOW, head)))?.seq).toBe(1);
      expect(await entries.append((head) => buildEntry(receivedEvent({ id: eventId(1) }), NOW, head))).toBeNull();
      expect((await entries.append((head) => buildEntry(receivedEvent({ id: eventId(2) }), NOW, head)))?.seq).toBe(2);
    });
    await store.tenantTransaction(TENANT_A, async ({ inbox, entries }) => {
      expect(await inbox.markProcessed("one", { id: "e1", type: "t" }, NOW)).toBe(false);
      expect(await entries.append((head) => buildEntry(receivedEvent({ id: eventId(1) }), NOW, head))).toBeNull();
      expect((await entries.append((head) => buildEntry(receivedEvent({ id: eventId(3) }), NOW, head)))?.seq).toBe(3);
    });
  });

  it("runs the transactions one after the other, so that a second one sees what the first committed", async () => {
    const store = new MemoryStore();
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(), { provisionAt: NOW });
    const order: string[] = [];
    const slow = store.tenantTransaction(TENANT_A, async ({ entries }) => {
      order.push("slow starts");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await entries.append((head) => buildEntry(receivedEvent({ id: eventId(1) }), NOW, head));
      order.push("slow ends");
    });
    const fast = store.tenantTransaction(TENANT_A, async ({ entries }) => {
      order.push("fast starts");
      expect((await entries.append((head) => buildEntry(receivedEvent({ id: eventId(2) }), NOW, head)))?.seq).toBe(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow starts", "slow ends", "fast starts"]);
  });

  it("a failed transaction does not block the next one", async () => {
    const store = new MemoryStore();
    await expect(store.tenantTransaction(TENANT_B, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(store.tenantTransaction(TENANT_B, () => Promise.resolve(1), { provisionAt: NOW })).resolves.toBe(1);
  });

  it("hands out entries that cannot be changed", async () => {
    const store = new MemoryStore();
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(), { provisionAt: NOW });
    await store.tenantTransaction(TENANT_A, ({ entries }) => entries.append((head) => buildEntry(receivedEvent(), NOW, head)));
    const [entry] = await store.tenantTransaction(TENANT_A, ({ entries }) => entries.list(ALL));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry?.occurredAt).toEqual(EVENT_TIME);
  });

  it("reads the chain in order after a seq, and lists newest first under the filters", async () => {
    const store = new MemoryStore();
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(), { provisionAt: NOW });
    await store.tenantTransaction(TENANT_A, async ({ entries }) => {
      for (let n = 1; n <= 5; n += 1) await entries.append((head) => buildEntry(receivedEvent({ id: eventId(n), time: new Date(NOW.getTime() + n * 1000).toISOString() }), NOW, head));
      expect((await entries.readChain(0, 3)).map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect((await entries.readChain(3, 10)).map((entry) => entry.seq)).toEqual([4, 5]);
      expect((await entries.list({ ...ALL, limit: 2 })).map((entry) => entry.seq)).toEqual([5, 4]);
      expect((await entries.list({ ...ALL, before: 4 })).map((entry) => entry.seq)).toEqual([3, 2, 1]);
      expect((await entries.list({ ...ALL, from: new Date(NOW.getTime() + 2000), to: new Date(NOW.getTime() + 4000) })).map((entry) => entry.seq)).toEqual([4, 3, 2]);
    });
  });
});
