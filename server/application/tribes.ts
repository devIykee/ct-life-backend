/**
 * Tribes + district control service (M7 #1).
 *
 * Endpoints:
 *
 *   GET  /v1/tribes                        — list tribes from the contract
 *   GET  /v1/tribes/{id}                   — get a tribe + the districts it owns
 *   GET  /v1/tribes/{id}/districts         — same as above, with full district rows
 *   GET  /v1/districts                     — list every district
 *   GET  /v1/districts/{id}                — get a district
 *   GET  /v1/districts/{id}/owner          — the current owner (tribe +
 *                                            controlled_since + history row)
 *
 * District control model:
 *
 *   - One row per district in `districts`. `current_owner_tribe_id` is the
 *     text id from `contract/ids/tribes.json`. The default holder is the
 *     tribe whose `homeTurf` matches the district's `slug`; `ensureDistricts`
 *     seeds the default and the daily rollover worker (`server/workers/
 *     district-rollover.ts`) flips the owner when a tribe outscores the
 *     current one.
 *   - `tribe_district_scores` is the per-day score per (tribe, district).
 *     UNIQUE on (tribe_id, district_id, day_date). The rollover worker
 *     writes the day's row + flips the owner + closes the prior
 *     `district_ownership_history` row.
 *   - `district_ownership_history` is the audit log of ownership periods;
 *     the current owner is the row with `valid_to IS NULL`. UNIQUE on
 *     (district_id, valid_from) is the floor for the worker's ON CONFLICT
 *     replay.
 *
 * Idempotency:
 *   - `ensureDistricts` is ON CONFLICT (district_id) DO NOTHING.
 *   - `rollDailyDistrict` upserts the day's score and the history row, so
 *     a re-run within the same day is a no-op.
 *
 * Per the master prompt's "Tribe district control and scores" gate, this
 * service is the only writer of `districts.current_owner_tribe_id` and
 * `district_ownership_history.valid_to`.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { weekIso } from './season-clock.js';
import type { AppContext } from './context.js';

interface TribeRegistryEntry {
  id: string;
  name: string;
  homeTurf: string;
  perk: string;
  emoteId: string;
  phase: number;
}

export interface TribeRow {
  readonly tribeId: string;
  readonly name: string;
  readonly homeTurf: string;
  readonly perk: string;
  readonly emoteId: string;
  readonly phase: number;
  readonly ownedDistricts: readonly string[];
}

export interface DistrictRow {
  readonly districtId: string;
  readonly slug: string;
  readonly name: string;
  readonly lore: string;
  readonly currentOwnerTribeId: string | null;
  readonly controlledSince: string | null;
  readonly defaultHolderTribeId: string;
  readonly baseScorePerDay: number;
}

export interface OwnershipRow {
  readonly districtId: string;
  readonly tribeId: string;
  readonly previousTribeId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
}

interface DistrictDbRow {
  district_id: string;
  slug: string;
  name: string;
  lore: string;
  current_owner_tribe_id: string | null;
  controlled_since: Date | null;
  default_holder_tribe_id: string;
  base_score_per_day: number;
}

interface HistoryDbRow {
  district_id: string;
  tribe_id: string;
  previous_tribe_id: string | null;
  valid_from: Date;
  valid_to: Date | null;
}

/** Read the tribe registry from the contract. The version is M1's. */
function readTribes(ctx: AppContext): TribeRegistryEntry[] {
  const reg = ctx.configCache.load<{ tribes: TribeRegistryEntry[] }>('tribes');
  return reg.tribes;
}

/** List every tribe in the registry, with the district slugs it owns. */
export async function listTribes(ctx: AppContext): Promise<TribeRow[]> {
  const tribes = readTribes(ctx);
  const owned = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ current_owner_tribe_id: string; slug: string }>(
      `SELECT current_owner_tribe_id, slug FROM districts WHERE current_owner_tribe_id IS NOT NULL`,
    );
    const map = new Map<string, string[]>();
    for (const row of r.rows) {
      const arr = map.get(row.current_owner_tribe_id) ?? [];
      arr.push(row.slug);
      map.set(row.current_owner_tribe_id, arr);
    }
    return map;
  });
  return tribes.map((t) => ({
    tribeId: t.id,
    name: t.name,
    homeTurf: t.homeTurf,
    perk: t.perk,
    emoteId: t.emoteId,
    phase: t.phase,
    ownedDistricts: owned.get(t.id) ?? [],
  }));
}

/** Get a single tribe by id. Throws NotFoundError if missing. */
export async function getTribe(ctx: AppContext, tribeId: string): Promise<TribeRow> {
  const all = await listTribes(ctx);
  const found = all.find((t) => t.tribeId === tribeId);
  if (!found) throw new NotFoundError({ kind: 'tribe', id: tribeId });
  return found;
}

