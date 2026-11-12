# audit

The audit log of Chance (plan section 6.7, SVC-AUD): an append-only, per-tenant record of every business event that
the other services publish, with a hash chain that shows any later change. The tenant admin reads it; nobody writes to it
except the service itself, from events.

The template of this service is `tenants` (ADR-053): schema `shared` plus one schema per tenant, migrations at startup,
Clean Architecture enforced by ESLint, contracts first, Vitest with an 80 % coverage threshold, `APP_ENV=local` as the
only in-memory mode. audit has no outbox and no publisher: it consumes events and publishes none, and it calls no other
service.

**Contracts** (written before the code, checked by `tests/contracts`): `contracts/openapi.yaml`,
`contracts/asyncapi.yaml` and `contracts/README.md` (what is recorded, the hash chain and how to verify it, why the log
is append-only).

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /v1/audit` | tenant admin | The entries of the caller's tenant, newest first; filters `type` (exact event type, repeated or a comma list), `from` and `to` (ISO times on `occurredAt`), `correlationId`, `actor`, `subject`; cursor pagination on `seq`, `limit` 1 to 100 (default 50) |
| `GET /v1/audit/verify` | tenant admin | Recomputes the hash chain of the caller's tenant: `{valid, entries, brokenAtSeq}` |
| `GET /health/startup`, `/health/ready`, `/health/live` | none | Kubernetes probes; ready pings the own database only |

The tenant comes only from the verified token (claim `organization`), never from the request. Any other role is 403, a
missing or wrong token 401. Errors are RFC 9457 problem details; `X-Correlation-Id` is taken from the request or made.
There is no route that writes: `DELETE /v1/audit` is a 404.

## What an entry is

One row of `audit_entries` in the tenant's schema: `seq` (1, 2, 3 ... without gaps, per tenant), `event_id` (unique),
`event_type`, `source`, `subject` (the main id of the event: `marketId`, `depositId`, `withdrawalId`, `userId` or the
tenant id, in that order), `actor` (`actorId`, `userId` or `adminId` of the data, else null), `occurred_at` (the CloudEvent
time), `recorded_at`, `correlation_id`, `causation_id`, `payload` (the event's data as received; events carry ids only,
DM-14), `prev_hash` and `hash`.

- **Append-only.** A trigger refuses UPDATE, DELETE and TRUNCATE on `audit_entries`, and the service has no code path that
  changes or removes an entry. There is no retention and no purge.
- **Hash chain.** `hash` is SHA-256 over the previous entry's hash (32 zero bytes for `seq` 1) and a canonical text of the
  entry's other fields (keys sorted, UTF-8, no whitespace). `GET /v1/audit/verify` recomputes the chain; a changed or
  removed entry breaks it at that entry. The exact rule, a worked example and a verifier in Python are in
  `contracts/README.md`.
- **Gapless seq.** An append takes a PostgreSQL advisory lock per tenant, reads the head of the chain and inserts the next
  entry in one transaction, so two concurrent appends to one tenant are numbered one after the other.

## Events

audit consumes the four streams `TENANTS`, `PAYMENTS`, `MARKETS` and `TRADING` (subjects `chance.<service>.>`) with one
durable consumer each (`audit-tenants` and so on), and records every event with a valid CloudEvents envelope (`id`,
`type`, `source`, `tenantid`), whatever its type. A message is acknowledged after the entry is committed; the event id is
stored in an inbox (`shared.inbox`) in the same transaction, so a redelivery changes nothing. A message that is no valid
envelope is terminated and logged without its payload. A stream that does not exist yet is logged and retried: the service
starts and serves its log meanwhile.

`TenantCreated` creates the tenant's schema (inside the consumer's transaction) and is itself the first entry. An event of
a tenant without a schema is negatively acknowledged with a backoff (1, 2, 4 ... 30 seconds) and arrives again once
`TenantCreated` was processed; until then the API answers `503 tenant_not_ready` with `Retry-After: 5`.

More than one Pod may run: appends are serialized per tenant by the advisory lock, and the inbox and the unique event id
keep every event to one entry.

## Layout

| Path | Holds |
|---|---|
| `src/domain/` | Pure rules: the envelope parser (`envelope.ts`), building an entry (`audit-entry.ts`), the canonical text and the hash chain (`json.ts`, `hash-chain.ts`), the consumed streams (`streams.ts`) |
| `src/usecases/` | The ports (`ports.ts`), recording an event (`record-event.ts`), listing entries (`list-entries.ts`), verifying the chain (`verify-chain.ts`) |
| `src/adapters/postgres/` | The migration runner, `tenant-scope.ts` (the one function that chooses a tenant schema), the store and its repositories |
| `src/adapters/memory/` | The in-memory store that mirrors PostgreSQL (`APP_ENV=local` and unit tests) |
| `src/adapters/metrics/` | The metrics module: the registry, the request hook and the `/metrics` listener |
| `src/adapters/nats/`, `src/adapters/events/` | The durable consumers and the delivery decision (ack, nak with backoff, terminate) |
| `src/web/` | Fastify application: token check (`auth.ts`), problem details, health, the two audit routes |
| `src/main.ts` | The composition root: configuration, adapters, use cases, web application, graceful shutdown |
| `migrations/shared`, `migrations/tenant` | Versioned SQL, applied at startup under an advisory lock to the shared schema and to every tenant schema |
| `contracts/` | OpenAPI, AsyncAPI and the explanation of the log |
| `helm/`, `Dockerfile`, `compose.yaml`, `.github/` | Chart (ConfigMap, Deployment, Service, optional NetworkPolicy, smoke test), image, local run, CI caller |
| `scripts/e2e-local.mjs` | End to end run against a running service (below) |
| `tests/` | Unit, web and contract tests; `tests/integration` runs PostgreSQL 18 and NATS in Docker (Testcontainers) |

## Configuration

| Variable | Meaning |
|---|---|
| `APP_ENV` | `local` allows the in-memory store and no NATS; anything else (default `production`) requires every setting below that has no default |
| `PORT` | Port of the HTTP server, default 8080 |
| `METRICS_PORT` | Port (default 9464, 1 to 65535) of the separate listener that serves `GET /metrics`; must differ from `PORT` (see "Metrics") |
| `DATABASE_URL`, `DATABASE_POOL_MAX` | The service's own PostgreSQL database (required); pool size 1 to 50, default 5 |
| `NATS_URL` | NATS server with JetStream (required) |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | Where the token signing keys are, the issuer and the audience (`chance`); required; tokens are always verified |
| `AUTH_ROLES_CLAIM`, `AUTH_TENANT_CLAIM` | Claim paths, default `realm_access.roles` (read for `platform-admin` only) and `organization` (exactly one organization; its group `/tenant-admin` or `/trader` in `organization.<alias>.groups` is the tenant role, token contract v2) |
| `SHUTDOWN_DELAY_MS` | After SIGTERM, how long readiness answers 503 before the server closes; default 5000 (0 locally), at most 15000 |
| `LOG_LEVEL` | `fatal` to `silent`, default `info` |

A production start with a missing or malformed setting stops at once with a message that names every problem (never a
value). In the cluster the Secret `audit-env` holds `DATABASE_URL`; the other settings are in the chart's ConfigMap.

`AUTH_ISSUER` in `helm/values-prod.yaml` is empty on purpose: its value, `https://<public host>/realms/chance`, comes
from the pipeline's public host (plan INF-01). A deploy without it stops at start with "AUTH_ISSUER is required" (the
Pod restarts and the deploy rolls back) instead of answering every token with 401.

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). The default is the same in every service, so
  services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own
  address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/audit/verify`), or `unmatched` for a request that matched no route (a 404), so
  a raw URL or a query string never becomes a label value.
- **`tenant`** is the tenant id in the token the service verified, `none` when the request has no verified token (the
  probes, a rejected token) or the token names no tenant. It is never read from a header or the body.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Run and test

```bash
npm ci
npm run lint
npm run typecheck
npm test                      # unit, web and contract tests; npm test -- --coverage for the 80 % gate
npm run test:integration      # PostgreSQL 18 and NATS in containers (needs a Docker daemon)
npm run build && npm start
docker compose up -d --build  # PostgreSQL, NATS and audit (compose.yaml explains the settings)
helm lint helm -f helm/values-prod.yaml && helm template audit helm -f helm/values-prod.yaml | kubeconform -strict
```

**Run it end to end** (no cluster, no identity provider): start PostgreSQL 18 and NATS (`docker compose up -d postgres nats`),
build the service (`npm run build`) and start it with `PORT=8080 DATABASE_URL=postgres://audit:audit@127.0.0.1:5432/audit
NATS_URL=nats://127.0.0.1:4222 AUTH_JWKS_URL=http://127.0.0.1:8099/ AUTH_ISSUER=http://localhost:8081/realms/chance
AUTH_AUDIENCE=chance npm start` (production mode: every setting is given), then
`DATABASE_URL=<the same URL> npm run e2e:local`. The script plays the identity provider (it serves a key set and signs
tokens), the publishers of all four streams for two tenants and the owner of the database. It checks that an event of a
tenant without a log is held back until `TenantCreated`, that a redelivery, an unknown event type and a broken message
behave as designed, the filters (`type`, `correlationId`, `subject`, `actor`, `from`, `to`) and the cursor, that tenant A's
admin sees only tenant A's entries and a trader gets 403, and that `verify` is valid. Then it tampers with one row as the
database owner (the trigger switched off for one statement) and checks that `verify` reports `brokenAtSeq`. Without
`DATABASE_URL` the last step is skipped (an in-memory run has no database).
