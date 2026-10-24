/**
 * Sleuth heat, police pursuit and CT Jail (parody; game Cash only).
 *
 * Heat itself is `player-heat.ts` (0..100, halves every 24 h). This module is
 * what heat DOES:
 *
 *   wanted (heat >= 70)  -> the referee starts a police pursuit for the player.
 *   pursuit              -> `police_pursuit` {pursuitId, targetUserId, units 1..4}; the client
 *                           drives the AI cruisers, the SERVER decides the outcome.
 *   caught               -> CT Jail (`ct_jail`) until `jailed_until`, bail in Cash, a Sleuth
 *                           "busted" Timeline post (rate limited), heat cut to 40%.
 *   escaped              -> heat cut to 50%.
 *
 * Cheat resistance: the referee (a worker tick, `policeTick`) judges every active
 * pursuit from the server's own position hash (`ctl:pos`, written only by the
 * street, venue and vehicle rooms after their speed checks) and from timers.
 * A client cannot report "escaped" at all. It can report "caught", but only for
 * its own pursuit, only after a minimum time, only with a fresh server position
 * that matches the one it reports; that report can only hurt the reporter. A
 * client that ignores the police is caught anyway when the pursuit timer ends,
 * and one that goes quiet (offline, hiding in a venue) gets no escape credit.
 *
 * All numbers are starting values to tune from play data (docs/HEAT.md).
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import {
  CatchNotVerifiedError,
  InsufficientCashError,
  JailedError,
  NoPursuitError,
  NotJailedError,
  RateLimitedError,
} from '../shared/domain/errors.js';
import { decodePos, POLICE_CHANNEL, POS_HASH } from '../realtime/movement.js';
import type { AppContext } from './context.js';
import {
  addHeat,
  cutHeat,
  decayHeat,
  getHeat,
  HEAT_HALF_LIFE_MS,
  heatLevel,
  type HeatLevel,
} from './player-heat.js';
import { SLEUTH_ALIAS, SLEUTH_USER_ID } from './factory-rug.js';
import { publishToUser } from './realtime-bus.js';

// --- Numbers [Inference: tune from play data] -------------------------------

/** Heat added per shady action. The Rugpull Factory's 35..50 lives in factory-rug.ts. */
export const HEAT_DELTA = {
  steal_npc: 8,
  steal_player: 15,
  vehicle_hit: 3,
  /** Hook for a future drainer job: call `raiseHeat(ctx, userId, HEAT_DELTA.drainer_job, 'drainer_job', jobId)`. */
  drainer_job: 20,
} as const;
export type HeatSource = keyof typeof HEAT_DELTA | 'factory_rug';

/** Level floors (heatLevel in player-heat.ts: warm 10, hot 35, wanted 70). */
export const LEVEL_FLOOR: Record<Exclude<HeatLevel, 'cool'>, number> = {
  warm: 10,
  hot: 35,
  wanted: 70,
};
export const WANTED_HEAT = LEVEL_FLOOR.wanted;

export const PURSUIT_MS = 180_000;
/** A pursuit does not start again this soon after the last one ended. */
export const PURSUIT_COOLDOWN_MS = 120_000;
export const ESCAPE_RADIUS_M = 200;
export const ESCAPE_AWAY_MS = 60_000;
/** Reaching your own home door this closely ends the pursuit (a safe house). */
export const SAFE_HOUSE_RADIUS_M = 8;
/** No pursuit starts, and the safe house does not count, within this of your own door. */
export const SAFE_HOUSE_GUARD_M = 40;
/** A server position older than this is "unknown" for the referee. */
/** Candidates fetched per SQL page. */
export const CANDIDATE_PAGE = 500;
export const POS_REFEREE_FRESH_MS = 15_000;

/** An early `POST /heat/caught` is not believed before this long after the start. */
export const CATCH_MIN_ELAPSED_MS = 10_000;
/** The reported player position must be this close to the server's. */
export const CATCH_POS_TOLERANCE_M = 15;
export const CATCH_BURST = 6;
export const CATCH_REFILL_PER_SEC = 6 / 60;

