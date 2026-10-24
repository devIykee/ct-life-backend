/**
 * Player heat: how wanted a player is.
 *
 * Shady moves (so far: dumping a coin you launched on the people who bought
 * it, carjacking, hitting people with a vehicle) add heat; heat decays
 * exponentially with a 24 hour half-life. The police loop (`heat.ts`) reads
 * it: at `wanted` a pursuit starts.
 *
 * Only the decayed value at `updated_at` is stored. Readers decay it to
 * "now", so no job is needed to cool anyone down.
 */
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';

export const HEAT_MAX = 100;
export const HEAT_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

export type HeatLevel = 'cool' | 'warm' | 'hot' | 'wanted';

/**
 * Decay a heat value.
 * @param heat - Heat at `fromMs`.
 * @param fromMs - When that value was stored (epoch ms).
 * @param toMs - When to read it (epoch ms).
 */
export function decayHeat(heat: number, fromMs: number, toMs: number): number {
  const dt = Math.max(0, toMs - fromMs);
  return heat * Math.pow(0.5, dt / HEAT_HALF_LIFE_MS);
}

/** @param heat - Current heat. @returns The HUD band. */
export function heatLevel(heat: number): HeatLevel {
  if (heat < 10) return 'cool';
  if (heat < 35) return 'warm';
  if (heat < 70) return 'hot';
  return 'wanted';
}

/**
 * Add heat inside the caller's transaction.
 * @param client - The transaction client.
 * @param userId - Who earned the heat.
 * @param delta - Heat to add (> 0).
 * @param source - What caused it, e.g. `factory_rug`.
 * @param refId - The thing it was about, e.g. a coin id.
 * @param now - The current time.
 * @returns The new heat, capped at HEAT_MAX.
 */
export async function addHeat(
  client: PoolClient,
  userId: string,
  delta: number,
  source: string,
  refId: string | null,
  now: Date,
): Promise<number> {
  await client.query(
    `INSERT INTO player_heat (user_id, heat, updated_at) VALUES ($1, 0, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, now],
  );
  const cur = await client.query<{ heat: number; updated_at: Date }>(
    `SELECT heat, updated_at FROM player_heat WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = cur.rows[0]!;
  const decayed = decayHeat(row.heat, row.updated_at.getTime(), now.getTime());
  const next = Math.min(HEAT_MAX, decayed + Math.max(0, delta));
  await client.query(`UPDATE player_heat SET heat = $2, updated_at = $3 WHERE user_id = $1`, [
    userId,
    next,
    now,
  ]);
  await client.query(
    `INSERT INTO player_heat_events (user_id, delta, source, ref_id, heat_after, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, delta, source, refId, next, now],
  );
  return next;
}

/**
 * Multiply a player's heat by `factor` (0..1) inside the caller's transaction:
 * the cool-down after an escape or an arrest.
 * @param client - The transaction client.
 * @param userId - The player.
 * @param factor - What share of the (decayed) heat is kept.
 * @param source - What caused it, e.g. `pursuit_escaped`.
 * @param refId - The thing it was about, e.g. a pursuit id.
 * @param now - The current time.
 * @returns The new heat.
 */
export async function cutHeat(
  client: PoolClient,
  userId: string,
  factor: number,
  source: string,
  refId: string | null,
  now: Date,
): Promise<number> {
  const cur = await client.query<{ heat: number; updated_at: Date }>(
    `SELECT heat, updated_at FROM player_heat WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = cur.rows[0];
  if (!row) return 0;
  const decayed = decayHeat(row.heat, row.updated_at.getTime(), now.getTime());
  const next = Math.max(0, decayed * Math.min(1, Math.max(0, factor)));
  await client.query(`UPDATE player_heat SET heat = $2, updated_at = $3 WHERE user_id = $1`, [
    userId,
    next,
    now,
  ]);
  await client.query(
    `INSERT INTO player_heat_events (user_id, delta, source, ref_id, heat_after, at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, next - decayed, source, refId, next, now],
  );
  return next;
}

/**
 * Read a player's current heat, decayed to `now`.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param now - The current time.
 */
export async function getHeat(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<{ heat: number; level: HeatLevel; updatedAt: string | null }> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ heat: number; updated_at: Date }>(
      `SELECT heat, updated_at FROM player_heat WHERE user_id = $1`,
      [userId],
    ),
  );
  const row = r.rows[0];
  if (!row) return { heat: 0, level: 'cool', updatedAt: null };
  const heat = Math.round(decayHeat(row.heat, row.updated_at.getTime(), now.getTime()) * 10) / 10;
  return { heat, level: heatLevel(heat), updatedAt: row.updated_at.toISOString() };
}
