// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).
// The log is only ever read and appended to: no port has a method that changes or removes an entry.
import type { AuditEntry, ChainHead } from "../domain/audit-entry.js";
import type { ReceivedEvent } from "../domain/envelope.js";

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/** What a list asks for: every field that is set narrows the result (all together), and the rest is a page of the log. */
export interface EntryQuery {
  /** Exact event types, any of them; empty = every type. */
  types: readonly string[];
  /** occurred_at at or after this time. */
  from: Date | null;
  /** occurred_at before or at this time. */
  to: Date | null;
  correlationId: string | null;
  actor: string | null;
  subject: string | null;
  /** Only entries with a lower seq than this (the position of the cursor); null = from the newest. */
  before: number | null;
  /** The most entries to return. */
  limit: number;
}

/** The log of one tenant, inside the transaction that chose the tenant (see Store.tenantTransaction). */
export interface EntryRepository {
  /**
   * Appends the entry that follows the end of the chain. The tenant's append lock is taken first, then the end of the
   * chain is read and handed to `build`, then the entry is stored, so two appends of one tenant never see the same end.
   * Returns the entry, or null when an entry with the same event id exists already (nothing is stored then).
   */
  append(build: (head: ChainHead | null) => AuditEntry): Promise<AuditEntry | null>;
  /** The entries that match, newest first (highest seq first). */
  list(query: EntryQuery): Promise<AuditEntry[]>;
  /** The entries after `afterSeq` (0 = from the start) in order of seq, at most `limit`: a page of the chain for the verification. */
  readChain(afterSeq: number, limit: number): Promise<AuditEntry[]>;
}

export interface InboxRepository {
  /**
   * Remembers that the consumer processed the event; false when it did so before (a redelivery), true the first time.
   * Called in the transaction of the entry, so the row exists exactly when the entry does.
   */
  markProcessed(consumer: string, event: { id: string; type: string }, at: Date): Promise<boolean>;
}

/** What a transaction on one tenant can use. */
export interface TenantRepositories {
  inbox: InboxRepository;
  entries: EntryRepository;
}

export interface TenantTransactionOptions {
  /**
   * Creates the tenant's schema, migrates it and registers the tenant first, inside the same transaction (TenantCreated),
   * stamped with this time. Without it, a tenant that has no schema yet throws TenantNotReady.
   */
  provisionAt?: Date;
}

export interface Store {
  /** Cheap check that the store answers (readiness). */
  ping(): Promise<void>;
  /**
   * One transaction on one tenant: the work and the commit, or nothing (ROLLBACK when the work throws). The tenant's
   * schema is chosen here and only here. Throws TenantNotReady when the tenant has no schema.
   */
  tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>, options?: TenantTransactionOptions): Promise<T>;
}

export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  logger: Logger;
}

/** What the consumer hands over for one valid envelope. It resolves after the commit and throws to have the event delivered again. */
export type ConsumedEventHandler = (event: ReceivedEvent) => Promise<void>;
