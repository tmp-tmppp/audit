import type { FastifyInstance } from "fastify";
import type { AuditEntry } from "../../domain/audit-entry.js";
import type { UseCases } from "../../usecases/application.js";
import type { ListInput } from "../../usecases/list-entries.js";
import { requireTenantAdmin, tenantAdminHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { schemas } from "../schemas.js";

/** An entry as the API sends it (contracts/openapi.yaml, AuditEntry): camelCase, times as ISO 8601 in UTC. */
export function entryBody(entry: AuditEntry) {
  return {
    seq: entry.seq,
    eventId: entry.eventId,
    eventType: entry.eventType,
    source: entry.source,
    subject: entry.subject,
    actor: entry.actor,
    occurredAt: entry.occurredAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
    correlationId: entry.correlationId,
    causationId: entry.causationId,
    payload: entry.payload,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
}

/**
 * The audit API (plan 6.7): the log of the caller's tenant, for the tenant admin only. The token is verified first, then
 * the role and the tenant (a missing or wrong token is 401, another role or no tenant 403); only then is the input
 * looked at. The tenant is the token's and nothing in the request can name another one, so another tenant's log is
 * not reachable. Both routes read; there is no route that writes.
 */
export function registerAuditRoutes(app: FastifyInstance, useCases: UseCases, authenticateHook: RequestHook): void {
  const onRequest = [authenticateHook, tenantAdminHook];

  app.get("/v1/audit", { onRequest, schema: schemas.list }, async (request) => {
    const tenantId = requireTenantAdmin(request);
    const page = await useCases.listEntries(tenantId, request.query as ListInput);
    return { items: page.items.map(entryBody), nextCursor: page.nextCursor };
  });

  app.get("/v1/audit/verify", { onRequest, schema: schemas.verify }, async (request) => {
    return useCases.verifyChain(requireTenantAdmin(request));
  });
}
