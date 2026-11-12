import { describe, expect, it } from "vitest";
import { TEXT_MAX_LENGTH, boundedText, isTenantCreated, isUuid, parseReceivedEvent } from "../../src/domain/envelope.js";
import { MAX_JSON_DEPTH } from "../../src/domain/json.js";
import { EVENT_TIME, MARKET_ID, TENANT_A, cloudEvent, eventId } from "../support/harness.js";

describe("parseReceivedEvent", () => {
  it("reads the envelope of a valid event and keeps the data as it came", () => {
    expect(parseReceivedEvent(cloudEvent())).toEqual({
      id: eventId(1),
      type: "si.chance.markets.MarketOpened.v1",
      source: "/chance/markets",
      tenantId: TENANT_A,
      time: EVENT_TIME,
      correlationId: "corr-1",
      causationId: "req-1",
      data: { marketId: MARKET_ID, question: "Will it rain?", version: 1 },
    });
  });

  it("reads what a NATS message holds: the JSON text of the event", () => {
    const body = JSON.stringify(cloudEvent());
    expect(parseReceivedEvent(JSON.parse(body))?.id).toBe(eventId(1));
  });

  it("lower-cases the tenant id", () => {
    expect(parseReceivedEvent(cloudEvent({ tenantid: TENANT_A.toUpperCase() }))?.tenantId).toBe(TENANT_A);
  });

  it.each(["specversion", "id", "type", "source", "tenantid"])("refuses an event without %s", (attribute) => {
    const event = cloudEvent();
    delete event[attribute];
    expect(parseReceivedEvent(event)).toBeNull();
  });

  it.each([
    [{ specversion: "0.3" }],
    [{ specversion: 1 }],
    [{ id: "" }],
    [{ id: 7 }],
    [{ id: "x".repeat(TEXT_MAX_LENGTH + 1) }],
    [{ id: "a\u0000b" }],
    [{ type: "" }],
    [{ type: null }],
    [{ source: "" }],
    [{ source: ["/chance/markets"] }],
    [{ tenantid: "acme" }],
    [{ tenantid: "" }],
    [{ tenantid: 5 }],
    [{ tenantid: `${TENANT_A}; DROP SCHEMA shared` }],
  ])("refuses an event with %j", (overrides) => {
    expect(parseReceivedEvent(cloudEvent(overrides))).toBeNull();
  });

  it.each([[null], [undefined], ["text"], [42], [[]], [[cloudEvent()]]])("refuses %j, which is no object", (value) => {
    expect(parseReceivedEvent(value)).toBeNull();
  });

  it("accepts an id, type and source of exactly 255 characters", () => {
    const long = "x".repeat(TEXT_MAX_LENGTH);
    expect(parseReceivedEvent(cloudEvent({ id: long, type: long, source: long }))).toMatchObject({ id: long, type: long, source: long });
  });

  it("takes an empty object for an event without data, or with null data", () => {
    const withoutData = cloudEvent();
    delete withoutData["data"];
    expect(parseReceivedEvent(withoutData)?.data).toEqual({});
    expect(parseReceivedEvent(cloudEvent({ data: null }))?.data).toEqual({});
  });

  it("records data that is no object as it was received", () => {
    expect(parseReceivedEvent(cloudEvent({ data: "text" }))?.data).toBe("text");
    expect(parseReceivedEvent(cloudEvent({ data: [1, 2] }))?.data).toEqual([1, 2]);
    expect(parseReceivedEvent(cloudEvent({ data: 7 }))?.data).toBe(7);
  });

  it("refuses data that a jsonb column cannot hold, so that the message is terminated instead of failing for ever", () => {
    expect(parseReceivedEvent(cloudEvent({ data: { note: "a\u0000b" } }))).toBeNull();
    expect(parseReceivedEvent(cloudEvent({ data: { "a\u0000b": 1 } }))).toBeNull();
    let deep: unknown = 1;
    for (let level = 0; level <= MAX_JSON_DEPTH + 1; level += 1) deep = { next: deep };
    expect(parseReceivedEvent(cloudEvent({ data: deep }))).toBeNull();
  });

  it("is not tripped by a text that only looks like a NUL escape", () => {
    expect(parseReceivedEvent(JSON.parse('{"specversion":"1.0","id":"e","type":"t","source":"s","tenantid":"' + TENANT_A + '","data":{"note":"\\\\u0000"}}'))?.data).toEqual({
      note: "\\u0000",
    });
  });

  it("reads the time with an offset or fractions of a second, and takes null for a time that is missing or invalid", () => {
    expect(parseReceivedEvent(cloudEvent({ time: "2026-11-01T12:00:00+02:00" }))?.time).toEqual(EVENT_TIME);
    expect(parseReceivedEvent(cloudEvent({ time: "2026-11-01T10:00:00.123456Z" }))?.time).toEqual(new Date("2026-11-01T10:00:00.123Z"));
    const withoutTime = cloudEvent();
    delete withoutTime["time"];
    expect(parseReceivedEvent(withoutTime)?.time).toBeNull();
    for (const time of ["yesterday", "2026-11-01", "2026-13-45T10:00:00Z", "", 12, null, "2026-11-01 10:00:00Z"]) {
      const event = parseReceivedEvent(cloudEvent({ time }));
      expect(event, `time ${String(time)}`).not.toBeNull();
      expect(event?.time, `time ${String(time)}`).toBeNull();
    }
  });

  it("takes null for a correlation or causation id that is missing, empty, too long or not a text", () => {
    for (const value of [undefined, "", "x".repeat(TEXT_MAX_LENGTH + 1), 5, null, "a\u0000b"]) {
      const event = parseReceivedEvent(cloudEvent({ correlationid: value, causationid: value }));
      expect(event, `value ${String(value)}`).not.toBeNull();
      expect(event?.correlationId).toBeNull();
      expect(event?.causationId).toBeNull();
    }
  });

  it("records an event of a type nobody knows, from a source nobody knows", () => {
    expect(parseReceivedEvent(cloudEvent({ type: "si.chance.future.SomethingNew.v9", source: "/chance/future" }))).toMatchObject({
      type: "si.chance.future.SomethingNew.v9",
      source: "/chance/future",
    });
  });
});

describe("isUuid and boundedText", () => {
  it("tell a UUID and a usable text from the rest", () => {
    expect(isUuid(TENANT_A)).toBe(true);
    expect(isUuid(TENANT_A.toUpperCase())).toBe(true);
    expect(isUuid("acme")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(boundedText("x")).toBe("x");
    expect(boundedText("")).toBeNull();
    expect(boundedText("x".repeat(256))).toBeNull();
    expect(boundedText(1)).toBeNull();
  });
});

describe("isTenantCreated", () => {
  it.each(["si.chance.tenants.TenantCreated.v1", "si.chance.tenants.TenantCreated.v2", "si.chance.tenants.TenantCreated.v10"])("is true for %s", (type) => {
    expect(isTenantCreated({ type })).toBe(true);
  });

  it.each([
    "si.chance.tenants.MemberJoined.v1",
    "si.chance.markets.TenantCreated.v1",
    "si.chance.tenants.TenantCreated",
    "si.chance.tenants.TenantCreated.v1.extra",
    "x.si.chance.tenants.TenantCreated.v1",
    "",
  ])("is false for %j", (type) => {
    expect(isTenantCreated({ type })).toBe(false);
  });
});
