import { isStorableJson, isStorableText } from "./json.js";
import type { JsonValue } from "./json.js";

// Events from other services, as the consumer receives them. Whatever arrives is untrusted until it is parsed here:
// parseReceivedEvent returns null for anything that is not a CloudEvent with the attributes audit needs, and the
// consumer terminates such a message (it can never become valid by being redelivered) and logs it.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
/** The longest id, type, source or correlation id an entry takes: the limit of its columns. */
export const TEXT_MAX_LENGTH = 255;

/** A CloudEvents 1.0 envelope from another publisher, reduced to what audit records. */
export interface ReceivedEvent {
  id: string;
  type: string;
  source: string;
  /** The "tenantid" extension: the tenant the event is about (a UUID, in lower case). */
  tenantId: string;
  /** The "time" attribute; null when it is missing or not an RFC 3339 time. */
  time: Date | null;
  /** The "correlationid" extension; null when it is missing, empty or longer than TEXT_MAX_LENGTH. */
  correlationId: string | null;
  /** The "causationid" extension; null under the same conditions. */
  causationId: string | null;
  /** The "data" as received (an empty object when the event has none). Any JSON value is recorded, whatever the type. */
  data: JsonValue;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * A non-empty text of at most TEXT_MAX_LENGTH characters that PostgreSQL stores as it is (no NUL character, no lone
 * surrogate: see isStorableText), or null.
 */
export function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= TEXT_MAX_LENGTH && isStorableText(value) ? value : null;
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== "string" || !RFC_3339_PATTERN.test(value)) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * The envelope of a CloudEvent, or null when it lacks the specversion "1.0", an id, a type or a source (text of 1 to 255
 * characters each), a UUID tenant id, or when its data is not JSON that a jsonb column can hold (a NUL character, more
 * than 64 levels, a number that is not finite, a lone surrogate in a string or a key). The data may be any JSON value, an unknown event type included: audit
 * does not interpret it. Other attributes (subject, datacontenttype ...) are not recorded.
 */
export function parseReceivedEvent(value: unknown): ReceivedEvent | null {
  if (!isRecord(value) || value["specversion"] !== "1.0") return null;
  const id = boundedText(value["id"]);
  const type = boundedText(value["type"]);
  const source = boundedText(value["source"]);
  const tenantId = value["tenantid"];
  if (id === null || type === null || source === null || !isUuid(tenantId)) return null;
  const received = value["data"];
  const data = received === undefined || received === null ? {} : received;
  if (!isStorableJson(data)) return null;
  return {
    id,
    type,
    source,
    tenantId: tenantId.toLowerCase(),
    time: parseTime(value["time"]),
    correlationId: boundedText(value["correlationid"]),
    causationId: boundedText(value["causationid"]),
    data,
  };
}

/** Any version of the TenantCreated event of the tenants service: its consumer creates the tenant's schema. */
export const TENANT_CREATED_PATTERN = /^si\.chance\.tenants\.TenantCreated\.v\d+$/;

export function isTenantCreated(event: Pick<ReceivedEvent, "type">): boolean {
  return TENANT_CREATED_PATTERN.test(event.type);
}
