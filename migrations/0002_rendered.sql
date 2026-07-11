-- Migration number: 0002    rendered
-- Render-at-ingest (contract addendum P2→P3): mirrorEvent runs
-- renderPost+sanitize ONCE when a kind 30023 event is stored and keeps the
-- HTML here; the tenant post view serves this column and never calls
-- renderPost on the request path (free-tier 10ms CPU budget).
-- Nullable: only kind 30023 rows are populated.

ALTER TABLE events ADD COLUMN rendered TEXT;
