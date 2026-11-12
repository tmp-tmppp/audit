import pg from "pg";
import type { Logger, Store, TenantRepositories, TenantTransactionOptions } from "../../usecases/ports.js";
import { provisionTenantSchema } from "./migrate.js";
import { entryRepository, inboxRepository } from "./postgres-repositories.js";
import { useTenantSchema } from "./tenant-scope.js";

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The store of the service's own PostgreSQL database. The schemas and tables come from migrations/ (migrate.ts); a
 * tenant's schema is chosen only by useTenantSchema (tenant-scope.ts), called here and nowhere else.
 */
export class PostgresStore implements Store {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger = silent,
  ) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /** One transaction on one connection: BEGIN, the work, COMMIT; ROLLBACK when the work throws. */
  async tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>, options: TenantTransactionOptions = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // TenantCreated: the schema is created, migrated and registered in this transaction, so that an event that is
      // rolled back leaves no schema behind and the entry of the event is in the schema it created.
      if (options.provisionAt !== undefined) await provisionTenantSchema(client, tenantId, options.provisionAt, this.logger);
      await useTenantSchema(client, tenantId);
      const result = await work({ inbox: inboxRepository(client), entries: entryRepository(client, tenantId) });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
}
