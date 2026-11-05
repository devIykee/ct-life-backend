-- Migration: 144_travel_trips
--
-- Map Travel phase 1 (docs/TRAVEL.md): a paid bus or taxi ride between CT Island
-- venues. The fare is debited in the same transaction that inserts the trip
-- (ledger reason `travel_fare`, idempotency_ref `travel-trip:<user>:<key>`), and
-- refunded in full when the trip is cancelled before `arrive_at` or expires
-- unused (ledger reason `travel_refund`, idempotency_ref `travel-refund:<trip>`).
--
-- status: booked -> arrived (the street room consumed the ticket),
--         booked -> cancelled (POST /travel/trips/:id/cancel, refunded),
--         booked -> expired_refunded (the travel-sweep worker, refunded).
-- Walking is never booked, so `mode` is only bus or taxi.
--
-- Positions are island metres. `arrival_yaw` is radians (PlayerState.rotY).
--
-- Indexes:
--   travel_trips (user_id) UNIQUE WHERE booked   — one open trip per player
--   travel_trips (user_id, created_at DESC)      — cooldown, hourly limit, history
--   travel_trips (expires_at) WHERE booked        — the refund sweep

-- Up Migration
CREATE TABLE travel_trips (
  trip_id       uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode          text NOT NULL CHECK (mode IN ('bus', 'taxi')),
  to_id         text NOT NULL,
  fare_cents    bigint NOT NULL CHECK (fare_cents >= 0),
  status        text NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked', 'arrived', 'cancelled', 'expired_refunded')),
  distance_m    integer NOT NULL CHECK (distance_m >= 0),
  origin_district  text NOT NULL,
  origin_x      double precision NOT NULL,
  origin_z      double precision NOT NULL,
  pickup_stop_id   text,
  arrival_district text NOT NULL,
  arrival_x     double precision NOT NULL,
  arrival_z     double precision NOT NULL,
  arrival_yaw   double precision NOT NULL,
  depart_at     timestamptz NOT NULL,
  arrive_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  arrived_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (arrive_at >= depart_at),
  CHECK (expires_at > arrive_at)
);

CREATE UNIQUE INDEX travel_trips_one_open_idx
  ON travel_trips (user_id) WHERE status = 'booked';

CREATE INDEX travel_trips_user_created_idx
  ON travel_trips (user_id, created_at DESC);

CREATE INDEX travel_trips_expiry_idx
  ON travel_trips (expires_at) WHERE status = 'booked';

-- Down Migration
DROP TABLE IF EXISTS travel_trips;
