-- Migration: 132_paid_calls_sweep_backoff (unlock WP-C security review M3/M4, block C)
--
-- M3: the paid-call sweep retried the same failing rows forever and, with
-- `ORDER BY created_at LIMIT 200`, a few hundred of them starved every newer call.
-- Each row now carries `attempts`, `next_attempt_at` (exponential backoff) and
-- `last_error`; after too many failures it is parked as `stuck` (logged as an ALERT)
-- and leaves the sweep. The sweep reads each status in its own small batch, due rows
-- first.
--
-- M4: `authority_rent_lamports` is the account rent the settle authority paid for this
-- call's settle / refund (token accounts it had to create). Booking is refused for a
-- user whose recent calls made the authority pay rent too often.

-- Up Migration
ALTER TABLE paid_calls
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error text,
  ADD COLUMN authority_rent_lamports bigint NOT NULL DEFAULT 0 CHECK (authority_rent_lamports >= 0);

ALTER TABLE paid_calls DROP CONSTRAINT paid_calls_status_check;
ALTER TABLE paid_calls ADD CONSTRAINT paid_calls_status_check
  CHECK (status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'settled', 'refunding',
                    'refunded', 'expired', 'closed_unknown', 'stuck'));

DROP INDEX IF EXISTS paid_calls_sweep_idx;
CREATE INDEX paid_calls_sweep_idx ON paid_calls (status, next_attempt_at, created_at)
  WHERE status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'refunding');
CREATE INDEX paid_calls_fan_created_idx ON paid_calls (fan_user_id, created_at DESC);
CREATE INDEX paid_calls_creator_created_idx ON paid_calls (creator_user_id, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS paid_calls_creator_created_idx;
DROP INDEX IF EXISTS paid_calls_fan_created_idx;
DROP INDEX IF EXISTS paid_calls_sweep_idx;
CREATE INDEX paid_calls_sweep_idx ON paid_calls (status, created_at)
  WHERE status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'refunding');
ALTER TABLE paid_calls DROP CONSTRAINT paid_calls_status_check;
ALTER TABLE paid_calls ADD CONSTRAINT paid_calls_status_check
  CHECK (status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'settled', 'refunding',
                    'refunded', 'expired', 'closed_unknown'));
ALTER TABLE paid_calls
  DROP COLUMN IF EXISTS authority_rent_lamports,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS attempts;
