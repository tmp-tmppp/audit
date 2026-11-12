import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The log is append-only. The database refuses UPDATE, DELETE and TRUNCATE with a trigger (tests/integration), and the
// service has no code path that would try: no statement in src/ changes, removes or drops an entry or its table.

const SRC = new URL("../../src/", import.meta.url).pathname;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["UPDATE of audit_entries", /\bUPDATE\s+(?:"?\w+"?\.)?audit_entries\b/i],
  ["DELETE from audit_entries", /\bDELETE\s+FROM\s+(?:"?\w+"?\.)?audit_entries\b/i],
  ["TRUNCATE", /\bTRUNCATE\b/i],
  ["DROP of the table, the trigger or the schema", /\bDROP\s+(?:TABLE|TRIGGER|SCHEMA)\b/i],
  ["ALTER of audit_entries", /\bALTER\s+TABLE\s+(?:"?\w+"?\.)?audit_entries\b/i],
  ["a trigger switched off", /\bDISABLE\s+TRIGGER\b/i],
];

describe("append-only", () => {
  it("scans the source files (so that the check below is not empty)", () => {
    const names = files(SRC).map((path) => path.slice(SRC.length));
    expect(names).toContain("adapters/postgres/postgres-repositories.ts");
    expect(names).toContain("usecases/record-event.ts");
  });

  it.each(FORBIDDEN)("no source file contains %s", (_label, pattern) => {
    const offenders = files(SRC).filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => path.slice(SRC.length))).toEqual([]);
  });

  it("the ports have no method that changes or removes an entry", () => {
    const ports = readFileSync(join(SRC, "usecases/ports.ts"), "utf8");
    const methods = [...ports.matchAll(/^\s{2}(\w+)[<(]/gm)].map((match) => match[1]);
    expect(methods.filter((name) => /^(update|delete|remove|purge|truncate|clear|set|save|replace|edit|modify)/i.test(name ?? ""))).toEqual([]);
  });
});
