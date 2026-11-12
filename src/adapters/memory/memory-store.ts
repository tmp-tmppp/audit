import type { AuditEntry, ChainHead } from "../../domain/audit-entry.js";
import { isUuid } from "../../domain/envelope.js";
import { TenantNotReady } from "../../usecases/errors.js";
import type { EntryQuery, EntryRepository, InboxRepository, Store, TenantRepositories, TenantTransactionOptions } from "../../usecases/ports.js";

interface TenantLog {
  entries: AuditEntry[];
  eventIds: Set<string>;
}

const matches = (entry: AuditEntry, query: EntryQuery): boolean =>
  (query.types.length === 0 || query.types.includes(entry.eventType)) &&
  (query.from === null || entry.occurredAt.getTime() >= query.from.getTime()) &&
  (query.to === null || entry.occurredAt.getTime() <= query.to.getTime()) &&
  (query.correlationId === null || entry.correlationId === query.correlationId) &&
  (query.actor === null || entry.actor === query.actor) &&
  (query.subject === null || entry.subject === query.subject) &&
  (query.before === null || entry.seq < query.before);

/**
 * The store of APP_ENV=local and of the unit tests: everything in memory, mirroring the PostgreSQL store. A transaction
 * works on what it staged and commits it when the work resolves, or drops it when the work throws; transactions run one
 * after the other (the PostgreSQL store serializes the appends of a tenant with an advisory lock). A tenant that was not
 * provisioned is TenantNotReady, an event id is recorded once per tenant, and no method changes or removes an entry.
 */
export class MemoryStore implements Store {
  private readonly tenants = new Set<string>();
  private readonly inbox = new Set<string>();
  private readonly logs = new Map<string, TenantLog>();
  private tail: Promise<void> = Promise.resolve();

  ping(): Promise<void> {
    return Promise.resolve();
  }

  async tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>, options: TenantTransactionOptions = {}): Promise<T> {
    if (!isUuid(tenantId)) throw new Error("A tenant id must be a UUID");
    const id = tenantId.toLowerCase();
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const registered = this.tenants.has(id) || options.provisionAt !== undefined;
      if (!registered) throw new TenantNotReady(id);
      const log = this.logs.get(id) ?? { entries: [], eventIds: new Set<string>() };
      const stagedEntries: AuditEntry[] = [];
      const stagedInbox = new Set<string>();

      const head = (): ChainHead | null => {
        const last = stagedEntries.at(-1) ?? log.entries.at(-1);
        return last === undefined ? null : { seq: last.seq, hash: last.hash };
      };
      const inbox: InboxRepository = {
        markProcessed: (consumer, event) => {
          const key = `${consumer}\n${event.id}`;
          if (this.inbox.has(key) || stagedInbox.has(key)) return Promise.resolve(false);
          stagedInbox.add(key);
          return Promise.resolve(true);
        },
      };
      const entries: EntryRepository = {
        append: (build) => {
          const entry = build(head());
          if (log.eventIds.has(entry.eventId) || stagedEntries.some((staged) => staged.eventId === entry.eventId)) return Promise.resolve(null);
          stagedEntries.push(Object.freeze(entry));
          return Promise.resolve(entry);
        },
        list: (query) => Promise.resolve([...log.entries, ...stagedEntries].filter((entry) => matches(entry, query)).reverse().slice(0, query.limit)),
        readChain: (afterSeq, limit) => Promise.resolve([...log.entries, ...stagedEntries].filter((entry) => entry.seq > afterSeq).slice(0, limit)),
      };

      const result = await work({ inbox, entries });
      this.tenants.add(id);
      for (const key of stagedInbox) this.inbox.add(key);
      for (const entry of stagedEntries) {
        log.entries.push(entry);
        log.eventIds.add(entry.eventId);
      }
      this.logs.set(id, log);
      return result;
    } finally {
      release();
    }
  }
}
