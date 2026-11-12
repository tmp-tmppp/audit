import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { TENANT_A, createHarness, tenantCreated } from "../support/harness.js";

// The metrics wired into the real application the way src/main.ts wires them: the tenant label is the tenant of the
// token that the service verified. The convention itself is tested in tests/adapters/metrics.test.ts.

type Harness = Awaited<ReturnType<typeof createHarness>>;

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
  // The tenant needs its schema (TenantCreated), or the audit routes answer 503.
  await h.record(tenantCreated(TENANT_A, 1));
});
afterAll(async () => {
  await h.app.close();
});

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

const admin = { roles: ["tenant-admin"], organization: [TENANT_A], sub: "admin-1" };

describe("the metrics of the real application", () => {
  it("counts a request of a tenant under the template of its route and the tenant of its token", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/audit/verify", headers: await h.bearer(admin) });
    expect(response.statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/audit/verify", status_code: "200", tenant: TENANT_A })).toBe(1);
  });

  it("never lets the query string of a request become a label value", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/audit?actor=actor-from-the-query&correlationId=corr-from-the-query", headers: await h.bearer(admin) });
    expect(await counter({ method: "GET", route: "/v1/audit", status_code: String(response.statusCode), tenant: TENANT_A })).toBe(1);
    const text = await metrics.registry.metrics();
    expect(text).not.toContain("actor-from-the-query");
    expect(text).not.toContain("corr-from-the-query");
  });

  it("counts a refused request under the tenant of the token that was verified", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/audit", headers: await h.bearer({ ...admin, roles: [] }) });
    expect(response.statusCode).toBe(403);
    expect(await counter({ method: "GET", route: "/v1/audit", status_code: "403", tenant: TENANT_A })).toBe(1);
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/audit" });
    expect(response.statusCode).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/audit", status_code: "401", tenant: "none" })).toBe(1);
  });

  it("counts the probes under their own routes", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/health/live", status_code: "200", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the answer is a 404 counted as "unmatched"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await plain.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await plain.app.close();
  });
});
