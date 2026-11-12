import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { useTenantSchema } from "../../src/adapters/postgres/tenant-scope.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { TENANT_A } from "../support/harness.js";

// The SQL itself runs against PostgreSQL in tests/integration. These tests check, with a fake connection that records
// every statement, that the tenant schema is chosen in one place and only after the id is checked.

interface Statement {
  sql: string;
  params: unknown[] | undefined;
}

class FakeClient {
  readonly statements: Statement[] = [];
  /** Tenants the registry knows (lower case). */
  registered = new Set<string>();

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push({ sql, params });
    if (sql.startsWith("SELECT 1 FROM shared.tenant_registry")) {
      const known = this.registered.has(String(params?.[0]));
      return Promise.resolve({ rows: known ? [{ "?column?": 1 }] : [], rowCount: known ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  get sqls(): string[] {
    return this.statements.map((statement) => statement.sql.replace(/\s+/g, " ").trim());
  }
}

const asDb = (client: FakeClient) => client as unknown as Pick<pg.PoolClient, "query">;

describe("useTenantSchema", () => {
  it("sets the quoted schema of a registered tenant as the search path of the transaction, in lower case", async () => {
    const client = new FakeClient();
    client.registered.add(TENANT_A);
    const schema = await useTenantSchema(asDb(client), TENANT_A.toUpperCase());
    expect(schema).toBe(tenantSchemaName(TENANT_A));
    expect(client.statements).toHaveLength(2);
    expect(client.statements[0]).toMatchObject({ params: [TENANT_A] });
    expect(client.sqls[1]).toBe("SELECT set_config('search_path', $1, true)");
    expect(client.statements[1]?.params).toEqual([`"${tenantSchemaName(TENANT_A)}"`]);
  });

  it.each(["", "acme", `${TENANT_A}; DROP SCHEMA shared`, 'x"; --', "tenant_018f3c1e7a0070008000" + "0000000000aa", `${TENANT_A}\n`])(
    "refuses %j before any statement runs",
    async (value) => {
      const client = new FakeClient();
      await expect(useTenantSchema(asDb(client), value)).rejects.toThrow("A tenant id must be a UUID");
      expect(client.statements).toHaveLength(0);
    },
  );

  it("throws TenantNotReady for a tenant without a schema and does not touch the search path", async () => {
    const client = new FakeClient();
    const error = await useTenantSchema(asDb(client), TENANT_A).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantNotReady);
    expect(error).toMatchObject({ kind: "unavailable", code: "tenant_not_ready", retryAfterSeconds: 5, tenantId: TENANT_A });
    expect(client.sqls.some((sql) => sql.includes("set_config"))).toBe(false);
  });

  it("is the only place in src that names a search path (migrate.ts does so for its own schema)", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const naming = files.filter((file) => /search_path|set_config/.test(readFileSync(file, "utf8"))).map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(naming.sort()).toEqual(["adapters/postgres/migrate.ts", "adapters/postgres/tenant-scope.ts"]);
  });
});
