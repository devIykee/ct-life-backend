-- Migration: 096_rekt_burger_clock_in
--
-- Rekt Burger becomes a clock-in job: the player clocks in at the counter, pay builds by
-- server time, clock-out (or the maximum length) pays. The per-ticket minigame is gone.
-- rekt_burger_shifts keeps its shape (one open shift per user, status open/done/expired);
-- the per-ticket columns `orders` and `correct` stay for old rows and are no longer written.
--
-- seconds      the paid length of the shift (capped at the maximum), set when it closes
-- end_reason   'clock_out' (the player), 'auto' (the maximum length, closed by the sweep
--              or on read) or 'left' (the player left the job with a shift open)
-- career_xp    the career XP the shift added (time-based, behind the daily action cap)
--
-- Shifts the old design left 'open' simply become clock-in shifts that close at the maximum.

-- Up Migration
ALTER TABLE rekt_burger_shifts
  ADD COLUMN seconds    integer CHECK (seconds IS NULL OR seconds >= 0),
  ADD COLUMN end_reason text CHECK (end_reason IS NULL OR end_reason IN ('clock_out', 'auto', 'left')),
  ADD COLUMN career_xp  integer CHECK (career_xp IS NULL OR career_xp >= 0);

-- The sweep looks for open shifts by start time.
CREATE INDEX rekt_burger_shifts_open_started_idx
  ON rekt_burger_shifts (started_at) WHERE status = 'open';

-- Down Migration
DROP INDEX IF EXISTS rekt_burger_shifts_open_started_idx;
ALTER TABLE rekt_burger_shifts
  DROP COLUMN IF EXISTS career_xp,
  DROP COLUMN IF EXISTS end_reason,
  DROP COLUMN IF EXISTS seconds;