export const HEAT_AFTER_CAUGHT = 0.4;
export const HEAT_AFTER_ESCAPE = 0.5;

export const JAIL_BASE_MS = 90_000;
export const JAIL_MS_PER_HEAT = 3_000;
export const BAIL_MIN_CENTS = 1_000;
export const BAIL_CENTS_PER_HEAT = 50;
export const JAIL_VENUE_ID = 'ct_jail';

/** One "busted" post per player per window, and at most this many overall per window. */
export const BUSTED_POST_PLAYER_COOLDOWN_MS = 30 * 60_000;
export const BUSTED_POST_GLOBAL_WINDOW_MS = 10 * 60_000;
export const BUSTED_POST_GLOBAL_MAX = 10;

// --- Pure helpers ------------------------------------------------------------

/** @param heat - Heat at the moment the pursuit starts. @returns 1..4 cruisers. */
export function pursuitUnits(heat: number): number {
  return Math.min(4, Math.max(1, 1 + Math.floor((heat - WANTED_HEAT) / 10)));
}

/** @param heat - Heat at arrest. @returns The bail in whole Cash cents. */
export function bailFor(heat: number): number {
  return Math.max(BAIL_MIN_CENTS, Math.round(heat) * BAIL_CENTS_PER_HEAT);
}

/** @param heat - Heat at arrest. @returns How long the stay lasts if bail is not paid, ms. */
export function jailMsFor(heat: number): number {
  return JAIL_BASE_MS + Math.round(heat) * JAIL_MS_PER_HEAT;
}

/**
 * Island position of a flat's door, from its id `flat:lgmf_n439_p68:0`
 * (`n` negative, `p` positive; x then z, whole metres).
 * @param unitId - The home unit id.
 * @returns The door, or null for an id in another format.
 */
export function doorOfUnit(unitId: string): { x: number; z: number } | null {
  const m = /^flat:lgmf_([np])(\d+)_([np])(\d+):\d+$/.exec(unitId);
  if (!m) return null;
  return {
    x: (m[1] === 'n' ? -1 : 1) * Number(m[2]),
    z: (m[3] === 'n' ? -1 : 1) * Number(m[4]),
  };
}

export interface JudgeInput {
  readonly now: number;
  readonly expiresAt: number;
  readonly anchor: { x: number; z: number } | null;
  /** Epoch ms since the player has been continuously farther than the radius, or null. */
  readonly awaySince: number | null;
  /** The server's position for the player, only when fresh (otherwise null). */
  readonly pos: { x: number; z: number } | null;
  /** The player's own home door, or null. */
  readonly door: { x: number; z: number } | null;
}

export type Verdict =
  | { kind: 'continue'; anchor: { x: number; z: number } | null; awaySince: number | null }
  | { kind: 'escaped'; reason: 'distance' | 'safe_house' }
  | { kind: 'caught'; reason: 'timer' };

/**
 * Decide one referee step. Pure: position and timers in, verdict out.
 * Escape = stay farther than ESCAPE_RADIUS_M from the last wanted position for
 * ESCAPE_AWAY_MS in a row (unknown position resets the clock), or reach your
 * own home door. Otherwise the timer catches you.
 * @param i - The inputs.
 */
export function judgePursuit(i: JudgeInput): Verdict {
  let anchor = i.anchor;
  if (!anchor && i.pos) anchor = { x: i.pos.x, z: i.pos.z };
  let awaySince: number | null = null;
  if (i.pos && anchor) {
    if (
      i.door &&
      Math.hypot(i.pos.x - i.door.x, i.pos.z - i.door.z) <= SAFE_HOUSE_RADIUS_M &&
      Math.hypot(anchor.x - i.door.x, anchor.z - i.door.z) >= SAFE_HOUSE_GUARD_M
    ) {
      return { kind: 'escaped', reason: 'safe_house' };
    }
    if (Math.hypot(i.pos.x - anchor.x, i.pos.z - anchor.z) > ESCAPE_RADIUS_M) {
      awaySince = i.awaySince ?? i.now;
      if (i.now - awaySince >= ESCAPE_AWAY_MS) return { kind: 'escaped', reason: 'distance' };
    }
  }
  if (i.now >= i.expiresAt) return { kind: 'caught', reason: 'timer' };
  return { kind: 'continue', anchor, awaySince };
}

