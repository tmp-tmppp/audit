// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml,
// and tests/contracts compares the routes and the answers with that file.

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
  },
} as const;

export const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const text = { type: "string", minLength: 1, maxLength: 255 } as const;

/** The entry as the API sends it. `payload` is any JSON value: audit records whatever the event's data was. */
const entrySchema = {
  type: "object",
  properties: {
    seq: { type: "integer" },
    eventId: { type: "string" },
    eventType: { type: "string" },
    source: { type: "string" },
    subject: { type: "string" },
    actor: { type: ["string", "null"] },
    occurredAt: { type: "string" },
    recordedAt: { type: "string" },
    correlationId: { type: ["string", "null"] },
    causationId: { type: ["string", "null"] },
    payload: {},
    prevHash: { type: "string" },
    hash: { type: "string" },
  },
} as const;

export const schemas = {
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
  list: {
    // Unknown query parameters are ignored (a client cannot choose a tenant with one: the tenant is the token's).
    querystring: {
      type: "object",
      properties: {
        // `type=a&type=b` is an array by itself; a single `type=a,b` is coerced to one item and split by the use case.
        type: { type: "array", maxItems: 20, items: text },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        correlationId: text,
        actor: text,
        subject: text,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    response: {
      200: {
        type: "object",
        properties: { items: { type: "array", items: entrySchema }, nextCursor: { type: ["string", "null"] } },
      },
      ...errorResponses,
    },
  },
  verify: {
    response: {
      200: {
        type: "object",
        properties: { valid: { type: "boolean" }, entries: { type: "integer" }, brokenAtSeq: { type: ["integer", "null"] } },
      },
      ...errorResponses,
    },
  },
} as const;
