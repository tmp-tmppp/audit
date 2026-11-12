import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_TYPES, decodeCursor, encodeCursor } from "../../src/usecases/list-entries.js";
import { TenantNotReady, ValidationFailed } from "../../src/usecases/errors.js";
import { MARKET_ID, TENANT_A, TENANT_B, cloudEvent, createCore, eventId, tenantCreated } from "../support/harness.js";

const T1 = "si.chance.markets.MarketOpened.v1";
const T2 = "si.chance.payments.DepositSucceeded.v1";
const T3 = "si.chance.trading.TradeExecuted.v1";

/** Tenant A with 1 TenantCreated and the events below (seq 2 to 7), one hour apart from 10:00 on 2026-11-01. */
async function seeded() {
  const core = createCore();
  await core.record(tenantCreated(TENANT_A, 1));
  const at = (hour: number): string => `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const events = [
    { type: T1, time: at(11), correlationid: "c-1", data: { marketId: MARKET_ID, adminId: "admin-1" } },
    { type: T2, time: at(12), correlationid: "c-2", data: { depositId: "dep-1", userId: "user-1" } },
    { type: T2, time: at(13), correlationid: "c-2", data: { depositId: "dep-2", userId: "user-2" } },
    { type: T3, time: at(14), correlationid: "c-3", data: { marketId: MARKET_ID, userId: "user-1" } },
    { type: T1, time: at(15), correlationid: "c-1", data: { marketId: "m-2", adminId: "admin-2" } },
    { type: T3, time: at(16), correlationid: "c-4", data: { marketId: "m-2", userId: "user-2" } },
  ];
  for (const [n, event] of events.entries()) await core.record(cloudEvent({ id: eventId(10 + n), ...event }));
  await core.record(tenantCreated(TENANT_B, 99));
  return core;
}

const seqs = async (core: ReturnType<typeof createCore>, input: Parameters<ReturnType<typeof createCore>["useCases"]["listEntries"]>[1]) =>
  (await core.useCases.listEntries(TENANT_A, input)).items.map((entry) => entry.seq);

describe("listEntries", () => {
  it("returns the newest entries first, and only the tenant's own", async () => {
    const core = await seeded();
    const page = await core.useCases.listEntries(TENANT_A, {});
    expect(page.items.map((entry) => entry.seq)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(page.nextCursor).toBeNull();
    expect((await core.useCases.listEntries(TENANT_B, {})).items.map((entry) => entry.seq)).toEqual([1]);
  });

  it("filters by type: one, a repeated parameter and a comma list give the same", async () => {
    const core = await seeded();
    expect(await seqs(core, { type: [T1] })).toEqual([6, 2]);
    expect(await seqs(core, { type: [T1, T3] })).toEqual([7, 6, 5, 2]);
    expect(await seqs(core, { type: [`${T1},${T3}`] })).toEqual([7, 6, 5, 2]);
    expect(await seqs(core, { type: [` ${T1} , ,${T1}`, ""] })).toEqual([6, 2]);
    expect(await seqs(core, { type: ["si.chance.nothing.Here.v1"] })).toEqual([]);
  });

  it("filters by from and to on the time the event occurred, both ends included", async () => {
    const core = await seeded();
    expect(await seqs(core, { from: "2026-11-01T12:00:00Z", to: "2026-11-01T14:00:00Z" })).toEqual([5, 4, 3]);
    expect(await seqs(core, { from: "2026-11-01T14:00:00.001Z" })).toEqual([7, 6]);
    expect(await seqs(core, { to: "2026-11-01T11:00:00+00:00" })).toEqual([2, 1]);
    // A zone other than UTC counts: 13:00+01:00 is 12:00Z.
    expect(await seqs(core, { from: "2026-11-01T13:00:00+01:00", to: "2026-11-01T13:00:00+01:00" })).toEqual([3]);
  });

  it("filters by correlation id, actor and subject, and all filters together", async () => {
    const core = await seeded();
    expect(await seqs(core, { correlationId: "c-2" })).toEqual([4, 3]);
    expect(await seqs(core, { actor: "user-1" })).toEqual([5, 3]);
    expect(await seqs(core, { actor: "admin-1" })).toEqual([2]);
    expect(await seqs(core, { subject: MARKET_ID })).toEqual([5, 2]);
    expect(await seqs(core, { subject: TENANT_A })).toEqual([1]);
    expect(await seqs(core, { type: [T1, T3], correlationId: "c-1", subject: MARKET_ID, from: "2026-11-01T11:00:00Z" })).toEqual([2]);
  });

  it("pages with an opaque cursor: pages follow each other without overlap and the last one has no cursor", async () => {
    const core = await seeded();
    const first = await core.useCases.listEntries(TENANT_A, { limit: 3 });
    expect(first.items.map((entry) => entry.seq)).toEqual([7, 6, 5]);
    expect(first.nextCursor).toBe(encodeCursor(5));
    const second = await core.useCases.listEntries(TENANT_A, { limit: 3, cursor: first.nextCursor ?? "" });
    expect(second.items.map((entry) => entry.seq)).toEqual([4, 3, 2]);
    const third = await core.useCases.listEntries(TENANT_A, { limit: 3, cursor: second.nextCursor ?? "" });
    expect(third.items.map((entry) => entry.seq)).toEqual([1]);
    expect(third.nextCursor).toBeNull();
    // A page that ends exactly at the end of the log has no cursor either.
    expect((await core.useCases.listEntries(TENANT_A, { limit: 7 })).nextCursor).toBeNull();
  });

  it("a new entry appended while a client pages does not move the pages still to come; the filters apply with the cursor", async () => {
    const core = await seeded();
    const first = await core.useCases.listEntries(TENANT_A, { limit: 2, type: [T1, T3] });
    await core.record(cloudEvent({ id: eventId(50), type: T1 }));
    const second = await core.useCases.listEntries(TENANT_A, { limit: 2, type: [T1, T3], cursor: first.nextCursor ?? "" });
    expect(first.items.map((entry) => entry.seq)).toEqual([7, 6]);
    expect(second.items.map((entry) => entry.seq)).toEqual([5, 2]);
  });

  it("uses 50 as the default page size and refuses a limit outside 1 to 100", async () => {
    expect(DEFAULT_LIMIT).toBe(50);
    const core = createCore();
    await core.record(tenantCreated(TENANT_A, 1));
    for (let n = 2; n <= 60; n += 1) await core.record(cloudEvent({ id: eventId(n) }));
    const page = await core.useCases.listEntries(TENANT_A, {});
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe(encodeCursor(11));
    expect((await core.useCases.listEntries(TENANT_A, { limit: 100 })).items).toHaveLength(60);
    for (const limit of [0, 101, -1, 1.5, Number.NaN]) {
      await expect(core.useCases.listEntries(TENANT_A, { limit }), String(limit)).rejects.toMatchObject({ kind: "validation", fields: [{ field: "limit" }] });
    }
  });

  it("names every bad field in one ValidationFailed", async () => {
    const core = await seeded();
    const failure = await core.useCases
      .listEntries(TENANT_A, { from: "yesterday", to: "2026-13-45T00:00:00Z", correlationId: "", actor: "x".repeat(256), subject: "", cursor: "not-a-cursor", limit: 0 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidationFailed);
    expect((failure as ValidationFailed).fields.map((field) => field.field).sort()).toEqual(["actor", "correlationId", "cursor", "from", "limit", "subject", "to"]);
  });

  it("refuses a from that is after to, more than 20 types and a type that is too long", async () => {
    const core = await seeded();
    await expect(core.useCases.listEntries(TENANT_A, { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" })).rejects.toMatchObject({ fields: [{ field: "from" }] });
    const many = Array.from({ length: MAX_TYPES + 1 }, (_, n) => `t-${n}`);
    await expect(core.useCases.listEntries(TENANT_A, { type: many })).rejects.toMatchObject({ fields: [{ field: "type" }] });
    await expect(core.useCases.listEntries(TENANT_A, { type: [many.slice(0, MAX_TYPES).join(",")] })).resolves.toMatchObject({ items: [] });
    await expect(core.useCases.listEntries(TENANT_A, { type: ["x".repeat(256)] })).rejects.toMatchObject({ fields: [{ field: "type" }] });
  });

  it("is TenantNotReady for a tenant without a log", async () => {
    const core = createCore();
    await expect(core.useCases.listEntries(TENANT_A, {})).rejects.toBeInstanceOf(TenantNotReady);
  });
});

describe("cursors", () => {
  it("round-trips a position, and refuses anything this service did not make", () => {
    for (const seq of [1, 5, 123_456_789, Number.MAX_SAFE_INTEGER]) expect(decodeCursor(encodeCursor(seq))).toBe(seq);
    const forged = [
      "",
      "abc",
      "seq:5",
      Buffer.from("seq:0").toString("base64url"),
      Buffer.from("seq:-5").toString("base64url"),
      Buffer.from("seq:05").toString("base64url"),
      Buffer.from("seq:5 ").toString("base64url"),
      Buffer.from("seq:9007199254740993").toString("base64url"),
      Buffer.from("seq:99999999999999999").toString("base64url"),
      Buffer.from("tenant:5").toString("base64url"),
      `${encodeCursor(5)}!!`,
      `${encodeCursor(5)}=`,
    ];
    for (const cursor of forged) expect(decodeCursor(cursor), cursor).toBeNull();
  });
});
