-- Migration: 037_business_days
--
-- One row per (business, calendar_date). The UNIQUE enforces
-- "one open per day" so POST /v1/businesses/{id}/run cannot be
-- called twice for the same date.
--
-- `kind` is the day's outcome:
--   'normal'    - random pay in [income_min, income_max]
--   'bad_day'   - 0 (or a small penalty)
--   'great_day' - income_max
--
-- `pay_cents` is the actual Cash credit (>= 0). It is the
-- server's authoritative number; the client never computes it.
-- The corresponding ledger row is 'business_pay'.
--
-- `description` is the line shown in the player UI (e.g.
-- "Sold out of lemonade" for a great day, "Power outage" for
-- a bad day). 1..200 chars.
--
-- Indexes:
--   (business_id, day_date) UNIQUE — primary access pattern
--   (business_id, day_date DESC) — recent-days list

-- Up Migration
CREATE TABLE business_days (
  day_id          uuid PRIMARY KEY,
  business_id     uuid NOT NULL REFERENCES businesses(business_id),
  day_date        date NOT NULL,
  pay_cents       bigint NOT NULL CHECK (pay_cents >= 0),
  kind            text NOT NULL
                   CHECK (kind IN ('normal', 'bad_day', 'great_day')),
  description     text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),

  UNIQUE (business_id, day_date)
);

CREATE INDEX business_days_business_date_idx
  ON business_days (business_id, day_date DESC);

-- Down Migration
DROP TABLE IF EXISTS business_days;
