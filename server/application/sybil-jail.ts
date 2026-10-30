/**
 * Game-rolled Sybil jail, bail and the Sybil Barn (unlock A5).
 *
 * Farming the Airdrop Fields too greedily can land a player in the Sybil Barn
 * for a few hours. Every claim attempt that reaches the server is counted per
 * player in a Redis window (`windowSeconds`, contract/config/sybil_reasons.json).
 * Once the count reaches a tier's `minAttempts`, a CSPRNG roll at `chanceBps`
 * decides; the highest tier reached wins. A hit refuses that claim with
 * `403 SYBIL_JAILED` and writes a `sybil_jail` stay (2-12 h). The roll only
 * happens while the capability `sybilBail` is on, so no one is jailed by the
 * game before they can bail.
 *
 * Release is lazy: a stay counts while `released_at IS NULL AND release_at >
 * now`, so nothing has to run when the timer ends. Bail is a Cash sink (ledger
 * `sybil_bail`, the Cash leaves the economy; it never reaches another player):
 * the player's farm yield at jail time per started hour still to serve, times
 * `bailYieldMultiplier`, clamped to [minBailCents, maxBailCents].
 *
 * The admin jail for real multi-accounting (users.is_sybil_jailed, admin
 * routes) wins over a game stay, is never bailable and is not listed by alias
 * on the Barn board (counted only).
 */
import { randomInt } from 'node:crypto';
import type { AppContext } from './context.js';
import { publishToUser } from './realtime-bus.js';
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, InsufficientCashError, NotFoundError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';

export interface SybilTier {
  readonly reasonId: string;
  readonly minAttempts: number;
  readonly chanceBps: number;
  readonly jailMinutes: number;
}

export interface SybilConfig {
  readonly windowSeconds: number;
  readonly bailYieldMultiplier: number;
  readonly minBailCents: number;
  readonly maxBailCents: number;
  readonly tiers: readonly SybilTier[];
  readonly adminReasonId: string;
}

export interface SybilStatusRow {
  readonly jailed: boolean;
  readonly jailedAt: string | null;
  readonly releaseAt: string | null;
  readonly reasonId: string | null;
  readonly bailCents: number | null;
  readonly bailable: boolean;
  readonly source: 'game' | 'admin' | null;
}

export interface SybilBarnRow {
  readonly count: number;
  readonly inmates: ReadonlyArray<{
    userId: string;
    alias: string;
    reasonId: string;
    jailedAt: string;
    releaseAt: string;
  }>;
  readonly nextCursor: null;
}

/** Where the Barn board stops listing aliases. */
export const BARN_MAX_LISTED = 50;
/** A tribe whose members are counted on the board but never listed. */
const HIDDEN_TRIBE = 'anon';
const HOUR_MS = 3_600_000;

/** Roll source: an integer in [0, n). Tests pass a fixed one. */
export type Roll = (n: number) => number;
const cryptoRoll: Roll = (n) => randomInt(n);

type Queryable = Pick<Parameters<Parameters<typeof runInTransaction>[0]>[0], 'query'>;

/** @returns The Sybil config from the contract. */
export function sybilConfig(ctx: AppContext): SybilConfig {
  return ctx.configCache.load<SybilConfig>('sybil_reasons');
}

/**
 * The highest tier `attempts` reaches, or null.
 * @param cfg - The config.
 * @param attempts - Claim attempts in the current window.
 */
export function tierFor(cfg: SybilConfig, attempts: number): SybilTier | null {
  let best: SybilTier | null = null;
  for (const t of cfg.tiers) {
    if (attempts >= t.minAttempts && (best === null || t.minAttempts > best.minAttempts)) best = t;
  }
  return best;
}

/**
 * Bail for a stay right now.
 * @param cfg - The config.
 * @param perHourCents - The stay's yield snapshot.
 * @param releaseAt - When the stay ends.
 * @param now - Now.
 * @returns Cents, clamped to the config bounds.
 */
export function bailCentsFor(
  cfg: SybilConfig,
  perHourCents: number,
  releaseAt: Date,
  now: Date,
): number {
  const hours = Math.max(1, Math.ceil((releaseAt.getTime() - now.getTime()) / HOUR_MS));
  const raw = perHourCents * cfg.bailYieldMultiplier * hours;
  return Math.min(cfg.maxBailCents, Math.max(cfg.minBailCents, raw));
}

interface StayDbRow {
  jail_id: string;
  reason_id: string;
  jailed_at: Date;
  release_at: Date;
  bail_cents_per_hour: string;
}

