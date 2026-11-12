import { buildEntry } from "../domain/audit-entry.js";
import { isTenantCreated } from "../domain/envelope.js";
import { CONSUMED_STREAMS } from "../domain/streams.js";
import type { ConsumedStream } from "../domain/streams.js";
import type { ConsumedEventHandler, UseCaseDeps } from "./ports.js";

// The only use case that writes: one received event becomes one entry. It runs in the transaction of the consumer
// (Store.tenantTransaction): the inbox row, the schema of a new tenant and the entry are committed together or not at
// all, and the message is acknowledged only after that (adapters/events/delivery.ts). A redelivery finds its inbox row
// and changes nothing. An event type audit has never seen is recorded like any other.

/**
 * The handler of one durable consumer. `consumer` is its name in the inbox (the durable name on the broker). TenantCreated
 * creates the tenant's schema first, and is recorded as the first entry of the tenant's log. An event of a tenant that has
 * no schema yet throws TenantNotReady, which rolls back the inbox row too: the consumer naks the message and the broker
 * delivers it again, by which time the TenantCreated of that tenant has been processed. Only the TENANTS stream's handler
 * may create a schema (provisionTenants): a TenantCreated that shows up on another stream is recorded like any other event
 * of a tenant, so a publisher cannot make audit create schemas for tenants that do not exist.
 */
export function recordEventHandler(deps: UseCaseDeps, consumer: string, options: { provisionTenants?: boolean } = {}): ConsumedEventHandler {
  const provisionTenants = options.provisionTenants ?? true;
  return async (event) => {
    const now = deps.clock.now();
    await deps.store.tenantTransaction(
      event.tenantId,
      async (repositories) => {
        if (!(await repositories.inbox.markProcessed(consumer, { id: event.id, type: event.type }, now))) {
          deps.logger.info({ eventId: event.id, eventType: event.type, tenantId: event.tenantId, consumer }, "An event with this id came in before on this consumer; acknowledged, not recorded again");
          return;
        }
        const entry = await repositories.entries.append((head) => buildEntry(event, now, head));
        if (entry === null) {
          deps.logger.warn({ eventId: event.id, eventType: event.type, tenantId: event.tenantId, consumer }, "An event with this id is recorded already; not recorded again");
          return;
        }
        deps.logger.info({ eventId: event.id, eventType: event.type, tenantId: event.tenantId, seq: entry.seq }, "Recorded an event");
      },
      provisionTenants && isTenantCreated(event) ? { provisionAt: now } : {},
    );
  };
}

/** One durable consumer per stream: the stream, its subjects, the durable name and the handler. */
export interface StreamHandler {
  stream: ConsumedStream;
  handler: ConsumedEventHandler;
}

/** The handlers of all four streams (TENANTS, PAYMENTS, MARKETS, TRADING), each under its own inbox consumer name. */
export function streamHandlers(deps: UseCaseDeps): StreamHandler[] {
  return CONSUMED_STREAMS.map((stream) => ({
    stream,
    handler: recordEventHandler(deps, stream.consumer, { provisionTenants: stream.stream === "TENANTS" }),
  }));
}
