# audit: contracts

`openapi.yaml` (OpenAPI 3.1) is the synchronous API of the tenant admin, `asyncapi.yaml` (AsyncAPI 3.0) the channels the
service consumes. Both are written before the code and checked by `tests/contracts`. This page explains what the log
holds and how its hash chain works, so that someone can check a log without this service's code.

## What audit records

Audit consumes **every business event** of the other services (tenants, payments, markets, trading) and keeps one
**entry** per event in the log of the event's tenant. It publishes nothing and has no endpoint that writes: the log is
filled from events only, off the request path, so a slow or failing audit never slows a trade or a deposit.

| Field | Meaning |
|---|---|
| `seq` | 1, 2, 3 ... per tenant, without gaps, assigned when the entry is appended (under a per-tenant lock) |
| `eventId` | The CloudEvent `id`; unique per tenant, so an event the broker delivers twice is one entry |
| `eventType`, `source` | The CloudEvent `type` and `source`; any value is recorded, also a type audit has never seen |
| `subject` | The main id of the event: `marketId`, `depositId`, `withdrawalId`, `userId` or `tenantId` of its data (first present, in this order), else the tenant id |
| `actor` | `actorId`, `userId` or `adminId` of the data (first present), else null |
| `occurredAt`, `recordedAt` | The CloudEvent `time` (or the recording time if the event has none) and when audit stored it |
| `correlationId`, `causationId` | The CloudEvent extensions; follow one business operation (a market's resolution and the payouts after it) across services |
| `payload` | The event's `data` as received. Events carry ids, never names or e-mail addresses |
| `prevHash`, `hash` | The hash chain, below |

A message that is not a CloudEvent with `specversion` `1.0`, an `id`, a `type`, a `source` and a `tenantid` (UUID) is
terminated and logged, never recorded; so is one whose data a database cannot hold (a NUL character in a text, nesting
deeper than 64 levels). Text values of 256 characters or more are not used as `subject`, `actor`, `correlationId` or
`causationId` (the data stays whole in `payload`).

### Consumed subjects

One JetStream stream per publisher (ADR-053), one durable pull consumer `audit-<service>` on each:

| Stream | Subjects | Events audit knows (any other is recorded too) |
|---|---|---|
| `TENANTS` | `chance.tenants.>` | TenantCreated, MemberJoined, MemberRoleChanged |
| `PAYMENTS` | `chance.payments.>` | DepositSucceeded, DepositFailed, WithdrawalSucceeded, WithdrawalFailed |
| `MARKETS` | `chance.markets.>` | MarketOpened, MarketClosed, MarketResolved |
| `TRADING` | `chance.trading.>` | MarketFunded, TradeExecuted, MarketSettled, WithdrawalRefunded |

A message is acknowledged only after its entry is committed; the id of the event is stored in the same transaction
(an inbox), so a redelivery changes nothing. A stream that does not exist yet is logged and retried. `TenantCreated`
creates the tenant's schema and is recorded as the tenant's first entry; an event of a tenant without a schema is
negatively acknowledged with a delay and arrives again after `TenantCreated` was processed.

The inbox key is the pair (consumer, event id), so the publishers must keep event ids unique across tenants (a UUIDv7 per
event, as every service does): the same id sent for two tenants on one stream would be taken for a redelivery and the
second event would not be recorded. An id that another stream's consumer recorded already is skipped and logged, not
recorded twice.

## Append-only

An entry is never updated or deleted, and the log is never purged or shortened: there is no retention. The reasons are
the point of an audit log: whoever reads it must be able to trust that what it shows is what happened, and a log that
the service itself could rewrite proves nothing. Three layers keep it so:

1. The service has no code path that changes or deletes an entry (the use cases only append and read).
2. The tenant migration installs a trigger that raises an error for `UPDATE`, `DELETE` and `TRUNCATE` on `audit_entries`,
   also for a statement that would touch no row. It stops every such statement as long as it is enabled. It is not a
   barrier against the owner of the table: the service's own database login creates the table in its migrations, so it
   owns it, and an owner can disable or drop the trigger. An integration test against PostgreSQL proves the trigger.
3. The hash chain shows a change that is made anyway, for example by someone who has the service's database login (its
   `DATABASE_URL`): the entries after the change no longer chain. It cannot show a rewrite that also recomputes every
   later hash, which the same login allows; to notice that, keep the `hash` of the newest entry somewhere the database
   cannot reach. A login that does not own the tables (the owner only runs the migrations) would narrow this; the
   service does not use one yet.

