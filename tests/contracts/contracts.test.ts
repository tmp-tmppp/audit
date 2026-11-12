import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEntry } from "../../src/domain/audit-entry.js";
import type { AuditEntry } from "../../src/domain/audit-entry.js";
import { GENESIS_HASH, canonicalEntry, computeHash, verifyChain } from "../../src/domain/hash-chain.js";
import { CONSUMED_STREAMS } from "../../src/domain/streams.js";
import { schemas } from "../../src/web/schemas.js";
import { asyncapi, eventErrors, openapi, responseErrors } from "../support/contracts.js";
import { EVENT_TIME, MARKET_ID, cloudEvent, createHarness, eventId, receivedEvent } from "../support/harness.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

describe("contracts/openapi.yaml", () => {
  it("documents every route the application registers, and registers every route it documents", async () => {
    const harness = await createHarness();
    const registered = harness.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    const documented = Object.entries(openapi["paths"] as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).filter((key) => METHODS.includes(key)).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    await harness.app.close();

    expect(registered).toEqual(documented);
    expect(registered).toEqual(["GET /health/live", "GET /health/ready", "GET /health/startup", "GET /v1/audit", "GET /v1/audit/verify"]);
  });

  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(openapi["components"].securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(openapi["security"]).toEqual([{ bearerAuth: [] }]);

    const ids: string[] = [];
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { operationId?: string }>>)) {
      for (const [method, operation] of Object.entries(item)) if (METHODS.includes(method)) ids.push(operation.operationId ?? "");
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], openapi);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("has no endpoint that writes, and no tenant in any path or parameter: the tenant comes from the token", () => {
    const paths = openapi["paths"] as Record<string, Record<string, { parameters?: Array<{ name?: string; $ref?: string }> }>>;
    for (const [path, item] of Object.entries(paths)) {
      expect(path).not.toMatch(/tenant/i);
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        expect(method, path).toBe("get");
        for (const parameter of operation.parameters ?? []) expect(parameter.name ?? "").not.toMatch(/tenant/i);
      }
    }
  });

  it("leaves only the health probes without a security requirement", () => {
    const open: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[] }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.includes(method) && Array.isArray(operation.security) && operation.security.length === 0) open.push(path);
      }
    }
    expect(open.sort()).toEqual(["/health/live", "/health/ready", "/health/startup"]);
  });

  it("documents 401, 403 and 503 with a Retry-After header on every authenticated operation, through shared responses", () => {
    const shared = openapi["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const authenticated: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[]; responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        authenticated.push(`${method.toUpperCase()} ${path}`);
        expect(operation.responses["401"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/Unauthorized" });
        expect(operation.responses["403"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/Forbidden" });
        expect(operation.responses["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      }
    }
    expect(authenticated).toEqual(["GET /v1/audit", "GET /v1/audit/verify"]);
  });

  it("documents the problem+json answer of every error status", () => {
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;
          const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
          expect(Object.keys(resolved.content), `${method} ${status}`).toEqual(["application/problem+json"]);
        }
      }
    }
  });

  it("filters the list by type, from, to, correlationId, actor and subject, with a limit of 1 to 100 (default 50) and a cursor", () => {
    const list = openapi["paths"]["/v1/audit"].get;
    const names = (list.parameters as Array<{ name?: string; $ref?: string }>).map((parameter) => parameter.name ?? parameter.$ref);
    expect(names).toEqual(["type", "from", "to", "correlationId", "actor", "subject", "#/components/parameters/Limit", "#/components/parameters/Cursor"]);
    expect(openapi["components"].parameters.Limit.schema).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
    expect(list.parameters[0]).toMatchObject({ style: "form", explode: true, schema: { type: "array" } });
  });

  it("validates the query parameters of the list as documented: same names, same limits, same defaults, same types", () => {
    const list = openapi["paths"]["/v1/audit"].get;
    const documented: Record<string, any> = {};
    for (const parameter of list.parameters as Array<{ name?: string; $ref?: string; schema?: unknown }>) {
      const resolved = parameter.$ref ? openapi["components"].parameters[parameter.$ref.split("/").pop() ?? ""] : parameter;
      documented[resolved.name] = resolved.schema;
    }
    const implemented = schemas.list.querystring.properties as Record<string, any>;
    expect(Object.keys(implemented).sort()).toEqual(Object.keys(documented).sort());
    for (const [name, schema] of Object.entries(documented)) {
      for (const key of ["type", "format", "minimum", "maximum", "default", "minLength", "maxLength", "maxItems"]) {
        expect(implemented[name][key], `${name}.${key}`).toEqual(schema[key]);
      }
    }
  });

  describe("agrees with the domain", () => {
    const entries: AuditEntry[] = [];
    entries.push(buildEntry(receivedEvent({ data: { marketId: MARKET_ID, adminId: "admin-1", question: "Q?" } }), EVENT_TIME, null));
    entries.push(buildEntry(receivedEvent({ id: eventId(2), correlationid: undefined, causationid: undefined, data: [1, "x"] }), EVENT_TIME, { seq: 1, hash: (entries[0] as AuditEntry).hash }));

    const asJson = (entry: AuditEntry) => ({
      seq: entry.seq,
      eventId: entry.eventId,
      eventType: entry.eventType,
      source: entry.source,
      subject: entry.subject,
      actor: entry.actor,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
      correlationId: entry.correlationId,
      causationId: entry.causationId,
      payload: entry.payload,
      prevHash: entry.prevHash,
      hash: entry.hash,
    });

    it("accepts a page of entries as the domain builds them, null actor and any payload included", () => {
      expect(responseErrors("/v1/audit", "get", 200, { items: entries.map(asJson).reverse(), nextCursor: null })).toEqual([]);
      expect(responseErrors("/v1/audit", "get", 200, { items: [], nextCursor: "abc" })).toEqual([]);
    });

    it("rejects an entry that lacks a field, has a bad hash or a seq below 1", () => {
      const good = asJson(entries[0] as AuditEntry);
      const { hash: _hash, ...withoutHash } = good;
      expect(responseErrors("/v1/audit", "get", 200, { items: [withoutHash], nextCursor: null })).not.toEqual([]);
      expect(responseErrors("/v1/audit", "get", 200, { items: [{ ...good, hash: "abc" }], nextCursor: null })).not.toEqual([]);
      expect(responseErrors("/v1/audit", "get", 200, { items: [{ ...good, seq: 0 }], nextCursor: null })).not.toEqual([]);
      expect(responseErrors("/v1/audit", "get", 200, { items: [good] })).not.toEqual([]);
    });

    it("accepts what the verification returns, intact or broken", () => {
      expect(responseErrors("/v1/audit/verify", "get", 200, verifyChain(entries))).toEqual([]);
      expect(responseErrors("/v1/audit/verify", "get", 200, verifyChain([entries[1] as AuditEntry]))).toEqual([]);
      expect(responseErrors("/v1/audit/verify", "get", 200, { valid: true, entries: 0 })).not.toEqual([]);
    });

    it("accepts the problem the web layer sends", () => {
      const problem = { type: "urn:chance:problem:forbidden", title: "Forbidden", status: 403, detail: "The tenant-admin role is required", instance: "/v1/audit", code: "forbidden" };
      expect(responseErrors("/v1/audit", "get", 403, problem)).toEqual([]);
    });

    it("pins the same hash rule as README.md and the unit test: the worked example is in the file", () => {
      const readme = readFileSync(new URL("../../contracts/README.md", import.meta.url), "utf8");
      const example = {
        seq: 1,
        prevHash: GENESIS_HASH,
        eventId: "018f3c1e-7a00-7000-8000-000000000001",
        eventType: "si.chance.markets.MarketOpened.v1",
        source: "/chance/markets",
        subject: MARKET_ID,
        actor: "admin-1",
        occurredAt: EVENT_TIME,
        correlationId: "corr-1",
        causationId: null,
        payload: { marketId: MARKET_ID, question: "Q?", version: 1 },
      };
      expect(readme).toContain(canonicalEntry(example));
      expect(readme).toContain(computeHash(example));
    });
  });
});

describe("contracts/asyncapi.yaml", () => {
  it("is AsyncAPI 3.0 with one channel and one receive operation per stream, and no send operation", () => {
    expect(asyncapi["asyncapi"]).toMatch(/^3\.0\./);
    const addresses = Object.values(asyncapi["channels"] as Record<string, { address: string }>).map((channel) => channel.address).sort();
    expect(addresses).toEqual(CONSUMED_STREAMS.map((stream) => `${stream.subjects.replace(/>$/, "")}{event}.{tenantId}`).sort());
    const operations = Object.values(asyncapi["operations"] as Record<string, { action: string; summary: string }>);
    expect(operations).toHaveLength(CONSUMED_STREAMS.length);
    expect(operations.every((operation) => operation.action === "receive")).toBe(true);
    for (const { stream, consumer } of CONSUMED_STREAMS) {
      expect(operations.some((operation) => operation.summary.includes(`\`${consumer}\``) && operation.summary.includes(stream)), stream).toBe(true);
    }
  });

  it("accepts the envelope of any event, of a known type or of one nobody has seen, with or without data", () => {
    expect(eventErrors("CloudEventEnvelope", cloudEvent())).toEqual([]);
    expect(eventErrors("CloudEventEnvelope", cloudEvent({ type: "si.chance.future.WidgetRetired.v9", source: "/chance/future", data: { anything: [1, 2] } }))).toEqual([]);
    const minimal = { specversion: "1.0", id: "e-1", source: "/chance/payments", type: "t", tenantid: "018f3c1e-7a00-7000-8000-0000000000aa" };
    expect(eventErrors("CloudEventEnvelope", minimal)).toEqual([]);
  });

  it.each(["specversion", "id", "source", "type", "tenantid"])("rejects an envelope without %s", (attribute) => {
    const event = cloudEvent();
    delete event[attribute];
    expect(eventErrors("CloudEventEnvelope", event)).not.toEqual([]);
  });

  it("rejects a wrong specversion, a tenant id that is no UUID and an empty id", () => {
    expect(eventErrors("CloudEventEnvelope", cloudEvent({ specversion: "0.3" }))).not.toEqual([]);
    expect(eventErrors("CloudEventEnvelope", cloudEvent({ tenantid: "acme" }))).not.toEqual([]);
    expect(eventErrors("CloudEventEnvelope", cloudEvent({ id: "" }))).not.toEqual([]);
  });
});
