import { describe, expect, it } from "vitest";
import { RETRY_MAX_MS, handleDelivery, retryDelayMs } from "../../src/adapters/events/delivery.js";
import type { Delivery } from "../../src/adapters/events/delivery.js";
import type { ReceivedEvent } from "../../src/domain/envelope.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { recordEventHandler } from "../../src/usecases/record-event.js";
import { MARKET_ID, RecordingLogger, TENANT_A, cloudEvent, createCore, eventId, tenantCreated } from "../support/harness.js";

const json = (overrides: Record<string, unknown> = {}): string => JSON.stringify(cloudEvent(overrides));

function delivery(text: string, deliveryCount = 1) {
  const calls: string[] = [];
  const message: Delivery & { calls: string[]; delay?: number; reason?: string } = {
    data: new TextEncoder().encode(text),
    subject: `chance.markets.MarketOpened.${TENANT_A}`,
    deliveryCount,
    calls,
    ack: () => calls.push("ack"),
    nak: (delayMs) => {
      calls.push("nak");
      message.delay = delayMs;
    },
    term: (reason) => {
      calls.push("term");
      message.reason = reason;
    },
  };
  return message;
}

describe("retryDelayMs", () => {
  it("doubles from one second and stops at thirty", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    expect(retryDelayMs(500)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(0)).toBe(1000);
  });
});

describe("handleDelivery", () => {
  it("parses the event, hands it over and acknowledges only after the handler has finished", async () => {
    const message = delivery(json());
    let received: ReceivedEvent | null = null;
    let finished = false;
    const result = await handleDelivery(
      message,
      async (event) => {
        received = event;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(message.calls).toEqual([]);
        finished = true;
      },
      new RecordingLogger(),
    );
    expect(result).toBe("acked");
    expect(finished).toBe(true);
    expect(message.calls).toEqual(["ack"]);
    expect(received).toMatchObject({ id: eventId(1), tenantId: TENANT_A, data: { marketId: MARKET_ID } });
  });

  it("asks for a redelivery with a growing delay when the handler fails, and never acknowledges", async () => {
    const logger = new RecordingLogger();
    for (const [count, delay] of [[1, 1000], [3, 4000], [40, 30_000]] as const) {
      const message = delivery(json(), count);
      expect(await handleDelivery(message, () => Promise.reject(new Error("database is down")), logger)).toBe("retry");
      expect(message.calls).toEqual(["nak"]);
      expect(message.delay).toBe(delay);
    }
    expect(logger.lines.map((line) => line.level)).toEqual(["warn", "warn", "warn"]);
  });

  it("a tenant that has no log yet is a retry with the same delay, logged as information and not as a failure", async () => {
    const message = delivery(json(), 2);
    const logger = new RecordingLogger();
    expect(await handleDelivery(message, () => Promise.reject(new TenantNotReady(TENANT_A)), logger)).toBe("retry");
    expect(message.calls).toEqual(["nak"]);
    expect(message.delay).toBe(2000);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { eventId: eventId(1), tenantId: TENANT_A, deliveryCount: 2 } });
  });

  it("terminates a message that is not JSON, without logging its body", async () => {
    const message = delivery("{not json: secret-looking-text");
    const logger = new RecordingLogger();
    expect(await handleDelivery(message, () => Promise.reject(new Error("must not be called")), logger)).toBe("dropped");
    expect(message.calls).toEqual(["term"]);
    expect(message.reason).toBe("not JSON");
    expect(JSON.stringify(logger.lines)).not.toContain("secret-looking-text");
    expect(logger.lines[0]).toMatchObject({ level: "error", fields: { subject: `chance.markets.MarketOpened.${TENANT_A}` } });
  });

  it.each([
    ["no id", { id: undefined }],
    ["no type", { type: undefined }],
    ["no source", { source: undefined }],
    ["no tenant id", { tenantid: undefined }],
    ["a tenant id that is no UUID", { tenantid: "acme" }],
    ["another specversion", { specversion: "0.3" }],
    ["data a jsonb column cannot hold", { data: { text: "a\u0000b" } }],
  ])("terminates an envelope with %s", async (_label, overrides) => {
    const message = delivery(json(overrides));
    const logger = new RecordingLogger();
    expect(await handleDelivery(message, () => Promise.reject(new Error("must not be called")), logger)).toBe("dropped");
    expect(message.calls).toEqual(["term"]);
    expect(message.reason).toBe("not a valid CloudEvent");
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe("error");
  });

  it("terminates a JSON value that is no object, a list for example", async () => {
    const message = delivery("[1, 2]");
    expect(await handleDelivery(message, () => Promise.resolve(), new RecordingLogger())).toBe("dropped");
    expect(message.calls).toEqual(["term"]);
  });

  it("records an event of a type nobody knows: it is acknowledged like any other", async () => {
    const core = createCore();
    const handler = recordEventHandler(core.deps, "audit-test");
    const first = delivery(JSON.stringify(tenantCreated(TENANT_A, 1)));
    const second = delivery(json({ id: eventId(5), type: "si.chance.future.WidgetRetired.v9", source: "/chance/future" }));
    expect(await handleDelivery(first, handler, core.events)).toBe("acked");
    expect(await handleDelivery(second, handler, core.events)).toBe("acked");
    expect([first.calls, second.calls]).toEqual([["ack"], ["ack"]]);
    expect((await core.useCases.listEntries(TENANT_A, {})).items.map((entry) => entry.eventType)).toEqual(["si.chance.future.WidgetRetired.v9", "si.chance.tenants.TenantCreated.v1"]);
  });

  it("an event of a tenant whose TenantCreated has not been processed is nak'ed, and acknowledged once it has", async () => {
    const core = createCore();
    const handler = recordEventHandler(core.deps, "audit-test");
    const early = delivery(json());
    expect(await handleDelivery(early, handler, core.events)).toBe("retry");
    expect(early.calls).toEqual(["nak"]);
    expect(await handleDelivery(delivery(JSON.stringify(tenantCreated(TENANT_A, 2))), handler, core.events)).toBe("acked");
    const again = delivery(json(), 2);
    expect(await handleDelivery(again, handler, core.events)).toBe("acked");
    expect((await core.useCases.listEntries(TENANT_A, {})).items.map((entry) => entry.seq)).toEqual([2, 1]);
  });
});
