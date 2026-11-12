import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { responseErrors } from "../support/contracts.js";
import { MARKET_ID, TENANT_A, TENANT_B, cloudEvent, createHarness, eventId, tenantCreated } from "../support/harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
const T_MARKET = "si.chance.markets.MarketOpened.v1";
const T_DEPOSIT = "si.chance.payments.DepositSucceeded.v1";

beforeAll(async () => {
  h = await createHarness();
  await h.record(tenantCreated(TENANT_A, 1));
  await h.record(tenantCreated(TENANT_B, 2));
  const at = (hour: number): string => `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  await h.record(cloudEvent({ id: eventId(10), type: T_MARKET, time: at(11), correlationid: "c-1", data: { marketId: MARKET_ID, adminId: "admin-1", question: "Q?" } }));
  await h.record(cloudEvent({ id: eventId(11), type: T_DEPOSIT, time: at(12), correlationid: "c-2", data: { depositId: "dep-1", userId: "user-1", amount: 500 } }));
  await h.record(cloudEvent({ id: eventId(12), type: "si.chance.future.WidgetRetired.v9", time: at(13), data: [1, "two", { three: null }] }));
  await h.record(cloudEvent({ id: eventId(20), tenantid: TENANT_B, type: T_MARKET, time: at(11), correlationid: "c-b", data: { marketId: "market-of-b" } }));
});
afterAll(async () => {
  await h.app.close();
});

const admin = (tenant: string, extra: { sub?: string } = {}) => h.bearer({ roles: ["tenant-admin"], organization: [tenant], ...extra });

async function get(url: string, headers: Record<string, string>) {
  const response = await h.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, headers: response.headers, body: response.json<any>() };
}

describe("authentication and roles", () => {
  it.each(["/v1/audit", "/v1/audit/verify"])("%s: no token is 401 with a Bearer challenge, as problem+json", async (url) => {
    const response = await get(url, {});
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ code: "unauthorized", status: 401, instance: url });
    expect(responseErrors(url, "get", 401, response.body)).toEqual([]);
  });

  it.each(["/v1/audit", "/v1/audit/verify"])("%s: a token that is wrong is 401 (expired, other key, other audience)", async (url) => {
    for (const authorization of [
      `Bearer ${await h.keys.sign({ roles: ["tenant-admin"], organization: [TENANT_A], expiresIn: -60 })}`,
      `Bearer ${await h.keys.signWithOtherKey({ roles: ["tenant-admin"], organization: [TENANT_A] })}`,
      `Bearer ${await h.keys.sign({ roles: ["tenant-admin"], organization: [TENANT_A], audience: "someone-else" })}`,
      "Basic dXNlcjpwYXNz",
    ]) {
      expect((await get(url, { authorization })).status).toBe(401);
    }
  });

  it.each(["/v1/audit", "/v1/audit/verify"])("%s: every role but tenant-admin is 403, and so is a token without a tenant", async (url) => {
    for (const roles of [[], ["trader"], ["platform-admin"], ["trader", "platform-admin"]]) {
      const response = await get(url, await h.bearer({ roles, organization: [TENANT_A] }));
      expect(response.status, roles.join()).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden", detail: "The tenant-admin role is required" });
      expect(responseErrors(url, "get", 403, response.body)).toEqual([]);
    }
    // Without an organization the token has no tenant role either (it is the organization's group): the role is missing.
    const noTenant = await get(url, await h.bearer({ roles: ["tenant-admin"] }));
    expect(noTenant.status).toBe(403);
    expect(noTenant.body).toMatchObject({ detail: "The tenant-admin role is required" });
    const notUuid = await get(url, await h.bearer({ roles: ["tenant-admin"], organization: ["acme"] }));
    expect(notUuid.status).toBe(403);
    expect(notUuid.body).toMatchObject({ detail: "The token names no tenant" });
    expect((await get(url, await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A, TENANT_B] }))).status).toBe(401);
  });

  it("the role is checked before the input: a trader with a bad limit is 403, not 400", async () => {
    const response = await get("/v1/audit?limit=0", await h.bearer({ roles: ["trader"], organization: [TENANT_A] }));
    expect(response.status).toBe(403);
  });

  it.each(["/v1/audit", "/v1/audit/verify"])("%s: a tenant-admin token whose organization alias is no UUID is 403, not a server error", async (url) => {
    for (const alias of ["acme", "not-a-uuid", "../shared", `${TENANT_A}x`, "' OR 1=1 --", " "]) {
      const response = await get(url, await h.bearer({ roles: ["tenant-admin"], organization: [alias] }));
      expect(response.status, alias).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden", detail: "The token names no tenant" });
      expect(responseErrors(url, "get", 403, response.body)).toEqual([]);
    }
  });

  it("an organization given as an object keyed by alias, and an upper-case alias, name the tenant too", async () => {
    const byObject = await get("/v1/audit/verify", await h.bearer({ roles: ["tenant-admin"], organization: { [TENANT_A]: { id: "x" } } }));
    expect(byObject.body).toMatchObject({ valid: true, entries: 4 });
    const upper = await get("/v1/audit/verify", await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A.toUpperCase()] }));
    expect(upper.body).toMatchObject({ valid: true, entries: 4 });
  });
});

describe("GET /v1/audit", () => {
  it("lists the entries of the caller's tenant, newest first, in the shape of the contract", async () => {
    const response = await get("/v1/audit", await admin(TENANT_A));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items.map((entry: { seq: number }) => entry.seq)).toEqual([4, 3, 2, 1]);
    expect(responseErrors("/v1/audit", "get", 200, response.body)).toEqual([]);

    const [widget, deposit, market, created] = response.body.items;
    expect(market).toMatchObject({
      seq: 2,
      eventId: eventId(10),
      eventType: T_MARKET,
      source: "/chance/markets",
      subject: MARKET_ID,
      actor: "admin-1",
      occurredAt: "2026-11-01T11:00:00.000Z",
      recordedAt: "2026-11-01T10:00:00.000Z",
      correlationId: "c-1",
      causationId: "req-1",
      payload: { marketId: MARKET_ID, adminId: "admin-1", question: "Q?" },
      prevHash: created.hash,
    });
    expect(market.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.prevHash).toBe("0".repeat(64));
    expect(deposit).toMatchObject({ subject: "dep-1", actor: "user-1", payload: { depositId: "dep-1", userId: "user-1", amount: 500 } });
    // An event type that is not known, and data that is a list, are listed like any other.
    expect(widget).toMatchObject({ eventType: "si.chance.future.WidgetRetired.v9", subject: TENANT_A, actor: null, payload: [1, "two", { three: null }] });
  });

  it("never shows another tenant's entries, and a tenant named in the request changes nothing", async () => {
    const own = await get("/v1/audit", await admin(TENANT_B));
    expect(own.body.items.map((entry: { eventId: string }) => entry.eventId)).toEqual([eventId(20), eventId(2)]);

    const asked = await get(`/v1/audit?tenantId=${TENANT_A}&tenant=${TENANT_A}`, { ...(await admin(TENANT_B)), "x-tenant-id": TENANT_A });
    expect(asked.status).toBe(200);
    expect(asked.body.items.map((entry: { eventId: string }) => entry.eventId)).toEqual([eventId(20), eventId(2)]);
    expect(JSON.stringify(asked.body)).not.toContain(MARKET_ID);
    expect((await get(`/v1/audit/${TENANT_A}`, await admin(TENANT_B))).status).toBe(404);
  });

  it("filters by type (repeated, comma-separated), time, correlation id, actor and subject", async () => {
    const list = async (query: string) => (await get(`/v1/audit?${query}`, await admin(TENANT_A))).body.items.map((entry: { seq: number }) => entry.seq);
    expect(await list(`type=${T_MARKET}`)).toEqual([2]);
    expect(await list(`type=${T_MARKET}&type=${T_DEPOSIT}`)).toEqual([3, 2]);
    expect(await list(`type=${T_MARKET},${T_DEPOSIT}`)).toEqual([3, 2]);
    expect(await list(`from=${encodeURIComponent("2026-11-01T12:00:00+00:00")}&to=2026-11-01T13:00:00Z`)).toEqual([4, 3]);
    expect(await list(`from=${encodeURIComponent("2026-11-01T13:00:00+01:00")}&to=${encodeURIComponent("2026-11-01T13:00:00+01:00")}`)).toEqual([3]);
    expect(await list("correlationId=c-2")).toEqual([3]);
    expect(await list("actor=admin-1")).toEqual([2]);
    expect(await list(`subject=${MARKET_ID}`)).toEqual([2]);
    expect(await list(`subject=${MARKET_ID}&actor=user-1`)).toEqual([]);
  });

  it("pages with limit and the opaque cursor from nextCursor", async () => {
    const first = await get("/v1/audit?limit=3", await admin(TENANT_A));
    expect(first.body.items.map((entry: { seq: number }) => entry.seq)).toEqual([4, 3, 2]);
    expect(typeof first.body.nextCursor).toBe("string");
    const second = await get(`/v1/audit?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`, await admin(TENANT_A));
    expect(second.body.items.map((entry: { seq: number }) => entry.seq)).toEqual([1]);
    expect(second.body.nextCursor).toBeNull();
    expect(responseErrors("/v1/audit", "get", 200, first.body)).toEqual([]);
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=abc", "limit"],
    ["limit=1.5", "limit"],
    ["from=yesterday", "from"],
    ["from=2026-11-01", "from"],
    ["to=2026-11-01T10:00:00", "to"],
    ["from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z", "from"],
    ["cursor=not-a-cursor", "cursor"],
    ["cursor=", "cursor"],
    ["actor=", "actor"],
    ["correlationId=" + "x".repeat(256), "correlationId"],
    ["subject=", "subject"],
    [Array.from({ length: 21 }, (_, n) => `type=t-${n}`).join("&"), "type"],
    [`type=${Array.from({ length: 21 }, (_, n) => `t-${n}`).join(",")}`, "type"],
  ])("answers 400 with problem+json that names the field for ?%s", async (query, field) => {
    const response = await get(`/v1/audit?${query}`, await admin(TENANT_A));
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ type: "urn:chance:problem:validation-failed", code: "validation_failed", status: 400, instance: "/v1/audit" });
    expect(response.body.errors.map((error: { field: string }) => error.field.split(".")[0])).toContain(field);
    expect(responseErrors("/v1/audit", "get", 400, response.body)).toEqual([]);
  });

  it("answers 503 tenant_not_ready with Retry-After for a tenant whose TenantCreated has not been processed", async () => {
    const response = await get("/v1/audit", await admin("018f3c1e-7a00-7000-8000-0000000000cc"));
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toMatchObject({ code: "tenant_not_ready", status: 503 });
    expect(responseErrors("/v1/audit", "get", 503, response.body)).toEqual([]);
  });

  it("returns the correlation id of the request, or its own", async () => {
    const sent = await get("/v1/audit", { ...(await admin(TENANT_A)), "x-correlation-id": "corr-from-client" });
    expect(sent.headers["x-correlation-id"]).toBe("corr-from-client");
    const made = await get("/v1/audit", await admin(TENANT_A));
    expect(made.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /v1/audit/verify", () => {
  it("recomputes the chain of the caller's tenant", async () => {
    const response = await get("/v1/audit/verify", await admin(TENANT_A));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ valid: true, entries: 4, brokenAtSeq: null });
    expect(responseErrors("/v1/audit/verify", "get", 200, response.body)).toEqual([]);
    expect((await get("/v1/audit/verify", await admin(TENANT_B))).body).toEqual({ valid: true, entries: 2, brokenAtSeq: null });
  });

  it("answers 503 tenant_not_ready for a tenant without a log", async () => {
    const response = await get("/v1/audit/verify", await admin("018f3c1e-7a00-7000-8000-0000000000cc"));
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body.code).toBe("tenant_not_ready");
  });
});

describe("what the API does not have", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("%s on the log is 404: there is no route that writes", async (method) => {
    for (const url of ["/v1/audit", "/v1/audit/verify", `/v1/audit/${eventId(10)}`]) {
      const response = await h.app.inject({ method, url, headers: await admin(TENANT_A), payload: method === "DELETE" ? undefined : {} });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json()).toMatchObject({ code: "not_found" });
    }
    expect((await get("/v1/audit", await admin(TENANT_A))).body.items).toHaveLength(4);
  });
});