/** List every district. */
export async function listDistricts(ctx: AppContext): Promise<DistrictRow[]> {
  const read = async (): Promise<DistrictDbRow[]> => {
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<DistrictDbRow>(
        `SELECT district_id, slug, name, lore, current_owner_tribe_id, controlled_since,
                default_holder_tribe_id, base_score_per_day
         FROM districts
         ORDER BY slug`,
      );
    });
    return r.rows;
  };
  let rows = await read();
  if (rows.length === 0) {
    // Nothing ever called ensureDistricts outside the tests, so the table
    // stayed empty and GET /v1/districts answered an empty list forever.
    // The seed is ON CONFLICT DO NOTHING, so healing here is safe and only
    // costs anything on the very first read.
    await ensureDistricts(ctx);
    rows = await read();
  }
  return rows.map(rowToDistrict);
}

/** Get a district by id. */
export async function getDistrict(ctx: AppContext, districtId: string): Promise<DistrictRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<DistrictDbRow>(
      `SELECT district_id, slug, name, lore, current_owner_tribe_id, controlled_since,
              default_holder_tribe_id, base_score_per_day
       FROM districts WHERE district_id = $1`,
      [districtId],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'district', id: districtId });
  return rowToDistrict(row);
}

/** Get the current owner of a district (the history row with valid_to IS NULL). */
export async function getDistrictOwner(
  ctx: AppContext,
  districtId: string,
): Promise<OwnershipRow | null> {
  // Make sure the district exists so we can map 404 cleanly.
  await getDistrict(ctx, districtId);
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<HistoryDbRow>(
      `SELECT district_id, tribe_id, previous_tribe_id, valid_from, valid_to
       FROM district_ownership_history
       WHERE district_id = $1 AND valid_to IS NULL
       ORDER BY valid_from DESC LIMIT 1`,
      [districtId],
    );
  });
  const row = r.rows[0];
  if (!row) return null;
  return {
    districtId: row.district_id,
    tribeId: row.tribe_id,
    previousTribeId: row.previous_tribe_id,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to ? row.valid_to.toISOString() : null,
  };
}

/** Idempotently seed the district table from the tribe registry. */
export async function ensureDistricts(ctx: AppContext): Promise<void> {
  const tribes = readTribes(ctx);
  // Each tribe's homeTurf becomes a district. We also seed the
  // known one-off districts that aren't anyone's homeTurf.
  const extraDistricts: ReadonlyArray<{
    slug: string;
    name: string;
    lore: string;
    baseScorePerDay: number;
  }> = [
    {
      slug: 'marina_villa',
      name: 'Dubai Marina',
      lore: 'Net-worth-gated penthouse district. The VIP Lounge sits at the top.',
      baseScorePerDay: 100,
    },
    {
      slug: 'cabal_lounge',
      name: 'VIP Lounge',
      lore: 'Invite-only room above the marina. The alpha flows here.',
      baseScorePerDay: 50,
    },
  ];
  for (const t of tribes) {
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO districts (district_id, slug, name, lore, current_owner_tribe_id,
                                controlled_since, default_holder_tribe_id, base_score_per_day)
         VALUES ($1, $2, $3, '', $4, now(), $4, $5)
         ON CONFLICT (district_id) DO NOTHING`,
        [t.homeTurf, t.homeTurf, t.name, t.id, 50],
      );
      // Seed the initial history row so getDistrictOwner returns
      // a real owner on a fresh install. The ON CONFLICT guards
      // against re-runs of ensureDistricts.
      await c.query(
        `INSERT INTO district_ownership_history
           (history_id, district_id, tribe_id, previous_tribe_id, valid_from, valid_to)
         SELECT $1, $2, $3, NULL, now(), NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM district_ownership_history WHERE district_id = $2
         )`,
        [uuidv7(), t.homeTurf, t.id],
      );
    });
  }
  for (const e of extraDistricts) {
    // Cabal Lounge is held by anon by default (it's outside the home-turf map).
    const holder = e.slug === 'cabal_lounge' ? 'anon' : 'trencher';
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO districts (district_id, slug, name, lore, current_owner_tribe_id,
                                controlled_since, default_holder_tribe_id, base_score_per_day)
         VALUES ($1, $2, $3, $4, $5, now(), $5, $6)
         ON CONFLICT (district_id) DO NOTHING`,
        [e.slug, e.slug, e.name, e.lore, holder, e.baseScorePerDay],
      );
      await c.query(
        `INSERT INTO district_ownership_history
           (history_id, district_id, tribe_id, previous_tribe_id, valid_from, valid_to)
         SELECT $1, $2, $3, NULL, now(), NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM district_ownership_history WHERE district_id = $2
         )`,
        [uuidv7(), e.slug, holder],
      );
    });
  }
}

/**
 * Roll the daily district scores for `dayDate` (YYYY-MM-DD, UTC). The
 * caller passes the per-tribe-per-district score table. The function:
 *
 *   1. Upserts each (tribe_id, district_id, day_date) row in
 *      `tribe_district_scores` (UNIQUE-index ON CONFLICT).
 *   2. For every district, picks the top-scoring tribe and, if it
 *      differs from the current owner, closes the prior history row
 *      (valid_to = now) and inserts a new one (valid_from = now,
 *      valid_to = NULL).
 *   3. Updates `districts.current_owner_tribe_id` and
 *      `districts.controlled_since`.
 *
 * Idempotent: re-running with the same `dayDate` is a no-op (the
 * scores and the history row already exist).
 */