/** The player's active game stay, if any. */
async function activeStay(
  q: Queryable,
  userId: string,
  now: Date,
  lock = false,
): Promise<StayDbRow | null> {
  const r = await q.query<StayDbRow>(
    `SELECT jail_id, reason_id, jailed_at, release_at, bail_cents_per_hour
       FROM sybil_jail
      WHERE user_id = $1 AND released_at IS NULL AND release_at > $2
      ORDER BY release_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [userId, now.toISOString()],
  );
  return r.rows[0] ?? null;
}

/**
 * The caller's Sybil status: admin jail first, then an active game stay.
 * @param q - A connection or transaction client.
 * @param cfg - The config.
 * @param userId - The player.
 * @param now - Now.
 * @returns The status.
 */
export async function readSybilStatus(
  q: Queryable,
  cfg: SybilConfig,
  userId: string,
  now: Date,
): Promise<SybilStatusRow> {
  const u = await q.query<{ is_sybil_jailed: boolean; sybil_jailed_at: Date | null }>(
    'SELECT is_sybil_jailed, sybil_jailed_at FROM users WHERE id = $1',
    [userId],
  );
  const row = u.rows[0];
  if (!row) throw new NotFoundError({ kind: 'user', id: userId });
  if (row.is_sybil_jailed) {
    return {
      jailed: true,
      jailedAt: row.sybil_jailed_at ? row.sybil_jailed_at.toISOString() : null,
      releaseAt: null,
      reasonId: cfg.adminReasonId,
      bailCents: null,
      bailable: false,
      source: 'admin',
    };
  }
  const stay = await activeStay(q, userId, now);
  if (!stay) return notJailed();
  return {
    jailed: true,
    jailedAt: stay.jailed_at.toISOString(),
    releaseAt: stay.release_at.toISOString(),
    reasonId: stay.reason_id,
    bailCents: bailCentsFor(cfg, Number(stay.bail_cents_per_hour), stay.release_at, now),
    bailable: true,
    source: 'game',
  };
}

/**
 * The `sybil_status` user message: the REST shape with epoch-ms times (the
 * realtime convention), plus `at`.
 * @param s - The status.
 * @param now - Now.
 */
function realtimeStatus(s: SybilStatusRow, now: Date): Record<string, unknown> {
  return {
    ...s,
    jailedAt: s.jailedAt === null ? null : Date.parse(s.jailedAt),
    releaseAt: s.releaseAt === null ? null : Date.parse(s.releaseAt),
    at: now.getTime(),
  };
}

/** @returns The not-jailed status. */
export function notJailed(): SybilStatusRow {
  return {
    jailed: false,
    jailedAt: null,
    releaseAt: null,
    reasonId: null,
    bailCents: null,
    bailable: false,
    source: null,
  };
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - Injectable clock.
 * @returns `GET /v1/me/sybil-status`.
 */
export async function getSybilStatus(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<SybilStatusRow> {
  const cfg = sybilConfig(ctx);
  return ctx.db.withConnection((c) => readSybilStatus(c, cfg, userId, now));
}

/**
 * Count one claim attempt and roll for a game jail. Call it before the claim
 * pays. Never throws for Redis trouble (the farm keeps working without it).
 * @param ctx - The app context.
 * @param userId - The claimer.
 * @param yieldCents - What today's claim pays this player (bail per hour).
 * @param now - Injectable clock.
 * @param roll - Injectable roll.
 * @returns The new status when the roll jailed the player, else null.
 */
export async function rollSybilJail(
  ctx: AppContext,
  userId: string,
  yieldCents: number,
  now: Date = new Date(),
  roll: Roll = cryptoRoll,
): Promise<SybilStatusRow | null> {
  const cfg = sybilConfig(ctx);
  let attempts: number;
  try {
    const key = `sybil:claims:${userId}`;
    // SET NX EX starts the window on the first attempt; INCR counts it.
    const res = (await ctx.redis.main
      .multi()
      .set(key, '0', 'EX', cfg.windowSeconds, 'NX')
      .incr(key)
      .exec()) as Array<[Error | null, unknown]>;
    attempts = Number(res[1]?.[1] ?? 0);
  } catch {
    return null;
  }
  const tier = tierFor(cfg, attempts);
  if (tier === null || roll(10_000) >= tier.chanceBps) return null;
  const releaseAt = new Date(now.getTime() + tier.jailMinutes * 60_000);
  // One stay at a time: two claims racing in both roll, but only the first to
  // take the user lock inserts; the other sees the stay and does nothing. A
  // stay whose timer ran out is closed here, so the partial unique index
  // (migration 113: one row per player with released_at NULL) holds.
  const inserted = await runInTransaction(
    async (c) => {
      await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      await c.query(
        `UPDATE sybil_jail SET released_at = release_at
          WHERE user_id = $1 AND released_at IS NULL AND release_at <= $2`,
        [userId, now.toISOString()],
      );
      if (await activeStay(c, userId, now)) return false;
      await c.query(
        `INSERT INTO sybil_jail (jail_id, user_id, reason_id, jailed_at, release_at, bail_cents_per_hour)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuidv7(),
          userId,
          tier.reasonId,
          now.toISOString(),
          releaseAt.toISOString(),
          Math.max(1, yieldCents),
        ],
      );
      return true;
    },
    {},
    ctx.db,
  );
  if (!inserted) return getSybilStatus(ctx, userId, now);
  try {
    await ctx.redis.main.del(`sybil:claims:${userId}`);
  } catch {
    // The window expires on its own.
  }
  const status = await getSybilStatus(ctx, userId, now);
  await publishToUser(ctx, userId, 'sybil_status', realtimeStatus(status, now));
  return status;
}

