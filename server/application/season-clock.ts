/**
 * Season clock (M7 #2 helper).
 *
 * The application uses ISO-8601 week identifiers (e.g. '2026-W40')
 * as the season id. The rollover worker runs every Monday at
 * 00:00 UTC; the season it just rolled into is the current week.
 *
 * `currentSeasonIso()` is the default when the client does not
 * pass a seasonIso query param. Tests inject a fixed `now` so the
 * M7 #2 simulated-clock 8-week rollover test is deterministic.
 */
export const SEASON_FORMAT = /^\d{4}-W\d{2}$/;

/**
 * Returns the ISO-8601 week identifier (e.g. '2026-W40') for the
 * current UTC date. The M7 #2 routes + worker use this as the
 * default `seasonIso` when the client does not pass one.
 *
 * @param now - Optional injectable clock for tests.
 */
export function currentSeasonIso(now: Date = new Date()): string {
  return weekIso(now);
}

/** Returns the ISO-8601 week identifier (e.g. '2026-W40') for `d`. */
export function weekIso(d: Date): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