export async function rollDailyDistrict(
  dayDate: string,
  scores: ReadonlyMap<string, ReadonlyMap<string, number>>,
  now: Date = new Date(),
): Promise<{ changed: number }> {
  // Validate the date format.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) {
    throw new ValidationFailedError({ reason: 'dayDate must be YYYY-MM-DD' });
  }
  let changed = 0;
  await runInTransaction(async (client) => {
    // 1. upsert the day's scores.
    for (const [districtId, perTribe] of scores) {
      for (const [tribeId, score] of perTribe) {
        if (!Number.isInteger(score) || score <= 0) continue;
        await client.query(
          `INSERT INTO tribe_district_scores (score_id, tribe_id, district_id, day_date, score)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tribe_id, district_id, day_date) DO UPDATE
             SET score = EXCLUDED.score`,
          [uuidv7(), tribeId, districtId, dayDate, score],
        );
      }
    }
    // 2. for every district, decide the new owner.
    const districts = await client.query<{
      district_id: string;
      current_owner_tribe_id: string | null;
    }>(`SELECT district_id, current_owner_tribe_id FROM districts FOR UPDATE`);
    for (const d of districts.rows) {
      const top = await client.query<{ tribe_id: string; score: number }>(
        `SELECT tribe_id, score FROM tribe_district_scores
         WHERE district_id = $1 AND day_date = $2
         ORDER BY score DESC LIMIT 1`,
        [d.district_id, dayDate],
      );
      const newOwner = top.rows[0]?.tribe_id;
      if (newOwner === undefined) continue;
      if (newOwner === d.current_owner_tribe_id) continue;
      // Close the prior history row (if any).
      await client.query(
        `UPDATE district_ownership_history
         SET valid_to = $1
         WHERE district_id = $2 AND valid_to IS NULL`,
        [now.toISOString(), d.district_id],
      );
      // Insert the new history row.
      await client.query(
        `INSERT INTO district_ownership_history
           (history_id, district_id, tribe_id, previous_tribe_id, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [uuidv7(), d.district_id, newOwner, d.current_owner_tribe_id, now.toISOString()],
      );
      // Update the district's current owner.
      await client.query(
        `UPDATE districts SET current_owner_tribe_id = $1, controlled_since = $2
         WHERE district_id = $3`,
        [newOwner, now.toISOString(), d.district_id],
      );
      changed++;
    }
  });
  return { changed };
}

function rowToDistrict(r: DistrictDbRow): DistrictRow {
  return {
    districtId: r.district_id,
    slug: r.slug,
    name: r.name,
    lore: r.lore,
    currentOwnerTribeId: r.current_owner_tribe_id,
    controlledSince: r.controlled_since ? r.controlled_since.toISOString() : null,
    defaultHolderTribeId: r.default_holder_tribe_id,
    baseScorePerDay: r.base_score_per_day,
  };
}

/**
 * Change the caller's tribe. The gate is "once per season": the
 * caller's characters.tribe_changed_at is the source of truth;
 * if it's in the same ISO-8601 week as the current date, the
 * call is refused with 409. The master prompt's M7 #4 spec
 * ("Tribe change once per season") is enforced here.
 *
 * The first-ever tribe change is always allowed (tribe_changed_at
 * is NULL).
 */
export async function changeTribe(
  ctx: AppContext,
  userId: string,
  newTribeId: string,
  now: Date = new Date(),
): Promise<{ tribeId: string; tribeChangedAt: string }> {
  // Validate the new tribe id against the contract.
  const tribes = readTribes(ctx);
  if (!tribes.some((t) => t.id === newTribeId)) {
    throw new ValidationFailedError({ reason: `unknown tribe ${newTribeId}` });
  }
  const currentSeason = weekIso(now);
  return runInTransaction(async (client) => {
    // Lock + read the character.
    const r = await client.query<{
      tribe_id: string;
      tribe_changed_at: Date | null;
    }>(
      `SELECT tribe_id, tribe_changed_at
       FROM characters WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const char = r.rows[0];
    if (!char) {
      throw new NotFoundError({ kind: 'character', userId });
    }
    if (char.tribe_id === newTribeId) {
      throw new ValidationFailedError({ reason: 'already in this tribe' });
    }
    if (char.tribe_changed_at !== null) {
      const priorSeason = weekIso(char.tribe_changed_at);
      if (priorSeason === currentSeason) {
        throw new ForbiddenError({
          reason: 'tribe change already used this season',
          lastChanged: char.tribe_changed_at.toISOString(),
        });
      }
    }
    await client.query(
      `UPDATE characters SET tribe_id = $1, tribe_changed_at = $2 WHERE user_id = $3`,
      [newTribeId, now.toISOString(), userId],
    );
    return {
      tribeId: newTribeId,
      tribeChangedAt: now.toISOString(),
    };
  });
}
