import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_A, TENANT_B, createHarness } from "../support/harness.js";

// The web layer before the audit routes exist: the health probes, the correlation id, the problem details, and the
// guard of the audit endpoints (role tenant-admin, tenant only from the token), exercised through probe routes.

type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ probes: true });
});
afterAll(async () => {
  await h.app.close();
});

const PROBLEM = "application/problem+json";

async function get(url: string, headers: Record<string, string> = {}) {
  const response = await h.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, headers: response.headers, body: response.json<Record<string, any>>() };
}

describe("health probes", () => {
  it("answer 200 without a token", async () => {
    for (const path of ["/health/startup", "/health/ready", "/health/live"]) {
      expect(await get(path)).toMatchObject({ status: 200, body: { status: "up" } });
    }
  });

  it("answers 503 shutting_down on readiness from the moment of SIGTERM, and 200 on liveness", async () => {
    h.setDraining(true);
    try {
      const ready = await get("/health/ready");
      expect(ready).toMatchObject({ status: 503, body: { code: "shutting_down", status: 503 } });
      expect(ready.headers["content-type"]).toContain(PROBLEM);
      expect((await get("/health/live")).status).toBe(200);
    } finally {
      h.setDraining(false);
    }
  });

  it("answers 503 not_ready when the database does not answer, and 200 on liveness all the same", async () => {
    const broken = await createHarness({ pingFails: true });
    try {
      const response = await broken.app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ code: string }>().code).toBe("not_ready");
      expect((await broken.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    } finally {
      await broken.app.close();
    }
  });
});

describe("correlation id", () => {
  it("returns the id the caller sent, and makes one when there is none or it is not safe", async () => {
    expect((await get("/health/live", { "x-correlation-id": "corr-123" })).headers["x-correlation-id"]).toBe("corr-123");
    expect((await get("/health/live")).headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((await get("/health/live", { "x-correlation-id": "bad id\twith spaces" })).headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is also on a problem answer", async () => {
    const response = await get("/nowhere", { "x-correlation-id": "corr-9" });
    expect(response.headers["x-correlation-id"]).toBe("corr-9");
  });
});

describe("problem details", () => {
  it("answers an unknown path with 404 problem+json", async () => {
    const response = await get("/v1/nothing");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.body).toMatchObject({ type: "urn:chance:problem:not-found", status: 404, code: "not_found", instance: "/v1/nothing" });
  });

  it("maps the errors of the use cases: 400 with the fields, 404, and 503 with Retry-After for a tenant without a schema", async () => {
    const auth = await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A] });
    const invalid = await get("/_probe/invalid", auth);
    expect(invalid).toMatchObject({ status: 400, body: { code: "validation_failed", errors: [{ field: "limit", message: "must be at most 100" }] } });
    expect(await get("/_probe/not-found", auth)).toMatchObject({ status: 404, body: { code: "entry_not_found" } });
    const notReady = await get("/_probe/not-ready", auth);
    expect(notReady).toMatchObject({ status: 503, body: { code: "tenant_not_ready" } });
    expect(notReady.headers["retry-after"]).toBe("5");
  });

  it("hides what an unexpected error says", async () => {
    const response = await get("/_probe/boom", await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A] }));
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error", detail: "The service failed to handle the request" });
    expect(JSON.stringify(response.body)).not.toContain("something unexpected");
  });
});

