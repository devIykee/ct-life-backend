-- Migration: 030_meta
--
-- Key/value table for server-wide configuration that doesn't fit
-- the JSON Schema registry (ads.json, meta.json). The M4 slice
-- stores the active `WeeklyMeta` here.
--
-- `key` is the lookup (e.g. 'current'). `value` is a jsonb blob;
-- the application validates the shape per key.
--
-- `updated_at` is set on every write. The contract is one row per
-- key; UNIQUE enforces that.
--
-- The Meta worker writes the row; GET /v1/meta/current reads it.
-- The Phase 5 ad booking flow writes additional rows
-- ('ad_slot:live', 'ad_slot:{slotId}').

-- Up Migration
CREATE TABLE meta (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS meta;