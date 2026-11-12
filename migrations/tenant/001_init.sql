-- The audit log of one tenant (plan section 6.7). This file runs once per tenant schema with that schema as the only
-- entry of the search path, so names are not qualified.
--
-- One row per business event the tenant's services published, in the order audit recorded them. The row is written
-- once and never changes.
--
--   seq          1, 2, 3 ... without gaps, per tenant. The service assigns it in the transaction that appends the entry,
--                under a per-tenant advisory lock, so two appends never take the same number and a rolled-back
--                append leaves no hole. The primary key makes a second row with the same number impossible.
--   event_id     the CloudEvent id; unique, so one event is one entry however often the broker redelivers it.
--   event_type   for example si.chance.markets.MarketOpened.v1. A type audit does not know is recorded too.
--   subject      the main id of the event (marketId, depositId, withdrawalId, userId or tenantId, in that order).
--   actor        who caused it (actorId, userId or adminId of the data), or null.
--   occurred_at  the CloudEvent time; recorded_at is when audit stored it (not part of the hash).
--   payload      the event's data as received. Events carry ids, never names or e-mail addresses (DM-14).
--   prev_hash    the hash of the previous entry, 64 zeros for seq 1.
--   hash         SHA-256 (hex) over prev_hash and the canonical text of the entry's other fields: the hash chain.
--                contracts/README.md has the exact rule.
CREATE TABLE audit_entries (
    seq            bigint      PRIMARY KEY CONSTRAINT audit_entries_seq_positive CHECK (seq >= 1),
    event_id       text        NOT NULL CONSTRAINT audit_entries_event_id_key UNIQUE
                               CONSTRAINT audit_entries_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type     text        NOT NULL CONSTRAINT audit_entries_event_type_length CHECK (char_length(event_type) BETWEEN 1 AND 255),
    source         text        NOT NULL CONSTRAINT audit_entries_source_length CHECK (char_length(source) BETWEEN 1 AND 255),
    subject        text        NOT NULL CONSTRAINT audit_entries_subject_length CHECK (char_length(subject) BETWEEN 1 AND 255),
    actor          text        CONSTRAINT audit_entries_actor_length CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 255),
    occurred_at    timestamptz NOT NULL,
    recorded_at    timestamptz NOT NULL,
    correlation_id text        CONSTRAINT audit_entries_correlation_id_length CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 255),
    causation_id   text        CONSTRAINT audit_entries_causation_id_length CHECK (causation_id IS NULL OR char_length(causation_id) BETWEEN 1 AND 255),
    payload        jsonb       NOT NULL,
    prev_hash      text        NOT NULL CONSTRAINT audit_entries_prev_hash_format CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    hash           text        NOT NULL CONSTRAINT audit_entries_hash_format CHECK (hash ~ '^[0-9a-f]{64}$'),
    -- Only the first entry starts from the zero hash.
    CONSTRAINT audit_entries_genesis CHECK ((seq = 1) = (prev_hash = repeat('0', 64)))
);

-- The filters of GET /v1/audit, each followed by seq DESC because the list is newest first. The primary key serves the
-- list without a filter and the cursor.
CREATE INDEX audit_entries_type_idx        ON audit_entries (event_type, seq DESC);
CREATE INDEX audit_entries_subject_idx     ON audit_entries (subject, seq DESC);
CREATE INDEX audit_entries_actor_idx       ON audit_entries (actor, seq DESC) WHERE actor IS NOT NULL;
CREATE INDEX audit_entries_correlation_idx ON audit_entries (correlation_id, seq DESC) WHERE correlation_id IS NOT NULL;
CREATE INDEX audit_entries_occurred_idx    ON audit_entries (occurred_at, seq);

-- Append-only: no UPDATE, DELETE or TRUNCATE, not even by the service's own database user. The trigger fires once per
-- statement, so it refuses a statement that would touch no row as well. The service has no code path that changes or
-- deletes an entry (and no retention or purge job); this trigger is the guard under it, and the hash chain shows a
-- change that someone with more rights than the service makes anyway (it can drop the trigger or the schema; it cannot
-- do so without the chain showing it, unless it recomputes every later hash).
CREATE FUNCTION audit_entries_refuse_change() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_entries_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_entries
    FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_refuse_change();
