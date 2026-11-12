-- Shared schema of audit (plan sections 6.7 and 9): everything that no single tenant owns. The log of each tenant
-- (audit_entries) is in migrations/tenant and exists once per tenant schema.
-- Timestamps come from the service clock. Constraints are the last guard (DM-10); foreign keys exist only inside this
-- database (DM-02).
--
-- shared.schema_migrations (version, checksum, applied_at) is created by the migration runner itself, before the
-- first file runs, because it records which files ran; every tenant schema has its own copy of it.
--
-- audit publishes no events, so there is no outbox here.

CREATE SCHEMA IF NOT EXISTS shared;

-- The tenants this service has a schema for. A row is written in the same transaction that creates and migrates the
-- schema (the consumer of TenantCreated), so a registered tenant always has its schema, and the startup migration
-- applies every tenant migration to every registered schema: schemas never drift apart.
CREATE TABLE shared.tenant_registry (
    tenant_id   uuid        PRIMARY KEY,
    schema_name text        NOT NULL CONSTRAINT tenant_registry_schema_format CHECK (schema_name ~ '^tenant_[0-9a-f]{32}$'),
    created_at  timestamptz NOT NULL,
    CONSTRAINT tenant_registry_schema_key UNIQUE (schema_name),
    -- The schema name is derived from the id and from nothing else.
    CONSTRAINT tenant_registry_schema_matches_id CHECK (schema_name = 'tenant_' || replace(tenant_id::text, '-', ''))
);

-- Inbox of consumed events (ADR-053): the id of a processed event is stored in the same transaction as its entry in
-- the tenant's log, so a redelivered event changes nothing. The consumer is the stream's durable consumer (TENANTS,
-- PAYMENTS, MARKETS, TRADING): an event id is unique within its publisher, so the pair is the key.
CREATE TABLE shared.inbox (
    consumer     text        NOT NULL CONSTRAINT inbox_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    event_id     text        NOT NULL CONSTRAINT inbox_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_idx ON shared.inbox (processed_at);