// --- Raising heat -------------------------------------------------------------

/**
 * Add heat for a shady action (its own transaction).
 * @param ctx - The application context.
 * @param userId - Who earned it.
 * @param delta - Heat to add.
 * @param source - What caused it.
 * @param refId - The thing it was about.
 * @param now - The current time.
 * @returns The new heat and level.
 */
export async function raiseHeat(
  ctx: AppContext,
  userId: string,
  delta: number,
  source: HeatSource,
  refId: string | null,
  now: Date = new Date(),
): Promise<{ heat: number; level: HeatLevel }> {
  const heat = await runInTransaction(
    (c) => addHeat(c, userId, delta, source, refId, now),
    {},
    ctx.db,
  );
  return { heat, level: heatLevel(heat) };
}

// --- Jail ----------------------------------------------------------------------

export interface ActiveJail {
  readonly jailId: string;
  readonly jailedAt: Date;
  readonly until: Date;
  readonly bailCents: number;
}

type Q = Pick<PoolClient, 'query'>;

/**
 * The player's current stay in CT Jail, if any (an expired stay is over even
 * before the sweep marks it released).
 * @param q - A connection.
 * @param userId - The player.
 * @param now - The current time.
 */
export async function activeJail(q: Q, userId: string, now: Date): Promise<ActiveJail | null> {
  const r = await q.query<{
    jail_id: string;
    jailed_at: Date;
    jailed_until: Date;
    bail_cents: string;
  }>(
    `SELECT jail_id, jailed_at, jailed_until, bail_cents FROM player_jail
      WHERE user_id = $1 AND released_at IS NULL AND jailed_until > $2`,
    [userId, now],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    jailId: row.jail_id,
    jailedAt: row.jailed_at,
    until: row.jailed_until,
    bailCents: Number(row.bail_cents),
  };
}

/**
 * Refuse an action while the player is in CT Jail. Used by trading, coin
 * launches, new perps, casino bets, and entering vehicles / other venues.
 * Selling, closing positions, reading and paying bail stay allowed.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param now - The current time.
 * @throws JailedError (403 JAILED) with `{until, bailCents}`.
 */
export async function assertNotJailed(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const j = await ctx.db.withConnection((c) => activeJail(c, userId, now));
  if (j) throw new JailedError({ until: j.until.toISOString(), bailCents: j.bailCents });
}

/**
 * Whether the player is in CT Jail (no throw), for the realtime rooms.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param now - The current time.
 */
export async function isJailed(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await ctx.db.withConnection((c) => activeJail(c, userId, now))) !== null;
}

/**
 * Pay bail: debit the Cash, free the player. Idempotent per stay.
 * @param ctx - The application context.
 * @param userId - The player (from the session).
 * @param now - The current time.
 * @throws NotJailedError when there is no stay to pay off, InsufficientCashError when short.
 */
