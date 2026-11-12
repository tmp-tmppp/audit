import { parseReceivedEvent } from "../../domain/envelope.js";
import { TenantNotReady } from "../../usecases/errors.js";
import type { ConsumedEventHandler, Logger } from "../../usecases/ports.js";

// What happens to one message from the broker, apart from the broker itself (nats-event-consumer.ts feeds it): parse,
// hand over to the use case, and acknowledge only after the use case has finished, which is after its transaction has
// committed. A message is therefore never lost: a crash between the commit and the ack means a redelivery, and the inbox
// row stored in the same transaction as the entry turns that redelivery into a no-op.

/** The part of a JetStream message this module needs. */
export interface Delivery {
  data: Uint8Array;
  subject: string;
  /** 1 for the first delivery. */
  deliveryCount: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(reason?: string): void;
}

/** acked: recorded and acknowledged. retry: the handler failed, delivery is repeated later. dropped: it can never be recorded, no redelivery. */
export type DeliveryResult = "acked" | "retry" | "dropped";

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** Wait before the next delivery after the n-th failed one: 1, 2, 4 ... seconds, at most 30. */
export function retryDelayMs(deliveryCount: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(deliveryCount - 1, 0), 10));
}

/**
 * Only the subject of the message and the reason are logged for a message that is dropped, never its body: it is not
 * a valid event and could hold anything.
 */
export async function handleDelivery(delivery: Delivery, handler: ConsumedEventHandler, logger: Logger): Promise<DeliveryResult> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(delivery.data));
  } catch {
    logger.error({ subject: delivery.subject }, "A consumed message is not JSON; dropping it");
    delivery.term("not JSON");
    return "dropped";
  }
  const event = parseReceivedEvent(json);
  if (event === null) {
    logger.error({ subject: delivery.subject }, "A consumed message is not a CloudEvent with an id, a type, a source and a tenant id; dropping it");
    delivery.term("not a valid CloudEvent");
    return "dropped";
  }
  try {
    await handler(event);
  } catch (error) {
    // Never given up: the event is the record of something that happened. A tenant that is not ready yet (its
    // TenantCreated is still to come) and a database that is down pass; the messages behind it go on meanwhile.
    const fields = { eventId: event.id, subject: delivery.subject, deliveryCount: delivery.deliveryCount };
    if (error instanceof TenantNotReady) logger.info({ ...fields, tenantId: error.tenantId }, "The tenant of a consumed event has no log yet; it will be delivered again");
    else logger.warn({ ...fields, err: error }, "Recording a consumed event failed; it will be delivered again");
    delivery.nak(retryDelayMs(delivery.deliveryCount));
    return "retry";
  }
  delivery.ack();
  return "acked";
}
