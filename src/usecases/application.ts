import type { VerifyResult } from "../domain/hash-chain.js";
import { Unavailable } from "./errors.js";
import { listEntries } from "./list-entries.js";
import type { EntryPage, ListInput } from "./list-entries.js";
import type { UseCaseDeps } from "./ports.js";
import { verifyAuditChain } from "./verify-chain.js";

/** What the web layer calls. It knows nothing of ports, repositories or the broker (GP-6.28). */
export interface UseCases {
  listEntries(tenantId: string, input: ListInput): Promise<EntryPage>;
  verifyChain(tenantId: string): Promise<VerifyResult>;
}

/** How many verifications one process runs at once; a further one is refused (verify_busy), so they cannot crowd out the consumers. */
export const MAX_CONCURRENT_VERIFIES = 2;
/** Seconds a client is told to wait before it asks for a verification again. */
export const VERIFY_BUSY_RETRY_SECONDS = 5;

export interface UseCaseOptions {
  /** Defaults to MAX_CONCURRENT_VERIFIES. */
  maxConcurrentVerifies?: number;
}

export function createUseCases(deps: UseCaseDeps, options: UseCaseOptions = {}): UseCases {
  const maxVerifies = options.maxConcurrentVerifies ?? MAX_CONCURRENT_VERIFIES;
  let verifying = 0;
  return {
    listEntries: (tenantId, input) => listEntries(deps, tenantId, input),
    verifyChain: async (tenantId) => {
      if (verifying >= maxVerifies) {
        throw new Unavailable("verify_busy", "Other verifications are running; try again shortly", VERIFY_BUSY_RETRY_SECONDS);
      }
      verifying += 1;
      try {
        return await verifyAuditChain(deps, tenantId);
      } finally {
        verifying -= 1;
      }
    },
  };
}
