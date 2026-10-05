-- Migration: 029_push_devices
--
-- One row per (user, device). `device_id` is the UUIDv7 the
-- backend generated.
--
-- `platform` is the device's push platform. iOS (apns_token),
-- Android (fcm_token), Web (either, but typically fcm for Chrome).
--
-- The application upserts on (user_id, platform, apns_token/fcm_token)
-- so a user can have multiple devices. The CHECK enforces that at
-- least one of the two token columns is non-NULL.
--
-- `enabled` is the per-device opt-out. A user can disable a single
-- device without disabling push globally.
--
-- `created_at` and `updated_at` are bookkeeping; the push worker
-- can prune devices that have not been seen in 90 days (M5+).
--
-- Indexes:
--   (user_id, enabled) — the enabled-devices query for a user

-- Up Migration
CREATE TABLE push_devices (
  device_id     uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  apns_token    text,
  fcm_token     text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (platform = 'ios' AND apns_token IS NOT NULL)
    OR
    (platform IN ('android', 'web') AND fcm_token IS NOT NULL)
  )
);

CREATE INDEX push_devices_user_enabled_idx
  ON push_devices (user_id, enabled);

CREATE INDEX push_devices_apns_token_idx
  ON push_devices (apns_token)
  WHERE apns_token IS NOT NULL;

CREATE INDEX push_devices_fcm_token_idx
  ON push_devices (fcm_token)
  WHERE fcm_token IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS push_devices;