describe("authentication", () => {
  it("answers 401 with a Bearer challenge when there is no token, or the header is not Bearer <token>", async () => {
    const none = await get("/_probe/whoami");
    expect(none).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(none.headers["www-authenticate"]).toBe("Bearer");
    expect((await get("/_probe/whoami", { authorization: "Basic abc" })).status).toBe(401);
    expect((await get("/_probe/whoami", { authorization: "Bearer a b" })).status).toBe(401);
    expect((await get("/_probe/whoami", { authorization: "Bearer" })).status).toBe(401);
  });

  it("answers 401 for a token that is wrong, whatever the reason", async () => {
    const wrong = [
      await h.bearer({ expiresIn: -60 }),
      await h.bearer({ audience: "another-service" }),
      await h.bearer({ issuer: "http://evil.example/realms/x" }),
      { authorization: `Bearer ${await h.keys.signWithOtherKey({ roles: ["tenant-admin"], organization: [TENANT_A] })}` },
      { authorization: "Bearer not.a.token" },
    ];
    for (const headers of wrong) expect((await get("/_probe/whoami", headers)).status).toBe(401);
  });

  it("answers 401 for a token with two organizations: the tenant must be one", async () => {
    const response = await get("/_probe/tenant-admin", await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A, TENANT_B] }));
    expect(response.status).toBe(401);
  });

  it("answers 503 with Retry-After, not 401, when the signing keys cannot be fetched", async () => {
    h.failKeys(new errors.JWKSTimeout());
    try {
      const response = await get("/_probe/whoami", await h.bearer());
      expect(response).toMatchObject({ status: 503, body: { code: "identity_provider_unavailable" } });
      expect(response.headers["retry-after"]).toBe("5");
    } finally {
      h.failKeys(null);
    }
    expect((await get("/_probe/whoami", await h.bearer())).status).toBe(200);
  });
});

describe("the guard of the audit endpoints (role tenant-admin, tenant only from the token)", () => {
  it("lets a tenant admin in and returns the tenant of the token, in lower case", async () => {
    const response = await get("/_probe/tenant-admin", await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A.toUpperCase()] }));
    expect(response).toMatchObject({ status: 200, body: { tenantId: TENANT_A } });
  });

  it("takes the tenant from an organization claim that is an object keyed by alias, too", async () => {
    const response = await get("/_probe/tenant-admin", await h.bearer({ roles: ["tenant-admin"], organization: { [TENANT_B]: { id: "x" } } }));
    expect(response.body["tenantId"]).toBe(TENANT_B);
  });

  it("never reads the tenant from the request: a query or a header naming another tenant changes nothing", async () => {
    const auth = await h.bearer({ roles: ["tenant-admin"], organization: [TENANT_A] });
    const response = await get(`/_probe/tenant-admin?tenantId=${TENANT_B}`, { ...auth, "x-tenant-id": TENANT_B });
    expect(response.body["tenantId"]).toBe(TENANT_A);
  });

  it.each([
    ["a trader", ["trader"]],
    ["a platform admin", ["platform-admin"]],
    ["a token without roles", []],
  ])("answers 403 for %s", async (_who, roles) => {
    const response = await get("/_probe/tenant-admin", await h.bearer({ roles, organization: [TENANT_A] }));
    expect(response).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(response.headers["content-type"]).toContain(PROBLEM);
  });

  it("answers 403 for a tenant admin whose organization is no tenant id", async () => {
    const response = await get("/_probe/tenant-admin", await h.bearer({ roles: ["tenant-admin"], organization: ["acme"] }));
    expect(response).toMatchObject({ status: 403, body: { code: "forbidden", detail: "The token names no tenant" } });
  });

  it("answers 403 without the role when the token has no organization: the tenant role is the organization's group", async () => {
    for (const token of [{ roles: ["tenant-admin"] }, { realmAccessRoles: ["tenant-admin"], organization: [TENANT_A] }, { organization: [TENANT_A] }]) {
      const response = await get("/_probe/tenant-admin", await h.bearer(token));
      expect(response, JSON.stringify(token)).toMatchObject({ status: 403, body: { code: "forbidden", detail: "The tenant-admin role is required" } });
    }
    const viaGroup = await get("/_probe/tenant-admin", await h.bearer({ groups: ["/tenant-admin"], organization: [TENANT_A] }));
    expect(viaGroup).toMatchObject({ status: 200, body: { tenantId: TENANT_A } });
  });

  it("answers 401, not 403, when there is no token at all", async () => {
    expect((await get("/_probe/tenant-admin")).status).toBe(401);
  });
});
