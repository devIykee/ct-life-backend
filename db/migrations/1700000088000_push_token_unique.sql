-- Migration: 088_push_token_unique
--
-- One account per push token. A device token must belong to exactly one user, so a
-- player who signs out and another who signs in on the same phone never share it, and
-- the previous account can no longer receive pushes meant for this device.
--
-- Existing duplicates (same token under several users) are resolved first: the most
-- recently updated row keeps the token, the others are deleted. Then a partial UNIQUE
-- index makes it impossible again; registering a token that another user holds moves it.

-- Up Migration
DELETE FROM push_devices d
 USING push_devices k
 WHERE d.fcm_token IS NOT NULL AND d.fcm_token = k.fcm_token
   AND (d.updated_at, d.device_id) < (k.updated_at, k.device_id);

DELETE FROM push_devices d
 USING push_devices k
 WHERE d.apns_token IS NOT NULL AND d.apns_token = k.apns_token
   AND (d.updated_at, d.device_id) < (k.updated_at, k.device_id);

CREATE UNIQUE INDEX push_devices_fcm_token_uidx ON push_devices (fcm_token)
  WHERE fcm_token IS NOT NULL;

CREATE UNIQUE INDEX push_devices_apns_token_uidx ON push_devices (apns_token)
  WHERE apns_token IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS push_devices_apns_token_uidx;
DROP INDEX IF EXISTS push_devices_fcm_token_uidx;
