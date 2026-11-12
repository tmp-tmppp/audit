import { Writable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { parseReceivedEvent } from "../../src/domain/envelope.js";
import type { ReceivedEvent } from "../../src/domain/envelope.js";
import { createLogger } from "../../src/logger.js";
import { createUseCases } from "../../src/usecases/application.js";
import { NotFound, TenantNotReady, ValidationFailed } from "../../src/usecases/errors.js";
import type { Clock, Logger, UseCaseDeps } from "../../src/usecases/ports.js";
import { recordEventHandler } from "../../src/usecases/record-event.js";
import { buildApp } from "../../src/web/app.js";
import type { WebDeps } from "../../src/web/app.js";
import { authenticate, requireAuth, requireTenantAdmin } from "../../src/web/auth.js";
import type { AuthOptions } from "../../src/web/auth.js";
import { AUDIENCE, ISSUER, createTestKeys } from "./tokens.js";

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";
export const MARKET_ID = "018f3c1e-7a00-7000-8000-0000000000b1";
export const EVENT_TIME = new Date("2026-11-01T10:00:00.000Z");

export class TestClock implements Clock {
  constructor(private current = EVENT_TIME) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
}

/** The id of the n-th test event: a UUID, so that it looks like the UUIDv7 of the publishers. */
export const eventId = (n: number): string => `018f3c1e-7a00-7000-8000-${String(n).padStart(12, "0")}`;

/** A CloudEvent as a publisher sends it (the parsed JSON body of a NATS message); `overrides` replace attributes. */
export function cloudEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id: eventId(1),
    type: "si.chance.markets.MarketOpened.v1",
    source: "/chance/markets",
    subject: `market/${MARKET_ID}`,
    time: EVENT_TIME.toISOString(),
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { marketId: MARKET_ID, question: "Will it rain?", version: 1 },
    ...overrides,
  };
}

/** The TenantCreated of the tenants service: the first event of every tenant. */
export const tenantCreated = (tenantId: string, n = 1): Record<string, unknown> =>
  cloudEvent({ id: eventId(n), type: "si.chance.tenants.TenantCreated.v1", source: "/chance/tenants", subject: `tenant/${tenantId}`, tenantid: tenantId, data: { tenantId, name: "Acme" } });

function parseOrFail(envelope: Record<string, unknown>): ReceivedEvent {
  const event = parseReceivedEvent(envelope);
  if (event === null) throw new Error("The test event is not valid");
  return event;
}

/** The parsed envelope of cloudEvent(overrides); the test fails when the parser refuses it. */
export function receivedEvent(overrides: Record<string, unknown> = {}): ReceivedEvent {
  return parseOrFail(cloudEvent(overrides));
}

/** The use cases over the in-memory store, a clock and a recording logger, without a web application. */
export function createCore() {
  const store = new MemoryStore();
  const clock = new TestClock();
  const events = new RecordingLogger();
  const deps: UseCaseDeps = { store, clock, logger: events };
  const useCases = createUseCases(deps);
  const handler = recordEventHandler(deps, "audit-test");
  return {
    store,
    clock,
    events,
    deps,
    useCases,
    /** What the broker's message turns into: the consumer's handler applied to a whole CloudEvent (see cloudEvent). */
    record: (envelope: Record<string, unknown>): Promise<void> => handler(parseOrFail(envelope)),
  };
}

/**
 * The web application over the in-memory store, with real JWT verification against a local key. With `probes`, routes
 * that exist only in tests exercise the guards and the error mapping before the real routes exist.
 */
export async function createHarness(options: { probes?: boolean; pingFails?: boolean; metrics?: WebDeps["metrics"] } = {}) {
  const { store, clock, events, deps, useCases, record } = createCore();
  const keys = await createTestKeys();
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const auth: AuthOptions = { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" };
  const app = buildApp({
    logger: createLogger("info", sink),
    auth,
    health: { ping: () => (options.pingFails ? Promise.reject(new Error("database is down")) : store.ping()), isDraining: () => draining },
    useCases,
    metrics: options.metrics,
  });
  if (options.probes) {
    const onRequest = authenticate(auth);
    app.get("/_probe/whoami", { onRequest }, (request) => ({ userId: requireAuth(request).userId }));
    app.get("/_probe/tenant-admin", { onRequest }, (request) => ({ tenantId: requireTenantAdmin(request) }));
    app.get("/_probe/not-ready", { onRequest }, () => {
      throw new TenantNotReady(TENANT_A);
    });
    app.get("/_probe/not-found", { onRequest }, () => {
      throw new NotFound("entry_not_found", "No such entry");
    });
    app.get("/_probe/invalid", { onRequest }, () => {
      throw new ValidationFailed([{ field: "limit", message: "must be at most 100" }]);
    });
    app.get("/_probe/boom", { onRequest }, () => {
      throw new Error("something unexpected");
    });
  }
  await app.ready();

  /** Authorization header for a token with the given claims. */
  async function bearer(tokenOptions?: Parameters<typeof keys.sign>[0]) {
    return { authorization: `Bearer ${await keys.sign(tokenOptions)}` };
  }

  return {
    app,
    store,
    clock,
    deps,
    useCases,
    /** What the use cases logged. */
    events,
    /** The consumer's handler of one received event: what the broker's message turns into (a CloudEvent with `overrides`, or a whole envelope). */
    record,
    keys,
    logLines,
    bearer,
    /** From now on the key resolver rejects with this error; null makes it work again. */
    failKeys: (error: unknown): void => {
      keyFailure = error;
    },
    /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
    setDraining: (value: boolean): void => {
      draining = value;
    },
  };
}
