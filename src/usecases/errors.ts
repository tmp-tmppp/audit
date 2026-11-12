// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28).
export type UseCaseErrorKind = "validation" | "not_found" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "tenant_not_ready". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid") {
    super("validation", "validation_failed", message, fields);
  }
}

export class NotFound extends UseCaseError {
  constructor(code: string, message: string) {
    super("not_found", code, message);
  }
}

/**
 * Something this request needs is not there right now: the tenant's schema does not exist yet (TenantCreated is not
 * processed). The caller tries again after `retryAfterSeconds` (HTTP 503 with Retry-After at the edge); an event
 * consumer naks the message, so the broker redelivers it later.
 */
export class Unavailable extends UseCaseError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
    options?: ErrorOptions,
  ) {
    super("unavailable", code, message, [], options);
  }
}

/** Seconds a client waits before it asks again for a tenant whose schema is not there yet. */
export const TENANT_NOT_READY_RETRY_SECONDS = 5;

/** The tenant has no schema yet: its TenantCreated event has not been processed. */
export class TenantNotReady extends Unavailable {
  constructor(readonly tenantId: string) {
    super("tenant_not_ready", "The tenant is not ready yet, try again shortly", TENANT_NOT_READY_RETRY_SECONDS);
  }
}