export async function payBail(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<{ released: true; bailCents: number; cashCents: number }> {
  const out = await runInTransaction(
    async (client) => {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const bal = await client.query<{ cash_cents: string }>(
        `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const jail = await client.query<{ jail_id: string; bail_cents: string }>(
        `SELECT jail_id, bail_cents FROM player_jail
          WHERE user_id = $1 AND released_at IS NULL AND jailed_until > $2 FOR UPDATE`,
        [userId, now],
      );
      const row = jail.rows[0];
      if (!row) throw new NotJailedError({});
      const bail = Number(row.bail_cents);
      const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
      if (cash < BigInt(bail)) {
        throw new InsufficientCashError({ have: cash.toString(), need: String(bail) });
      }
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents - $2, updated_at = now() WHERE user_id = $1`,
        [userId, bail],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'police_bail', 'jail', $3, $4)`,
        [userId, -bail, row.jail_id, `police-bail:${row.jail_id}`],
      );
      await client.query(
        `UPDATE player_jail SET released_at = $2, release_reason = 'bail' WHERE user_id = $1`,
        [userId, now],
      );
      return { bailCents: bail, cashCents: Number(cash - BigInt(bail)) };
    },
    {},
    ctx.db,
  );
  await publishToUser(ctx, userId, 'released', {
    reason: 'bail',
    venueId: JAIL_VENUE_ID,
    at: now.getTime(),
  });
  return { released: true, ...out };
}

/**
 * Mark stays whose timer ran out as released and tell the players.
 * @param ctx - The application context.
 * @param now - The current time.
 * @returns How many were released.
 */
export async function releaseExpiredJails(ctx: AppContext, now: Date): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ user_id: string }>(
      `UPDATE player_jail SET released_at = $1, release_reason = 'timer'
        WHERE released_at IS NULL AND jailed_until <= $1 RETURNING user_id`,
      [now],
    ),
  );
  for (const row of r.rows) {
    await publishToUser(ctx, row.user_id, 'released', {
      reason: 'timer',
      venueId: JAIL_VENUE_ID,
      at: now.getTime(),
    });
  }
  return r.rows.length;
}

// --- GET /heat/me ----------------------------------------------------------------

export interface HeatMe {
  readonly heat: number;
  readonly level: HeatLevel;
  readonly decayAt: string | null;
  readonly wantedUntil: string | null;
  readonly levels: { warm: number; hot: number; wanted: number };
  readonly pursuit: {
    pursuitId: string;
    units: number;
    startedAt: string;
    expiresAt: string;
    escapeRadiusM: number;
    escapeSeconds: number;
  } | null;
  readonly jail: {
    venueId: string;
    jailedAt: string;
    until: string;
    bailCents: number;
  } | null;
}

/**
 * The HUD state: heat, level, when the level drops, active pursuit and jail.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param now - The current time.
 */
export async function getHeatMe(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<HeatMe> {
  const h = await getHeat(ctx, userId, now);
  const { pursuit, jail } = await ctx.db.withConnection(async (c) => ({
    pursuit: await c.query<{
      pursuit_id: string;
      units: number;
      started_at: Date;
      expires_at: Date;
    }>(
      `SELECT pursuit_id, units, started_at, expires_at FROM heat_pursuits
        WHERE user_id = $1 AND status = 'active'`,
      [userId],
    ),
    jail: await activeJail(c, userId, now),
  }));
  const floor = h.level === 'cool' ? null : LEVEL_FLOOR[h.level];
  // When the heat will have decayed below the floor of its current level.
  const decayAt =
    floor !== null && h.heat > 0
      ? new Date(
          now.getTime() + Math.max(0, Math.log2(h.heat / floor)) * HEAT_HALF_LIFE_MS,
        ).toISOString()
      : null;
  const p = pursuit.rows[0];
  const wantedUntil =
    h.level === 'wanted' && decayAt
      ? new Date(
          Math.max(new Date(decayAt).getTime(), p ? p.expires_at.getTime() : 0),
        ).toISOString()
      : null;
  return {
    heat: h.heat,
    level: h.level,
    decayAt,
    wantedUntil,
    levels: { ...LEVEL_FLOOR },
    pursuit: p
      ? {
          pursuitId: p.pursuit_id,
          units: p.units,
          startedAt: p.started_at.toISOString(),
          expiresAt: p.expires_at.toISOString(),
          escapeRadiusM: ESCAPE_RADIUS_M,
          escapeSeconds: ESCAPE_AWAY_MS / 1000,
        }
      : null,
    jail: jail
      ? {
          venueId: JAIL_VENUE_ID,
          jailedAt: jail.jailedAt.toISOString(),
          until: jail.until.toISOString(),
          bailCents: jail.bailCents,
        }
      : null,
  };
}

// --- Pursuit lifecycle --------------------------------------------------------------

async function freshPos(
  ctx: AppContext,
  userId: string,
  now: number,
): Promise<{ x: number; z: number } | null> {
  try {
    const p = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
    return p && now - p.at <= POS_REFEREE_FRESH_MS ? { x: p.x, z: p.z } : null;
  } catch {
    return null;
  }
}

async function homeDoor(q: Q, userId: string): Promise<{ x: number; z: number } | null> {
  const r = await q.query<{ unit_id: string | null }>(
    `SELECT unit_id FROM homes
      WHERE owner_user_id = $1 AND status IN ('active', 'overdue') AND unit_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const id = r.rows[0]?.unit_id;
  return id ? doorOfUnit(id) : null;
}

/**
 * Start a pursuit for every wanted player who is online, outside their own
 * door's guard radius, not jailed and not in the post-pursuit cooldown.
 * @param ctx - The application context.
 * @param now - The current time.
 * @returns The ids of the players a pursuit started for.
 */
export async function startPursuits(ctx: AppContext, now: Date): Promise<string[]> {
  // Heat decays lazily, so the stored value overstates it. Decay in SQL (same half-life as the
  // app) so only genuinely wanted players are candidates, and page through all of them by
  // user id: no fixed cap can be filled with stale rows, and nobody is dropped silently.
  const cutoff = new Date(now.getTime() - PURSUIT_COOLDOWN_MS);
  const rows: { user_id: string; heat: number; updated_at: Date }[] = [];
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await ctx.db.withConnection((c) =>
      c.query<{ user_id: string; heat: number; updated_at: Date }>(
        `SELECT h.user_id, h.heat, h.updated_at FROM player_heat h
           LEFT JOIN heat_pursuits p ON p.user_id = h.user_id
           LEFT JOIN player_jail j ON j.user_id = h.user_id
          WHERE h.user_id > $4
            AND h.heat * power(0.5, GREATEST(0, extract(epoch FROM ($3::timestamptz - h.updated_at)) * 1000) / $5)
                >= $1
            AND (p.user_id IS NULL OR (p.status <> 'active' AND p.ended_at <= $2))
            AND (j.user_id IS NULL OR j.released_at IS NOT NULL OR j.jailed_until <= $3)
          ORDER BY h.user_id
          LIMIT $6`,
        [WANTED_HEAT, cutoff, now, after, HEAT_HALF_LIFE_MS, CANDIDATE_PAGE],
      ),
    );
    rows.push(...page.rows);
    if (page.rows.length < CANDIDATE_PAGE) break;
    after = page.rows[page.rows.length - 1]!.user_id;
  }
  // Most wanted first.
  rows.sort(
    (x, y) =>
      decayHeat(y.heat, y.updated_at.getTime(), now.getTime()) -
      decayHeat(x.heat, x.updated_at.getTime(), now.getTime()),
  );
  const cands = { rows };
  const started: string[] = [];
  for (const row of cands.rows) {
    const heat = decayHeat(row.heat, row.updated_at.getTime(), now.getTime());
    if (heat < WANTED_HEAT) continue;
    const pos = await freshPos(ctx, row.user_id, now.getTime());
    if (!pos) continue;
    const door = await ctx.db.withConnection((c) => homeDoor(c, row.user_id));
    if (door && Math.hypot(pos.x - door.x, pos.z - door.z) < SAFE_HOUSE_GUARD_M) continue;
    const pursuitId = uuidv7();
    const units = pursuitUnits(heat);
    const expiresAt = new Date(now.getTime() + PURSUIT_MS);
    const ins = await ctx.db.withConnection((c) =>
      c.query(
        `INSERT INTO heat_pursuits
           (user_id, pursuit_id, status, units, heat_at_start, started_at, expires_at, anchor_x, anchor_z)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE SET
           pursuit_id = EXCLUDED.pursuit_id, status = 'active', units = EXCLUDED.units,
           heat_at_start = EXCLUDED.heat_at_start, started_at = EXCLUDED.started_at,
           expires_at = EXCLUDED.expires_at, anchor_x = EXCLUDED.anchor_x,
           anchor_z = EXCLUDED.anchor_z, away_since = NULL, ended_at = NULL, end_reason = NULL
         WHERE heat_pursuits.status <> 'active'`,
        [row.user_id, pursuitId, units, heat, now, expiresAt, pos.x, pos.z],
      ),
    );
    if ((ins.rowCount ?? 0) === 0) continue;
    started.push(row.user_id);
    const payload = {
      pursuitId,
      targetUserId: row.user_id,
      units,
      heat: Math.round(heat),
      startedAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
      escapeRadiusM: ESCAPE_RADIUS_M,
      escapeSeconds: ESCAPE_AWAY_MS / 1000,
      at: now.getTime(),
    };
    await publishToUser(ctx, row.user_id, 'police_pursuit', payload);
    await publishPolice(ctx, 'police_pursuit', row.user_id, payload);
  }
  return started;
}

/** Street rooms that hold the target fan the event out to everyone in the room. */
async function publishPolice(
  ctx: AppContext,
  type: 'police_pursuit' | 'police_pursuit_end',
  targetUserId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.redis.main.publish(POLICE_CHANNEL, JSON.stringify({ type, targetUserId, payload }));
  } catch {
    // Best effort; the target also gets it directly.
  }
}

interface ActiveRow {
  user_id: string;
  pursuit_id: string;
  started_at: Date;
  expires_at: Date;
  anchor_x: number | null;
  anchor_z: number | null;
  away_since: Date | null;
}

/**
 * Judge every active pursuit once.
 * @param ctx - The application context.
 * @param now - The current time.
 * @returns How many pursuits ended.
 */
export async function evaluatePursuits(ctx: AppContext, now: Date): Promise<number> {
  const act = await ctx.db.withConnection((c) =>
    c.query<ActiveRow>(
      `SELECT user_id, pursuit_id, started_at, expires_at, anchor_x, anchor_z, away_since
         FROM heat_pursuits WHERE status = 'active' LIMIT 500`,
    ),
  );
  let ended = 0;
  for (const r of act.rows) {
    const pos = await freshPos(ctx, r.user_id, now.getTime());
    const door = await ctx.db.withConnection((c) => homeDoor(c, r.user_id));
    const v = judgePursuit({
      now: now.getTime(),
      expiresAt: r.expires_at.getTime(),
      anchor: r.anchor_x !== null && r.anchor_z !== null ? { x: r.anchor_x, z: r.anchor_z } : null,
      awaySince: r.away_since ? r.away_since.getTime() : null,
      pos,
      door,
    });
    if (v.kind === 'continue') {
      await ctx.db.withConnection((c) =>
        c.query(
          `UPDATE heat_pursuits SET anchor_x = $2, anchor_z = $3, away_since = $4
            WHERE user_id = $1 AND pursuit_id = $5 AND status = 'active'`,
          [
            r.user_id,
            v.anchor?.x ?? null,
            v.anchor?.z ?? null,
            v.awaySince ? new Date(v.awaySince) : null,
            r.pursuit_id,
          ],
        ),
      );
      continue;
    }
    const done =
      v.kind === 'caught'
        ? await finishCaught(ctx, r.user_id, r.pursuit_id, v.reason, now)
        : await finishEscaped(ctx, r.user_id, r.pursuit_id, v.reason, now);
    if (done) ended++;
  }
  return ended;
}

/**
 * One referee tick: start pursuits, judge active ones, release expired stays.
 * @param ctx - The application context.
 * @param now - The current time.
 */
export async function policeTick(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ started: number; ended: number; released: number }> {
  const started = (await startPursuits(ctx, now)).length;
  const ended = await evaluatePursuits(ctx, now);
  const released = await releaseExpiredJails(ctx, now);
  return { started, ended, released };
}

async function finishEscaped(
  ctx: AppContext,
  userId: string,
  pursuitId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const heat = await runInTransaction(
    async (client) => {
      const p = await client.query(
        `UPDATE heat_pursuits SET status = 'escaped', ended_at = $3, end_reason = $4
          WHERE user_id = $1 AND pursuit_id = $2 AND status = 'active'`,
        [userId, pursuitId, now, reason],
      );
      if ((p.rowCount ?? 0) === 0) return null;
      return cutHeat(client, userId, HEAT_AFTER_ESCAPE, 'pursuit_escaped', pursuitId, now);
    },
    {},
    ctx.db,
  );
  if (heat === null) return false;
  const payload = {
    pursuitId,
    targetUserId: userId,
    outcome: 'escaped',
    reason,
    heat: Math.round(heat),
    at: now.getTime(),
  };
  await publishToUser(ctx, userId, 'police_pursuit_end', payload);
  await publishPolice(ctx, 'police_pursuit_end', userId, payload);
  return true;
}

async function finishCaught(
  ctx: AppContext,
  userId: string,
  pursuitId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const out = await runInTransaction(
    async (client) => {
      const p = await client.query(
        `UPDATE heat_pursuits SET status = 'caught', ended_at = $3, end_reason = $4
          WHERE user_id = $1 AND pursuit_id = $2 AND status = 'active'`,
        [userId, pursuitId, now, reason],
      );
      if ((p.rowCount ?? 0) === 0) return null;
      const cur = await client.query<{ heat: number; updated_at: Date }>(
        `SELECT heat, updated_at FROM player_heat WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const row = cur.rows[0];
      const heat = row ? decayHeat(row.heat, row.updated_at.getTime(), now.getTime()) : 0;
      const bail = bailFor(heat);
      const until = new Date(now.getTime() + jailMsFor(heat));
      const jailId = uuidv7();
      await client.query(
        `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           jail_id = EXCLUDED.jail_id, jailed_at = EXCLUDED.jailed_at,
           jailed_until = EXCLUDED.jailed_until, bail_cents = EXCLUDED.bail_cents,
           heat_at_arrest = EXCLUDED.heat_at_arrest, released_at = NULL, release_reason = NULL`,
        [userId, jailId, now, until, bail, heat],
      );
      const after = await cutHeat(
        client,
        userId,
        HEAT_AFTER_CAUGHT,
        'pursuit_caught',
        pursuitId,
        now,
      );
      const postId = await postBusted(client, userId, Math.round(heat), bail, now);
      return { bail, until, jailId, heat, after, postId };
    },
    {},
    ctx.db,
  );
  if (!out) return false;
  const end = {
    pursuitId,
    targetUserId: userId,
    outcome: 'caught',
    reason,
    heat: Math.round(out.after),
    at: now.getTime(),
  };
  await publishToUser(ctx, userId, 'police_pursuit_end', end);
  await publishPolice(ctx, 'police_pursuit_end', userId, end);
  await publishToUser(ctx, userId, 'jailed', {
    venueId: JAIL_VENUE_ID,
    jailId: out.jailId,
    until: out.until.getTime(),
    bailCents: out.bail,
    heat: Math.round(out.heat),
    at: now.getTime(),
  });
  return true;
}

// --- The client's catch report -----------------------------------------------------

export interface CaughtReport {
  readonly pursuitId: string;
  readonly x: number;
  readonly z: number;
}

/**
 * The client says a cruiser got it. Believed only if the server agrees: the
 * pursuit is the caller's own and active, old enough, the server has a fresh
 * position for the player that matches the reported one. The cruisers are client AI, so the server cannot see them; what it can check
 * is the player's own position and the clock. A false report only jails the
 * reporter.
 * @param ctx - The application context.
 * @param userId - The player (from the session).
 * @param report - The pursuit id and the player's reported position.
 * @param now - The current time.
 */
export async function reportCaught(
  ctx: AppContext,
  userId: string,
  report: CaughtReport,
  now: Date = new Date(),
): Promise<HeatMe> {
  const d = await perUserTokenBucket(
    ctx.redis.main,
    `rl:heat-caught:${userId}`,
    CATCH_BURST,
    CATCH_REFILL_PER_SEC,
  );
  if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { limit: '6/min' });
  const act = await ctx.db.withConnection((c) =>
    c.query<{ pursuit_id: string; started_at: Date; expires_at: Date }>(
      `SELECT pursuit_id, started_at, expires_at FROM heat_pursuits
        WHERE user_id = $1 AND status = 'active'`,
      [userId],
    ),
  );
  const p = act.rows[0];
  if (!p || p.pursuit_id !== report.pursuitId) throw new NoPursuitError({});
  if (now.getTime() - p.started_at.getTime() < CATCH_MIN_ELAPSED_MS) {
    throw new CatchNotVerifiedError({ reason: 'too_early' });
  }
  const pos = await freshPos(ctx, userId, now.getTime());
  if (!pos) throw new CatchNotVerifiedError({ reason: 'position_unknown' });
  if (Math.hypot(report.x - pos.x, report.z - pos.z) > CATCH_POS_TOLERANCE_M) {
    throw new CatchNotVerifiedError({ reason: 'position_mismatch' });
  }
  const ok = await finishCaught(ctx, userId, p.pursuit_id, 'client_report', now);
  if (!ok) throw new NoPursuitError({});
  return getHeatMe(ctx, userId, now);
}

// --- The Sleuth's "busted" post --------------------------------------------------------

const BUSTED_LINES = [
  '{alias} has been picked up by the compliance cruisers. Bail is {bail}. The receipts were public the whole time.',
  'Thread: {alias} thought nobody was tracing the wallet. Cuffed at heat {heat}. Bail set at {bail}.',
  'Another one for the cell. {alias} is in CT Jail until someone pays {bail} or the clock runs out.',
  '{alias} ran. The cruisers had the route mapped before the first turn. Heat {heat}. Bail {bail}.',
  'Called it. {alias} is booked at heat {heat}. Anyone with {bail} to spare can wave goodbye at the gate.',
  'On-chain trails do not lie, and neither do sirens. {alias} is behind the glass. Bail: {bail}.',
] as const;

/**
 * Text of a busted post (our own words; varies by the player id).
 * @param userId - The arrested player (picks the variant).
 * @param p - Alias, heat and bail to show.
 */
export function bustedPostText(
  userId: string,
  p: { alias: string; heat: number; bailCents: number },
): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tpl = BUSTED_LINES[h % BUSTED_LINES.length]!;
  return tpl
    .replace('{alias}', p.alias)
    .replace('{heat}', String(p.heat))
    .replace('{bail}', `${(p.bailCents / 100).toFixed(2)} Cash`);
}

/**
 * Write the Sleuth's Timeline post about an arrest, unless rate limited.
 * @param client - The transaction client.
 * @param userId - The arrested player.
 * @param heat - Heat at arrest.
 * @param bailCents - The bail.
 * @param now - The current time.
 * @returns The post id, or null when rate limited.
 */
async function postBusted(
  client: PoolClient,
  userId: string,
  heat: number,
  bailCents: number,
  now: Date,
): Promise<string | null> {
  const mine = await client.query(
    `SELECT 1 FROM feed_posts
      WHERE kind = 'sleuth' AND meta ->> 'event' = 'busted' AND meta ->> 'subjectUserId' = $1
        AND created_at > $2 LIMIT 1`,
    [userId, new Date(now.getTime() - BUSTED_POST_PLAYER_COOLDOWN_MS)],
  );
  if ((mine.rowCount ?? 0) > 0) return null;
  const all = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM feed_posts
      WHERE kind = 'sleuth' AND meta ->> 'event' = 'busted' AND created_at > $1`,
    [new Date(now.getTime() - BUSTED_POST_GLOBAL_WINDOW_MS)],
  );
  if (Number(all.rows[0]!.n) >= BUSTED_POST_GLOBAL_MAX) return null;
  const al = await client.query<{ alias: string | null }>(
    `SELECT alias FROM characters WHERE user_id = $1`,
    [userId],
  );
  const alias = al.rows[0]?.alias ?? 'an anonymous degen';
  const id = uuidv7();
  await client.query(
    `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta)
     VALUES ($1, $2, $3, $4, 'sleuth', $5)`,
    [
      id,
      SLEUTH_USER_ID,
      bustedPostText(userId, { alias, heat, bailCents }),
      now,
      JSON.stringify({
        event: 'busted',
        subjectUserId: userId,
        subjectAlias: alias,
        heat,
        bailCents,
        deepLink: `venue:${JAIL_VENUE_ID}`,
        author: SLEUTH_ALIAS,
      }),
    ],
  );
  return id;
}
