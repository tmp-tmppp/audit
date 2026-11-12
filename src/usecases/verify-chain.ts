import { ChainVerifier } from "../domain/hash-chain.js";
import type { VerifyResult } from "../domain/hash-chain.js";
import type { UseCaseDeps } from "./ports.js";

/** How many entries are read from the store at a time: the log is never held whole in memory. */
export const VERIFY_PAGE_SIZE = 500;

/**
 * Recomputes the hash chain of the tenant's log: reads every entry in order of seq, page by page, and feeds it to the
 * verifier (numbers without a gap, each entry naming the hash of the one before it, each stored hash the hash of its
 * fields). Every page is read in a transaction of its own, so a verification holds a pooled connection for one page at a
 * time and never for the length of the log: the consumers and the readiness probe always find one. The log is append-only,
 * so reading it in pieces gives the same result as reading it at once. Entries appended while it runs are checked too when
 * its read reaches them; they chain correctly or not, whatever the time. A tenant with no entries is valid with 0 entries;
 * a tenant without a log yet is TenantNotReady.
 */
export async function verifyAuditChain(deps: UseCaseDeps, tenantId: string, pageSize: number = VERIFY_PAGE_SIZE): Promise<VerifyResult> {
  const verifier = new ChainVerifier();
  let after = 0;
  for (;;) {
    const cursor = after;
    const page = await deps.store.tenantTransaction(tenantId, (repositories) => repositories.entries.readChain(cursor, pageSize));
    for (const entry of page) verifier.push(entry);
    const last = page.at(-1);
    if (last === undefined || page.length < pageSize) break;
    after = last.seq;
  }
  return verifier.result();
}