/**
 * Pay bail and leave the Barn. Admin jail is `409 not_bailable`; no stay is
 * `409 not_jailed`; short of Cash is `402 INSUFFICIENT_CASH {have, need}`.
 * The ledger row's idempotency ref is per stay, so a stay is paid once.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - Injectable clock.
 * @returns The status afterwards (not jailed).
 */
export async function paySybilBail(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<SybilStatusRow> {
  const cfg = sybilConfig(ctx);
  const paid = await runInTransaction(
    async (client) => {
      const status = await readSybilStatus(client, cfg, userId, now);
      if (status.source === 'admin') throw new ConflictError({ reason: 'not_bailable' });
      const stay = await activeStay(client, userId, now, true);
      if (!stay) throw new ConflictError({ reason: 'not_jailed' });
      const bail = bailCentsFor(cfg, Number(stay.bail_cents_per_hour), stay.release_at, now);
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const bal = await client.query<{ cash_cents: string }>(
        `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
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
         VALUES ($1, $2, 'cash', 'sybil_bail', 'sybil_jail', $3, $4)`,
        [userId, -bail, stay.jail_id, `sybil-bail:${stay.jail_id}`],
      );
      await client.query(
        `UPDATE sybil_jail SET released_at = $2, bail_paid_cents = $3 WHERE jail_id = $1`,
        [stay.jail_id, now.toISOString(), bail],
      );
      // Defensive: no other open stay may survive a paid bail.
      await client.query(
        `UPDATE sybil_jail SET released_at = $2
          WHERE user_id = $1 AND released_at IS NULL AND jail_id <> $3`,
        [userId, now.toISOString(), stay.jail_id],
      );
      return bail;
    },
    {},
    ctx.db,
  );
  const out = notJailed();
  await publishToUser(ctx, userId, 'sybil_status', {
    ...realtimeStatus(out, now),
    bailPaidCents: paid,
  });
  return out;
}

/**
 * Who is in the Barn right now. `count` covers every jailed player (game and
 * admin); `inmates` lists game stays only, by alias, soonest release first,
 * at most 50, never `anon` tribe members.
 * @param ctx - The app context.
 * @param now - Injectable clock.
 * @returns The board.
 */
export async function getSybilBarn(ctx: AppContext, now: Date = new Date()): Promise<SybilBarnRow> {
  return ctx.db.withConnection(async (c) => {
    const count = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT user_id FROM sybil_jail WHERE released_at IS NULL AND release_at > $1
         UNION
         SELECT id FROM users WHERE is_sybil_jailed
       ) jailed`,
      [now.toISOString()],
    );
    const rows = await c.query<{
      user_id: string;
      alias: string;
      reason_id: string;
      jailed_at: Date;
      release_at: Date;
    }>(
      `SELECT DISTINCT ON (j.user_id) j.user_id, ch.alias, j.reason_id, j.jailed_at, j.release_at
         FROM sybil_jail j
         JOIN characters ch ON ch.user_id = j.user_id
         JOIN users u ON u.id = j.user_id
        WHERE j.released_at IS NULL AND j.release_at > $1
          AND NOT u.is_sybil_jailed AND ch.tribe_id <> $2
        ORDER BY j.user_id, j.release_at DESC`,
      [now.toISOString(), HIDDEN_TRIBE],
    );
    const inmates = rows.rows
      .sort((a, b) => a.release_at.getTime() - b.release_at.getTime())
      .slice(0, BARN_MAX_LISTED)
      .map((r) => ({
        userId: r.user_id,
        alias: r.alias,
        reasonId: r.reason_id,
        jailedAt: r.jailed_at.toISOString(),
        releaseAt: r.release_at.toISOString(),
      }));
    return { count: Number(count.rows[0]?.n ?? 0), inmates, nextCursor: null };
  });
}

/**
 * Whether the player is jailed (admin or game), for gates such as venue
 * access and beef voting.
 * @param q - A connection or transaction client.
 * @param userId - The player.
 * @param now - Now.
 */
export async function isSybilJailed(q: Queryable, userId: string, now: Date): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM users WHERE id = $1 AND is_sybil_jailed
     UNION ALL
     SELECT 1 FROM sybil_jail WHERE user_id = $1 AND released_at IS NULL AND release_at > $2
     LIMIT 1`,
    [userId, now.toISOString()],
  );
  return (r.rowCount ?? 0) > 0;
}