## The hash chain

Every entry holds the hash of the entry before it (`prevHash`) and its own `hash`. Changing, removing, inserting or
reordering an entry makes the hashes after that point wrong.

**The rule.** For an entry, take its fields except `hash` and `recordedAt`:

1. Build one JSON object with these keys (the names of the database columns): `actor`, `causation_id`,
   `correlation_id`, `event_id`, `event_type`, `occurred_at`, `payload`, `prev_hash`, `seq`, `source`, `subject`.
   `occurred_at` is the UTC time with milliseconds (`2026-11-01T10:00:00.000Z`), `seq` a JSON number, `prev_hash` the
   64 hex digits, `actor`, `correlation_id` and `causation_id` are `null` when absent, `payload` is the event's data.
2. Write it as the **canonical text**: object keys sorted (by UTF-16 code unit, which is alphabetical order for ASCII keys) at every
   level, no whitespace, strings and numbers as ECMAScript `JSON.stringify` writes them, UTF-8 bytes.
3. `hash = SHA-256( prev_hash as 32 bytes || canonical text )`, in lower-case hex. For `seq` 1 the previous hash is 32
   zero bytes (`0` repeated 64 times as hex).

**A worked example** (entry 1 of a tenant). The canonical text (one line):

```
{"actor":"admin-1","causation_id":null,"correlation_id":"corr-1","event_id":"018f3c1e-7a00-7000-8000-000000000001","event_type":"si.chance.markets.MarketOpened.v1","occurred_at":"2026-11-01T10:00:00.000Z","payload":{"marketId":"018f3c1e-7a00-7000-8000-0000000000b1","question":"Q?","version":1},"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"source":"/chance/markets","subject":"018f3c1e-7a00-7000-8000-0000000000b1"}
```

has the hash `0b487b0e0b75b1c20225a09b502c73a8f6fae58764565e93837e347bae5f2449`. In Python:

```python
import hashlib, json

def entry_hash(entry):  # entry: the JSON of one item of GET /v1/audit
    text = json.dumps({
        "actor": entry["actor"], "causation_id": entry["causationId"], "correlation_id": entry["correlationId"],
        "event_id": entry["eventId"], "event_type": entry["eventType"], "occurred_at": entry["occurredAt"],
        "payload": entry["payload"], "prev_hash": entry["prevHash"], "seq": entry["seq"],
        "source": entry["source"], "subject": entry["subject"],
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(bytes.fromhex(entry["prevHash"]) + text.encode("utf-8")).hexdigest()
```

(`occurredAt` in the API is already the UTC time with milliseconds. Python writes some numbers differently from
JavaScript, for example `1e+21`; events carry ids, texts and small whole numbers, for which both agree.)

**Verifying.** `GET /v1/audit/verify` recomputes the chain of the caller's tenant on the server and answers
`{"valid": true, "entries": 1042, "brokenAtSeq": null}`. For a broken chain `valid` is false and `brokenAtSeq` is the
first entry that is wrong: a changed entry itself, or for a removed entry the one after the gap. To verify without
trusting the server, page through `GET /v1/audit` and check, from the oldest entry up, that `seq` grows by 1 from 1,
that each `prevHash` is the `hash` of the entry before (the first one 64 zeros) and that `entry_hash(entry) == hash`.

**What it does not prove.** Entries cut off at the end of the log leave a chain that is valid, and someone who changes an entry
and recomputes every hash after it leaves one too. Keep the `hash` and `seq` of the newest entry somewhere
else (a ticket, a signed message) from time to time: a log that no longer contains that hash at that `seq` was changed.
The recording time is not hashed, so that it can be corrected for clock skew without breaking the chain; it is not evidence of when an event occurred.

## The API

`GET /v1/audit` lists the entries of the caller's tenant, newest first, with the filters `type` (exact, repeatable or a comma list), `from` and `to`
(on `occurredAt`), `correlationId`, `actor` and `subject`, and the cursor pagination of `limit` (1 to 100, default 50)
and `cursor`. `GET /v1/audit/verify` checks the chain. Both need the role `tenant-admin`; the tenant comes only from the
token, never from the request, so no filter can reach another tenant's log. The full description is in `openapi.yaml`.
