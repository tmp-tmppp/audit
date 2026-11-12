import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../src/domain/audit-entry.js";
import { createUseCases } from "../../src/usecases/application.js";
import { TenantNotReady, Unavailable } from "../../src/usecases/errors.js";
import type { Store } from "../../src/usecases/ports.js";
import { VERIFY_PAGE_SIZE, verifyAuditChain } from "../../src/usecases/verify-chain.js";
import { TENANT_A, cloudEvent, createCore, eventId, tenantCreated } from "../support/harness.js";

async function logOf(count: number): Promise<{ core: ReturnType<typeof createCore>; entries: AuditEntry[] }> {
  const core = createCore();
  await core.record(tenantCreated(TENANT_A, 1));
  for (let n = 2; n <= count; n += 1) await core.record(cloudEvent({ id: eventId(n), data: { marketId: `m-${n}`, n } }));
  return { core, entries: (await core.useCases.listEntries(TENANT_A, { limit: 100 })).items.reverse() };
}

/** A store that serves a log as it is, tampered with or not, and counts the pages that were read. */
function storeServing(entries: readonly AuditEntry[]): { store: Store; reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  const store: Store = {
    ping: () => Promise.resolve(),
    tenantTransaction: (_tenantId, work) =>
      work({
        inbox: { markProcessed: () => Promise.resolve(true) },
        entries: {
          append: () => Promise.reject(new Error("verification does not write")),
          list: () => Promise.reject(new Error("verification does not list")),
          readChain: (afterSeq, limit) => {
            reads.push([afterSeq, limit]);
            return Promise.resolve(entries.filter((entry) => entry.seq > afterSeq).slice(0, limit));
          },
        },
      }),
  };
  return { store, reads };
}

describe("verifyAuditChain and the connections of the pool", () => {
  it("reads every page in a transaction of its own, so no connection is held for the length of the log", async () => {
    const { core, entries } = await logOf(12);
    const inner = storeServing(entries).store;
    let transactions = 0;
    let open = 0;
    let mostOpen = 0;
    const store: Store = {
      ...inner,
      tenantTransaction: async (tenantId, work, options) => {
        transactions += 1;
        open += 1;
        mostOpen = Math.max(mostOpen, open);
        try {
          return await inner.tenantTransaction(tenantId, work, options);
        } finally {
          open -= 1;
        }
      },
    };
    expect(await verifyAuditChain({ ...core.deps, store }, TENANT_A, 5)).toEqual({ valid: true, entries: 12, brokenAtSeq: null });
    expect(transactions).toBe(3);
    expect(mostOpen).toBe(1);
  });

  it("at most the given number of verifications run at once; another is 503 verify_busy with a Retry-After, and a finished or failed one frees its place", async () => {
    const { core, entries } = await logOf(4);
    const inner = storeServing(entries).store;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: Store = {
      ...inner,
      tenantTransaction: async (tenantId, work, options) => {
        await gate;
        return inner.tenantTransaction(tenantId, work, options);
      },
    };
    const useCases = createUseCases({ ...core.deps, store: gated }, { maxConcurrentVerifies: 2 });

    const first = useCases.verifyChain(TENANT_A);
    const second = useCases.verifyChain(TENANT_A);
    const refused: unknown = await useCases.verifyChain(TENANT_A).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Unavailable);
    expect(refused).toMatchObject({ kind: "unavailable", code: "verify_busy", retryAfterSeconds: expect.any(Number) });
    release();
    expect(await Promise.all([first, second])).toEqual([
      { valid: true, entries: 4, brokenAtSeq: null },
      { valid: true, entries: 4, brokenAtSeq: null },
    ]);
    expect(await useCases.verifyChain(TENANT_A)).toMatchObject({ valid: true });

    const failing: Store = { ...inner, tenantTransaction: () => Promise.reject(new Error("the database is down")) };
    const broken = createUseCases({ ...core.deps, store: failing }, { maxConcurrentVerifies: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(broken.verifyChain(TENANT_A)).rejects.toThrow("the database is down");
  });
});

describe("verifyAuditChain", () => {
  it("an intact chain is valid and counts its entries", async () => {
    const { core } = await logOf(12);
    expect(await core.useCases.verifyChain(TENANT_A)).toEqual({ valid: true, entries: 12, brokenAtSeq: null });
  });

  it("a tenant whose log has no entries is valid with 0 entries; one without a log is TenantNotReady", async () => {
    const { store } = storeServing([]);
    const { core } = await logOf(1);
    expect(await verifyAuditChain({ ...core.deps, store }, TENANT_A)).toEqual({ valid: true, entries: 0, brokenAtSeq: null });
    await expect(createCore().useCases.verifyChain(TENANT_A)).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("reads the log page by page, from the start, and stops after the last page", async () => {
    const { core, entries } = await logOf(10);
    const { store, reads } = storeServing(entries);
    expect(await verifyAuditChain({ ...core.deps, store }, TENANT_A, 4)).toEqual({ valid: true, entries: 10, brokenAtSeq: null });
    expect(reads).toEqual([[0, 4], [4, 4], [8, 4]]);

    // A log that ends exactly at a page boundary needs one more read, which comes back empty.
    const exact = storeServing(entries.slice(0, 8));
    await verifyAuditChain({ ...core.deps, store: exact.store }, TENANT_A, 4);
    expect(exact.reads).toEqual([[0, 4], [4, 4], [8, 4]]);
    expect(VERIFY_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("finds a changed payload, a changed hash and a changed previous hash at the entry that was changed", async () => {
    const { core, entries } = await logOf(8);
    const verify = async (changed: AuditEntry[]) => verifyAuditChain({ ...core.deps, store: storeServing(changed).store }, TENANT_A, 3);
    const replaced = (seq: number, change: Partial<AuditEntry>): AuditEntry[] => entries.map((entry) => (entry.seq === seq ? { ...entry, ...change } : entry));

    expect(await verify(replaced(5, { payload: { marketId: "m-5", n: 6 } }))).toEqual({ valid: false, entries: 8, brokenAtSeq: 5 });
    expect(await verify(replaced(4, { hash: "f".repeat(64) }))).toEqual({ valid: false, entries: 8, brokenAtSeq: 4 });
    expect(await verify(replaced(7, { prevHash: "a".repeat(64) }))).toEqual({ valid: false, entries: 8, brokenAtSeq: 7 });
    expect(await verify(replaced(2, { actor: "someone" }))).toEqual({ valid: false, entries: 8, brokenAtSeq: 2 });
  });

  it("finds a removed entry at the entry after the gap, and an entry inserted out of order", async () => {
    const { core, entries } = await logOf(8);
    const verify = async (changed: AuditEntry[]) => verifyAuditChain({ ...core.deps, store: storeServing(changed).store }, TENANT_A, 3);
    expect(await verify(entries.filter((entry) => entry.seq !== 4))).toEqual({ valid: false, entries: 7, brokenAtSeq: 5 });
    expect(await verify(entries.slice(1))).toEqual({ valid: false, entries: 7, brokenAtSeq: 2 });
  });

  it("cannot see entries cut off at the end of the log (documented in contracts/README.md)", async () => {
    const { core, entries } = await logOf(8);
    const result = await verifyAuditChain({ ...core.deps, store: storeServing(entries.slice(0, 5)).store }, TENANT_A);
    expect(result).toEqual({ valid: true, entries: 5, brokenAtSeq: null });
  });
});
