// The streams audit consumes: one JetStream stream per publishing service (ADR-053), and one durable consumer on each.
// audit publishes nothing. contracts/asyncapi.yaml lists the same four.

export interface ConsumedStream {
  /** The JetStream stream, created by its publisher. */
  stream: string;
  /** The subjects the stream holds: chance.<service>.<Event>.<tenantId>. */
  subjects: string;
  /** The durable consumer audit owns on the stream; also the "consumer" of its inbox rows. */
  consumer: string;
}

export const CONSUMED_STREAMS: readonly ConsumedStream[] = [
  { stream: "TENANTS", subjects: "chance.tenants.>", consumer: "audit-tenants" },
  { stream: "PAYMENTS", subjects: "chance.payments.>", consumer: "audit-payments" },
  { stream: "MARKETS", subjects: "chance.markets.>", consumer: "audit-markets" },
  { stream: "TRADING", subjects: "chance.trading.>", consumer: "audit-trading" },
];
