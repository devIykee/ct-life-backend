/**
 * The Rug Room: a Cash-only, play-money casino (18+).
 *
 *   GET  /v1/casino/state
 *   POST /v1/casino/slots/spin
 *   POST /v1/casino/crash/bet
 *   POST /v1/casino/crash/cashout
 *   POST /v1/casino/coinflip/bet
 *   POST /v1/casino/coinflip/challenges            (head-to-head)
 *   GET  /v1/casino/coinflip/challenges
 *   POST /v1/casino/coinflip/challenges/:id/accept | decline | cancel
 *   GET  /v1/casino/rounds?mine
 *   POST /v1/casino/self-exclude
 *
 * Rules enforced here, in this order, before any stake is taken: the stake
 * is in range, the player has confirmed 18+ (`AGE_REQUIRED`), is not
 * self-excluded (`SELF_EXCLUDED`), is inside the daily stake cap and net-loss
 * cap (`STAKE_CAP_REACHED`, `LOSS_CAP_REACHED`) and holds enough Cash.
 *
 * Money. Cash only; there is no cash-out and nothing tradable is paid. Every
 * action runs in ONE transaction that locks the player's `casino_players`
 * row (so one player's bets are serialized and the caps cannot be raced) and
 * the `balances` row, writes the ledger rows (`casino_stake`, `casino_win`,
 * `casino_refund`) and the `casino_rounds` row. A crash round that is still
 * open is the only round that spans requests; it settles under a row lock.
 *
 * Randomness is commit-reveal and server-side only; see casino-math.ts.
 * Daily windows are the UTC day; the caps are counted from the ledger so
 * they include stakes held in escrow and refunds.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  AgeRequiredError,
  BlockedError,
  ChallengeExpiredError,
  ChallengeNotOpenError,
  ForbiddenError,
  InsufficientCashError,
  LossCapReachedError,
  NotFoundError,
  RoundInProgressError,
  RoundSettledError,
  SelfExcludedError,
  StakeCapReachedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import {
  CASINO_DISCLAIMER,
  CASINO_LEDGER_REASONS,
  CASINO_REFUND,
  CASINO_STAKE,
  CASINO_WIN,
} from './casino-constants.js';
import {
  crashPointX100,
  crashTimeMs,
  drawStream,
  flipCoin,
  hashSeed,
  newSeed,
  payoutFor,
  settleCrashAuto,
  settleCrashManual,
  slotsStats,
  spinSlots,
  toX100,
  type CasinoConfig,
  type CoinSide,
  type CrashSettlement,
} from './casino-math.js';

const DAY_MS = 86_400_000;
const MAX_OPEN_CHALLENGES = 5;

export type CasinoGame = 'slots' | 'crash' | 'coinflip' | 'coinflip_h2h';

export interface Meta {
  readonly disclaimer: string;
  /** Minutes of continuous play (a gap over `sessionGapMinutes` ends a session). */
  readonly sessionMinutes: number;
  /** True from `sessionReminderMinutes` of continuous play: show the break popup. */
  readonly sessionReminder: boolean;
}

export interface RoundView {
  readonly roundId: string;
  readonly game: CasinoGame;
  readonly status: 'open' | 'settled';
  readonly stakeCents: number;
  readonly payoutCents: number | null;
  /** Public inputs of the round (crash: start time and growth rate). */
  readonly params: Record<string, unknown>;
  /** The result; null while the round is open. */
  readonly outcome: Record<string, unknown> | null;
  /** Published when the round opens. */
  readonly seedHash: string;
  /** Revealed once the round has settled, never before. */
  readonly seed: string | null;
  readonly challengeId: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export type BetResult = Meta & { readonly round: RoundView; readonly cashCents: number };

export interface ChallengeView {
  readonly challengeId: string;
  readonly role: 'challenger' | 'opponent';
  readonly challengerId: string;
  readonly challengerAlias: string | null;
  readonly opponentId: string;
  readonly opponentAlias: string | null;
  readonly challengerSide: CoinSide;
  readonly status: 'open' | 'settled' | 'expired' | 'cancelled' | 'declined';
  readonly seedHash: string;
  /** Revealed once settled. */
  readonly seed: string | null;
  readonly result: CoinSide | null;
  readonly winnerId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt: string | null;
}

// --- Config ---------------------------------------------------------------

function cfgOf(ctx: AppContext): CasinoConfig {
  return ctx.configCache.load<CasinoConfig>('casino');
}

// --- Row shapes -----------------------------------------------------------

interface RoundRow {
  round_id: string;
  user_id: string;
  game: CasinoGame;
  status: 'open' | 'settled';
  stake_cents: string;
  payout_cents: string | null;
  params: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  seed_hash: string;
  seed: string | null;
  challenge_id: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const ROUND_COLUMNS = `round_id, user_id, game, status, stake_cents, payout_cents, params, outcome,
       seed_hash, seed, challenge_id, created_at, settled_at`;

function toRound(r: RoundRow): RoundView {
  return {
    roundId: r.round_id,
    game: r.game,
    status: r.status,
    stakeCents: Number(r.stake_cents),
    payoutCents: r.payout_cents === null ? null : Number(r.payout_cents),
    params: r.params,
    outcome: r.outcome,
    seedHash: r.seed_hash,
    // The seed of an open round must never leave the server.
    seed: r.status === 'settled' ? r.seed : null,
    challengeId: r.challenge_id,
    createdAt: r.created_at.toISOString(),
    settledAt: r.settled_at === null ? null : r.settled_at.toISOString(),
  };
}

interface ChallengeRow {
  challenge_id: string;
  challenger_id: string;
  opponent_id: string;
  stake_cents: string;
  challenger_side: CoinSide;
  status: ChallengeView['status'];
  seed: string;
  seed_hash: string;
  result: CoinSide | null;
  winner_id: string | null;
  pot_cents: string | null;
  house_cut_cents: string | null;
  payout_cents: string | null;
  created_at: Date;
  expires_at: Date;
  settled_at: Date | null;
}

const CHALLENGE_COLUMNS = `challenge_id, challenger_id, opponent_id, stake_cents, challenger_side, status,
       seed, seed_hash, result, winner_id, pot_cents, house_cut_cents, payout_cents,
       created_at, expires_at, settled_at`;

function toChallenge(
  r: ChallengeRow,
  viewer: string,
  aliases: ReadonlyMap<string, string>,
): ChallengeView {
  return {
    challengeId: r.challenge_id,
    role: r.challenger_id === viewer ? 'challenger' : 'opponent',
    challengerId: r.challenger_id,
    challengerAlias: aliases.get(r.challenger_id) ?? null,
    opponentId: r.opponent_id,
    opponentAlias: aliases.get(r.opponent_id) ?? null,
    challengerSide: r.challenger_side,
    status: r.status,
    seedHash: r.seed_hash,
    seed: r.status === 'settled' ? r.seed : null,
    result: r.result,
    winnerId: r.winner_id,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    settledAt: r.settled_at === null ? null : r.settled_at.toISOString(),
  };
}

async function aliasMap(client: PoolClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const r = await client.query<{ user_id: string; alias: string }>(
    `SELECT user_id, alias FROM characters WHERE user_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const row of r.rows) out.set(row.user_id, row.alias);
  return out;
}

// --- Gates, caps, session -------------------------------------------------

/** Start of the UTC day containing `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

export interface DayUsage {
  readonly stakedCents: number;
  readonly netLossCents: number;
}

async function dayUsage(client: PoolClient, userId: string, now: Date): Promise<DayUsage> {
  const from = utcDayStart(now);
  const r = await client.query<{ staked: string; refunded: string; net: string }>(
    `SELECT COALESCE(-SUM(delta_cents) FILTER (WHERE reason = $4), 0) AS staked,
            COALESCE(SUM(delta_cents) FILTER (WHERE reason = $5), 0) AS refunded,
            COALESCE(SUM(delta_cents), 0) AS net
       FROM ledger_entries
      WHERE user_id = $1 AND account = 'cash' AND reason = ANY($6::text[])
        AND created_at >= $2 AND created_at < $3`,
    [
      userId,
      from,
      new Date(from.getTime() + DAY_MS),
      CASINO_STAKE,
      CASINO_REFUND,
      [...CASINO_LEDGER_REASONS],
    ],
  );
  const row = r.rows[0]!;
  return {
    stakedCents: Math.max(0, Number(row.staked) - Number(row.refunded)),
    netLossCents: Math.max(0, -Number(row.net)),
  };
}

async function sessionOf(
  client: PoolClient,
  userId: string,
  now: Date,
  cfg: CasinoConfig,
): Promise<Meta> {
  const gapMs = cfg.limits.sessionGapMinutes * 60_000;
  const r = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM casino_rounds
      WHERE user_id = $1 AND created_at > $2 AND created_at <= $3
      ORDER BY created_at DESC LIMIT 500`,
    [userId, new Date(now.getTime() - DAY_MS), now],
  );
  let last = now.getTime();
  let start: number | null = null;
  for (const row of r.rows) {
    const t = row.created_at.getTime();
    if (last - t > gapMs) break;
    start = t;
    last = t;
  }
  const sessionMinutes = start === null ? 0 : Math.floor((now.getTime() - start) / 60_000);
  return {
    disclaimer: CASINO_DISCLAIMER,
    sessionMinutes,
    sessionReminder: sessionMinutes >= cfg.limits.sessionReminderMinutes,
  };
}

/**
 * Lock the player's casino row (creating it) and return the exclusion date.
 * Every casino action takes this lock first, which serializes a player's
 * bets and keeps the caps race-free.
 */
async function lockPlayer(client: PoolClient, userId: string): Promise<Date | null> {
  await client.query(
    `INSERT INTO casino_players (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const r = await client.query<{ self_excluded_until: Date | null }>(
    `SELECT self_excluded_until FROM casino_players WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return r.rows[0]?.self_excluded_until ?? null;
}

/**
 * The gates in front of every new stake. Throws the contract error for the
 * first rule that fails.
 */
async function gateStake(
  client: PoolClient,
  ctx: AppContext,
  cfg: CasinoConfig,
  userId: string,
  stakeCents: number,
  now: Date,
): Promise<void> {
  checkStakeRange(cfg, stakeCents);
  const excludedUntil = await lockPlayer(client, userId);
  const age = await client.query<{ age_confirmed_at: Date | null }>(
    `SELECT age_confirmed_at FROM characters WHERE user_id = $1`,
    [userId],
  );
  if (age.rows[0]?.age_confirmed_at == null) throw new AgeRequiredError();
  if (excludedUntil !== null && excludedUntil.getTime() > now.getTime()) {
    throw new SelfExcludedError({ until: excludedUntil.toISOString() });
  }
  const used = await dayUsage(client, userId, now);
  const { dailyStakeCapCents, dailyNetLossCapCents } = ctx.config.casino;
  if (used.stakedCents + stakeCents > dailyStakeCapCents) {
    throw new StakeCapReachedError({
      capCents: dailyStakeCapCents,
      stakedCents: used.stakedCents,
      resetsAt: new Date(utcDayStart(now).getTime() + DAY_MS).toISOString(),
    });
  }
  if (used.netLossCents + stakeCents > dailyNetLossCapCents) {
    throw new LossCapReachedError({
      capCents: dailyNetLossCapCents,
      netLossCents: used.netLossCents,
      resetsAt: new Date(utcDayStart(now).getTime() + DAY_MS).toISOString(),
    });
  }
}

/**
 * The gates in front of anything that is not a stake (a Cash-free heads-up challenge): 18+
 * and self-exclusion only. No caps, no Cash.
 */
async function gateAccess(client: PoolClient, userId: string, now: Date): Promise<void> {
  const excludedUntil = await lockPlayer(client, userId);
  const age = await client.query<{ age_confirmed_at: Date | null }>(
    `SELECT age_confirmed_at FROM characters WHERE user_id = $1`,
    [userId],
  );
  if (age.rows[0]?.age_confirmed_at == null) throw new AgeRequiredError();
  if (excludedUntil !== null && excludedUntil.getTime() > now.getTime()) {
    throw new SelfExcludedError({ until: excludedUntil.toISOString() });
  }
}

function checkStakeRange(cfg: CasinoConfig, stakeCents: number): void {
  const { minStakeCents, maxStakeCents } = cfg.limits;
  if (!Number.isInteger(stakeCents) || stakeCents < minStakeCents || stakeCents > maxStakeCents) {
    throw new ValidationFailedError({
      reason: `stakeCents must be an integer ${minStakeCents}..${maxStakeCents}`,
    });
  }
}

// --- Ledger ---------------------------------------------------------------

/** Move Cash and write the ledger row. The balance row must be locked. */
async function post(
  client: PoolClient,
  userId: string,
  deltaCents: number,
  reason: string,
  refType: string,
  refId: string,
  idempotencyRef: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = $3 WHERE user_id = $2`,
    [deltaCents, userId, now],
  );
  await client.query(
    `INSERT INTO ledger_entries
       (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
     VALUES ($1, $2, 'cash', $3, $4, $5, $6, $7)`,
    [userId, deltaCents, reason, refType, refId, idempotencyRef, now],
  );
}

/** Lock the balance row (creating it) and return the Cash held. */
async function lockCash(client: PoolClient, userId: string): Promise<number> {
  await client.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const r = await client.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

/** Debit the stake (the balance row is locked and checked here). */
async function takeStake(
  client: PoolClient,
  userId: string,
  stakeCents: number,
  refType: 'casino_round' | 'casino_challenge',
  refId: string,
  now: Date,
): Promise<void> {
  const cash = await lockCash(client, userId);
  if (cash < stakeCents) {
    throw new InsufficientCashError({ have: String(cash), need: String(stakeCents) });
  }
  await post(
    client,
    userId,
    -stakeCents,
    CASINO_STAKE,
    refType,
    refId,
    `casino-stake:${userId}:${refId}`,
    now,
  );
}

async function payWin(
  client: PoolClient,
  userId: string,
  payoutCents: number,
  refType: 'casino_round' | 'casino_challenge',
  refId: string,
  now: Date,
): Promise<void> {
  if (payoutCents <= 0) return;
  await post(
    client,
    userId,
    payoutCents,
    CASINO_WIN,
    refType,
    refId,
    `casino-win:${userId}:${refId}`,
    now,
  );
}

async function cashOf(client: PoolClient, userId: string): Promise<number> {
  const r = await client.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

async function insertRound(
  client: PoolClient,
  r: {
    roundId: string;
    userId: string;
    game: CasinoGame;
    status: 'open' | 'settled';
    stakeCents: number;
    payoutCents: number | null;
    params: Record<string, unknown>;
    outcome: Record<string, unknown> | null;
    seedHash: string;
    seed: string | null;
    challengeId?: string | null;
  },
  now: Date,
): Promise<RoundView> {
  const res = await client.query<RoundRow>(
    `INSERT INTO casino_rounds
       (round_id, user_id, game, status, stake_cents, payout_cents, params, outcome,
        seed_hash, seed, challenge_id, created_at, settled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${ROUND_COLUMNS}`,
    [
      r.roundId,
      r.userId,
      r.game,
      r.status,
      r.stakeCents,
      r.payoutCents,
      JSON.stringify(r.params),
      r.outcome === null ? null : JSON.stringify(r.outcome),
      r.seedHash,
      r.seed,
      r.challengeId ?? null,
      now,
      r.status === 'settled' ? now : null,
    ],
  );
  return toRound(res.rows[0]!);
}

// --- Slots and coinflip vs the house -------------------------------------

interface InstantResult {
  readonly params: Record<string, unknown>;
  readonly outcome: Record<string, unknown>;
  readonly payoutCents: number;
}

async function playInstant(
  ctx: AppContext,
  userId: string,
  game: 'slots' | 'coinflip',
  stakeCents: number,
  now: Date,
  resolve: (draw: () => number, cfg: CasinoConfig) => InstantResult,
): Promise<BetResult> {
  const cfg = cfgOf(ctx);
  return runInTransaction(
    async (client) => {
      await gateStake(client, ctx, cfg, userId, stakeCents, now);
      const roundId = uuidv7();
      const seed = newSeed();
      const res = resolve(drawStream(seed, `${game}:${roundId}`), cfg);
      await takeStake(client, userId, stakeCents, 'casino_round', roundId, now);
      await payWin(client, userId, res.payoutCents, 'casino_round', roundId, now);
      const round = await insertRound(
        client,
        {
          roundId,
          userId,
          game,
          status: 'settled',
          stakeCents,
          payoutCents: res.payoutCents,
          params: res.params,
          outcome: res.outcome,
          seedHash: hashSeed(seed),
          seed,
        },
        now,
      );
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        round,
        cashCents: await cashOf(client, userId),
      };
    },
    {},
    ctx.db,
  );
}

/**
 * Spin the slots.
 * @param ctx - The app context.
 * @param userId - The player.
 * @param stakeCents - The stake in cents.
 * @param now - The current time (injectable for tests).
 */
export function playSlots(
  ctx: AppContext,
  userId: string,
  stakeCents: number,
  now: Date = new Date(),
): Promise<BetResult> {
  return playInstant(ctx, userId, 'slots', stakeCents, now, (draw, cfg) => {
    const spin = spinSlots(draw, cfg);
    return {
      params: {},
      outcome: {
        reels: spin.reels,
        multiplier: spin.multiplierX100 / 100,
        winSymbol: spin.winSymbol,
        jackpot: spin.jackpot,
      },
      payoutCents: payoutFor(stakeCents, spin.multiplierX100),
    };
  });
}

/**
 * Flip a coin against the house: a win pays `coinflip.payoutMultiplier` x
 * the stake (1.9x, so 95% RTP).
 * @param ctx - The app context.
 * @param userId - The player.
 * @param stakeCents - The stake in cents.
 * @param side - The side the player calls.
 * @param now - The current time (injectable for tests).
 */
export function playCoinflip(
  ctx: AppContext,
  userId: string,
  stakeCents: number,
  side: CoinSide,
  now: Date = new Date(),
): Promise<BetResult> {
  return playInstant(ctx, userId, 'coinflip', stakeCents, now, (draw, cfg) => {
    const result = flipCoin(draw());
    const won = result === side;
    return {
      params: { side },
      outcome: { side, result, won },
      payoutCents: won ? payoutFor(stakeCents, toX100(cfg.coinflip.payoutMultiplier)) : 0,
    };
  });
}

// --- Crash ----------------------------------------------------------------

function crashOutcome(
  s: CrashSettlement,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    crashPoint: s.crashPointX100 / 100,
    cashedOutAt: s.cashedOutX100 === null ? null : s.cashedOutX100 / 100,
    crashed: s.cashedOutX100 === null,
    ...extra,
  };
}

function crashPointOfRow(row: RoundRow, cfg: CasinoConfig): number {
  const u = drawStream(row.seed!, `crash:${row.round_id}`)();
  return crashPointX100(u, cfg);
}

/** Settle an open crash round row (locked by the caller). */
async function settleCrashRow(
  client: PoolClient,
  row: RoundRow,
  s: CrashSettlement,
  now: Date,
): Promise<RoundView> {
  await payWin(client, row.user_id, s.payoutCents, 'casino_round', row.round_id, now);
  const res = await client.query<RoundRow>(
    `UPDATE casino_rounds
        SET status = 'settled', payout_cents = $2, outcome = $3, settled_at = $4
      WHERE round_id = $1 AND status = 'open'
      RETURNING ${ROUND_COLUMNS}`,
    [row.round_id, s.payoutCents, JSON.stringify(crashOutcome(s)), now],
  );
  return toRound(res.rows[0]!);
}

/**
 * Close a player's still-open crash round if its crash point has passed
 * (they never cashed out: a loss). Returns true while one is still running.
 */
async function reapOpenCrash(
  client: PoolClient,
  userId: string,
  cfg: CasinoConfig,
  now: Date,
): Promise<boolean> {
  const open = await client.query<RoundRow>(
    `SELECT ${ROUND_COLUMNS} FROM casino_rounds
      WHERE user_id = $1 AND game = 'crash' AND status = 'open' FOR UPDATE`,
    [userId],
  );
  const row = open.rows[0];
  if (row === undefined) return false;
  const elapsed = now.getTime() - Number(row.params.startedAtMs);
  const crash = crashPointOfRow(row, cfg);
  if (elapsed >= crashTimeMs(crash, cfg)) {
    await settleCrashRow(
      client,
      row,
      { crashPointX100: crash, cashedOutX100: null, payoutCents: 0 },
      now,
    );
    return false;
  }
  return true;
}

/**
 * Place a crash bet. With `autoCashout` the round settles at once (the
 * client animates the reveal). Without it the round stays open until
 * `cashoutCrash` or the crash, whichever the server clock says comes first.
 * @param ctx - The app context.
 * @param userId - The player.
 * @param stakeCents - The stake in cents.
 * @param autoCashout - Target multiplier (e.g. 2.5), or null for manual.
 * @param now - The current time (injectable for tests).
 */
export async function placeCrashBet(
  ctx: AppContext,
  userId: string,
  stakeCents: number,
  autoCashout: number | null,
  now: Date = new Date(),
): Promise<BetResult> {
  const cfg = cfgOf(ctx);
  let autoX100: number | null = null;
  if (autoCashout !== null) {
    autoX100 = Math.round(autoCashout * 100);
    if (
      !Number.isFinite(autoCashout) ||
      Math.abs(autoCashout * 100 - autoX100) > 1e-6 ||
      autoX100 < toX100(cfg.crash.minAutoCashout) ||
      autoX100 > cfg.crash.maxMultiplier * 100
    ) {
      throw new ValidationFailedError({
        reason: `autoCashout must have at most 2 decimals, ${cfg.crash.minAutoCashout}..${cfg.crash.maxMultiplier}`,
      });
    }
  }
  return runInTransaction(
    async (client) => {
      await gateStake(client, ctx, cfg, userId, stakeCents, now);
      if (await reapOpenCrash(client, userId, cfg, now)) {
        throw new RoundInProgressError();
      }
      const roundId = uuidv7();
      const seed = newSeed();
      const crash = crashPointX100(drawStream(seed, `crash:${roundId}`)(), cfg);
      await takeStake(client, userId, stakeCents, 'casino_round', roundId, now);
      let round: RoundView;
      if (autoX100 !== null) {
        const s = settleCrashAuto(stakeCents, autoX100, crash);
        await payWin(client, userId, s.payoutCents, 'casino_round', roundId, now);
        round = await insertRound(
          client,
          {
            roundId,
            userId,
            game: 'crash',
            status: 'settled',
            stakeCents,
            payoutCents: s.payoutCents,
            params: { autoCashout: autoX100 / 100, growthPerSecond: cfg.crash.growthPerSecond },
            outcome: crashOutcome(s, { autoCashout: autoX100 / 100 }),
            seedHash: hashSeed(seed),
            seed,
          },
          now,
        );
      } else {
        round = await insertRound(
          client,
          {
            roundId,
            userId,
            game: 'crash',
            status: 'open',
            stakeCents,
            payoutCents: null,
            params: {
              startedAtMs: now.getTime(),
              growthPerSecond: cfg.crash.growthPerSecond,
              maxMultiplier: cfg.crash.maxMultiplier,
            },
            outcome: null,
            seedHash: hashSeed(seed),
            // Stored, but toRound() hides it until the round has settled.
            seed,
          },
          now,
        );
      }
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        round,
        cashCents: await cashOf(client, userId),
      };
    },
    {},
    ctx.db,
  );
}

/**
 * Cash out of an open crash round. Validity is decided by the server clock
 * alone: if the time since the round started has reached the crash point
 * the round is lost (payout 0, `outcome.crashed: true`), otherwise it pays
 * the server's multiplier at that instant.
 * @param ctx - The app context.
 * @param userId - The player; only the owner can cash out.
 * @param roundId - The crash round.
 * @param now - The current time (injectable for tests).
 */
export async function cashoutCrash(
  ctx: AppContext,
  userId: string,
  roundId: string,
  now: Date = new Date(),
): Promise<BetResult> {
  const cfg = cfgOf(ctx);
  return runInTransaction(
    async (client) => {
      await lockPlayer(client, userId);
      await lockCash(client, userId);
      const r = await client.query<RoundRow>(
        `SELECT ${ROUND_COLUMNS} FROM casino_rounds
        WHERE round_id = $1 AND user_id = $2 AND game = 'crash' FOR UPDATE`,
        [roundId, userId],
      );
      const row = r.rows[0];
      if (row === undefined) throw new NotFoundError();
      if (row.status === 'settled') throw new RoundSettledError({ roundId });
      const crash = crashPointOfRow(row, cfg);
      const elapsed = now.getTime() - Number(row.params.startedAtMs);
      const s = settleCrashManual(Number(row.stake_cents), elapsed, crash, cfg);
      const round = await settleCrashRow(client, row, s, now);
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        round,
        cashCents: await cashOf(client, userId),
      };
    },
    {},
    ctx.db,
  );
}

// --- Head-to-head coinflip ------------------------------------------------

async function loadChallenge(
  client: PoolClient,
  challengeId: string,
  lock: boolean,
): Promise<ChallengeRow | null> {
  const r = await client.query<ChallengeRow>(
    `SELECT ${CHALLENGE_COLUMNS} FROM casino_challenges WHERE challenge_id = $1
     ${lock ? 'FOR UPDATE' : ''}`,
    [challengeId],
  );
  return r.rows[0] ?? null;
}

/** Close the challenge (and return a legacy escrowed stake, if any). */
async function refundChallenge(
  client: PoolClient,
  ch: ChallengeRow,
  status: 'expired' | 'cancelled' | 'declined',
  now: Date,
): Promise<ChallengeRow> {
  // Challenges are Cash-free now (stake 0). A challenge from before that (stake > 0) was
  // refunded by migration 099, so this only closes the row.
  if (Number(ch.stake_cents) > 0) {
    await lockCash(client, ch.challenger_id);
    await post(
      client,
      ch.challenger_id,
      Number(ch.stake_cents),
      CASINO_REFUND,
      'casino_challenge',
      ch.challenge_id,
      `casino-refund:${ch.challenger_id}:${ch.challenge_id}`,
      now,
    );
  }
  const r = await client.query<ChallengeRow>(
    `UPDATE casino_challenges SET status = $2, settled_at = $3
      WHERE challenge_id = $1 RETURNING ${CHALLENGE_COLUMNS}`,
    [ch.challenge_id, status, now],
  );
  return r.rows[0]!;
}

async function viewChallenge(
  client: PoolClient,
  ch: ChallengeRow,
  viewer: string,
): Promise<ChallengeView> {
  return toChallenge(ch, viewer, await aliasMap(client, [ch.challenger_id, ch.opponent_id]));
}

/**
 * Challenge another player to a head-to-head coinflip for BRAGGING RIGHTS. No Cash moves:
 * Cash never goes between players. The challenge has no stake, no escrow and no ledger row;
 * the coin comes from a seed committed at creation. It expires after `challengeTtlSeconds`.
 * Age and self-exclusion still apply; the stake caps do not (there is no stake).
 * @param ctx - The app context.
 * @param userId - The challenger.
 * @param opponentId - The challenged player.
 * @param side - The side the challenger takes.
 * @param now - The current time (injectable for tests).
 */
export async function createChallenge(
  ctx: AppContext,
  userId: string,
  opponentId: string,
  side: CoinSide,
  now: Date = new Date(),
): Promise<Meta & { challenge: ChallengeView; cashCents: number }> {
  const cfg = cfgOf(ctx);
  if (opponentId === userId) throw new ValidationFailedError({ reason: 'cannot challenge self' });
  return runInTransaction(
    async (client) => {
      await gateAccess(client, userId, now);
      const opp = await client.query(`SELECT 1 FROM users WHERE id = $1`, [opponentId]);
      if (opp.rowCount === 0) throw new NotFoundError();
      const blocked = await client.query(
        `SELECT 1 FROM blocks
        WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
           OR (blocker_user_id = $2 AND blocked_user_id = $1)`,
        [userId, opponentId],
      );
      if (blocked.rowCount !== 0) throw new BlockedError();
      const open = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM casino_challenges
        WHERE challenger_id = $1 AND status = 'open' AND expires_at > $2`,
        [userId, now],
      );
      if (Number(open.rows[0]!.n) >= MAX_OPEN_CHALLENGES) {
        throw new ValidationFailedError({
          reason: `at most ${MAX_OPEN_CHALLENGES} open challenges`,
        });
      }
      const challengeId = uuidv7();
      const seed = newSeed();
      const r = await client.query<ChallengeRow>(
        `INSERT INTO casino_challenges
         (challenge_id, challenger_id, opponent_id, stake_cents, challenger_side,
          seed, seed_hash, created_at, expires_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8)
       RETURNING ${CHALLENGE_COLUMNS}`,
        [
          challengeId,
          userId,
          opponentId,
          side,
          seed,
          hashSeed(seed),
          now,
          new Date(now.getTime() + cfg.coinflip.challengeTtlSeconds * 1000),
        ],
      );
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        challenge: await viewChallenge(client, r.rows[0]!, userId),
        cashCents: await cashOf(client, userId),
      };
    },
    {},
    ctx.db,
  );
}

type AcceptOutcome =
  | { kind: 'settled'; value: Meta & { challenge: ChallengeView; cashCents: number } }
  | { kind: 'expired' };

/**
 * Accept a challenge (the challenged player only). Flips the coin from the challenge's
 * committed seed and records the winner. NO Cash moves and no `casino_rounds` row is written.
 * An expired challenge is closed and answers `CHALLENGE_EXPIRED`.
 * @param ctx - The app context.
 * @param userId - The challenged player.
 * @param challengeId - The challenge.
 * @param now - The current time (injectable for tests).
 */
export async function acceptChallenge(
  ctx: AppContext,
  userId: string,
  challengeId: string,
  now: Date = new Date(),
): Promise<Meta & { challenge: ChallengeView; cashCents: number }> {
  const cfg = cfgOf(ctx);
  const out = await runInTransaction<AcceptOutcome>(
    async (client) => {
      await lockPlayer(client, userId);
      const peek = await loadChallenge(client, challengeId, false);
      // Only the two participants may even learn that a challenge exists.
      if (peek === null || (peek.opponent_id !== userId && peek.challenger_id !== userId)) {
        throw new NotFoundError();
      }
      if (peek.opponent_id !== userId)
        throw new ForbiddenError({ reason: 'only the opponent accepts' });
      const ch = (await loadChallenge(client, challengeId, true))!;
      if (ch.status === 'expired') throw new ChallengeExpiredError({ challengeId });
      if (ch.status !== 'open') throw new ChallengeNotOpenError({ challengeId, status: ch.status });
      if (now.getTime() >= ch.expires_at.getTime()) {
        await refundChallenge(client, ch, 'expired', now);
        return { kind: 'expired' };
      }
      await gateAccess(client, userId, now);

      const result = flipCoin(drawStream(ch.seed, `coinflip_h2h:${challengeId}`)());
      const winnerId = result === ch.challenger_side ? ch.challenger_id : ch.opponent_id;
      const upd = await client.query<ChallengeRow>(
        `UPDATE casino_challenges
          SET status = 'settled', result = $2, winner_id = $3, settled_at = $4
        WHERE challenge_id = $1 RETURNING ${CHALLENGE_COLUMNS}`,
        [challengeId, result, winnerId, now],
      );
      return {
        kind: 'settled',
        value: {
          ...(await sessionOf(client, userId, now, cfg)),
          challenge: await viewChallenge(client, upd.rows[0]!, userId),
          cashCents: await cashOf(client, userId),
        },
      };
    },
    {},
    ctx.db,
  );
  if (out.kind === 'expired') throw new ChallengeExpiredError({ challengeId });
  return out.value;
}

/**
 * Close an open challenge early: the challenger cancels, or the opponent
 * declines. Nothing moves. A challenge that already ran
 * past its expiry is closed as `expired` instead.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param challengeId - The challenge.
 * @param as - `cancel` (challenger) or `decline` (opponent).
 * @param now - The current time (injectable for tests).
 */
export async function closeChallenge(
  ctx: AppContext,
  userId: string,
  challengeId: string,
  as: 'cancel' | 'decline',
  now: Date = new Date(),
): Promise<Meta & { challenge: ChallengeView; cashCents: number }> {
  const cfg = cfgOf(ctx);
  return runInTransaction(
    async (client) => {
      await lockPlayer(client, userId);
      const peek = await loadChallenge(client, challengeId, false);
      if (peek === null || (peek.opponent_id !== userId && peek.challenger_id !== userId)) {
        throw new NotFoundError();
      }
      const allowed = as === 'cancel' ? peek.challenger_id === userId : peek.opponent_id === userId;
      if (!allowed)
        throw new ForbiddenError({
          reason: `only the ${as === 'cancel' ? 'challenger' : 'opponent'} can ${as}`,
        });
      const ch = (await loadChallenge(client, challengeId, true))!;
      if (ch.status !== 'open') throw new ChallengeNotOpenError({ challengeId, status: ch.status });
      const status =
        now.getTime() >= ch.expires_at.getTime()
          ? 'expired'
          : as === 'cancel'
            ? 'cancelled'
            : 'declined';
      const closed = await refundChallenge(client, ch, status, now);
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        challenge: await viewChallenge(client, closed, userId),
        cashCents: await cashOf(client, userId),
      };
    },
    {},
    ctx.db,
  );
}

/**
 * Refund every open challenge past its expiry (and, with `settleCrash`,
 * close crash rounds nobody cashed out of). Run by the worker once a
 * minute; also called for one player before they list their challenges.
 * @param ctx - The app context.
 * @param now - The current time (injectable for tests).
 * @param onlyUserId - Restrict to challenges this player takes part in.
 * @returns How many challenges were expired and crash rounds closed.
 */
export async function sweepCasino(
  ctx: AppContext,
  now: Date = new Date(),
  onlyUserId: string | null = null,
): Promise<{ challenges: number; crashRounds: number }> {
  const cfg = cfgOf(ctx);
  const due = await ctx.db.withConnection((c) =>
    c.query<{ challenge_id: string }>(
      `SELECT challenge_id FROM casino_challenges
        WHERE status = 'open' AND expires_at <= $1
          AND ($2::uuid IS NULL OR challenger_id = $2 OR opponent_id = $2)
        ORDER BY expires_at ASC LIMIT 200`,
      [now, onlyUserId],
    ),
  );
  let challenges = 0;
  for (const { challenge_id } of due.rows) {
    await runInTransaction(
      async (client) => {
        const ch = await loadChallenge(client, challenge_id, true);
        if (ch === null || ch.status !== 'open') return;
        await lockPlayer(client, ch.challenger_id);
        await refundChallenge(client, ch, 'expired', now);
        challenges += 1;
      },
      {},
      ctx.db,
    );
  }
  const stale = await ctx.db.withConnection((c) =>
    c.query<{ user_id: string }>(
      `SELECT user_id FROM casino_rounds
        WHERE game = 'crash' AND status = 'open' AND created_at <= $1
          AND ($2::uuid IS NULL OR user_id = $2)
        LIMIT 200`,
      // Even a 100x round is over by then: ln(100) / 0.07 is about 66 s.
      [new Date(now.getTime() - 5 * 60_000), onlyUserId],
    ),
  );
  let crashRounds = 0;
  for (const { user_id } of stale.rows) {
    await runInTransaction(
      async (client) => {
        await lockPlayer(client, user_id);
        await lockCash(client, user_id);
        if (!(await reapOpenCrash(client, user_id, cfg, now))) crashRounds += 1;
      },
      {},
      ctx.db,
    );
  }
  return { challenges, crashRounds };
}

/**
 * The caller's challenges, newest first, both incoming and outgoing.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 */
export async function listChallenges(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<Meta & { challenges: ChallengeView[] }> {
  const cfg = cfgOf(ctx);
  await sweepCasino(ctx, now, userId);
  return ctx.db.withConnection(async (client) => {
    const r = await client.query<ChallengeRow>(
      `SELECT ${CHALLENGE_COLUMNS} FROM casino_challenges
        WHERE challenger_id = $1 OR opponent_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    const ids = [...new Set(r.rows.flatMap((c) => [c.challenger_id, c.opponent_id]))];
    const aliases = await aliasMap(client, ids);
    return {
      ...(await sessionOf(client, userId, now, cfg)),
      challenges: r.rows.map((c) => toChallenge(c, userId, aliases)),
    };
  });
}

// --- Rounds, state, self-exclusion ---------------------------------------

/**
 * Settle the caller's own open crash round if the server clock is past its
 * crash point (a loss), so reads show the rug at the real crash point instead
 * of waiting for the 5 minute sweep. Locks player, cash and round rows in the
 * same order as the sweep and cashout, so it cannot double-settle.
 */
async function settleOwnCrashedRound(ctx: AppContext, userId: string, now: Date): Promise<void> {
  const cfg = cfgOf(ctx);
  const has = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM casino_rounds WHERE user_id = $1 AND game = 'crash' AND status = 'open' LIMIT 1`,
      [userId],
    ),
  );
  if ((has.rowCount ?? 0) === 0) return;
  await runInTransaction(
    async (client) => {
      await lockPlayer(client, userId);
      await lockCash(client, userId);
      await reapOpenCrash(client, userId, cfg, now);
    },
    {},
    ctx.db,
  );
}

/**
 * The caller's own rounds, newest first. There is no way to list anyone
 * else's rounds.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param opts - Page size and the `createdAt` of the last row seen.
 * @param now - The current time (injectable for tests).
 */
export async function listMyRounds(
  ctx: AppContext,
  userId: string,
  opts: { limit: number; before: Date | null },
  now: Date = new Date(),
): Promise<Meta & { rounds: RoundView[] }> {
  const cfg = cfgOf(ctx);
  await sweepCasino(ctx, now, userId);
  await settleOwnCrashedRound(ctx, userId, now);
  return ctx.db.withConnection(async (client) => {
    const r = await client.query<RoundRow>(
      `SELECT ${ROUND_COLUMNS} FROM casino_rounds
        WHERE user_id = $1 AND ($3::timestamptz IS NULL OR created_at < $3)
        ORDER BY created_at DESC, round_id DESC LIMIT $2`,
      [userId, opts.limit, opts.before],
    );
    return { ...(await sessionOf(client, userId, now, cfg)), rounds: r.rows.map(toRound) };
  });
}

/**
 * One of the caller's rounds. Someone else's round is a 404.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param roundId - The round.
 * @param now - The current time (injectable for tests).
 */
export async function getMyRound(
  ctx: AppContext,
  userId: string,
  roundId: string,
  now: Date = new Date(),
): Promise<Meta & { round: RoundView }> {
  const cfg = cfgOf(ctx);
  await sweepCasino(ctx, now, userId);
  await settleOwnCrashedRound(ctx, userId, now);
  return ctx.db.withConnection(async (client) => {
    const r = await client.query<RoundRow>(
      `SELECT ${ROUND_COLUMNS} FROM casino_rounds WHERE round_id = $1 AND user_id = $2`,
      [roundId, userId],
    );
    if (r.rows[0] === undefined) throw new NotFoundError();
    return { ...(await sessionOf(client, userId, now, cfg)), round: toRound(r.rows[0]) };
  });
}

export interface CasinoState extends Meta {
  readonly ageConfirmed: boolean;
  readonly selfExcludedUntil: string | null;
  readonly limits: {
    readonly minStakeCents: number;
    readonly maxStakeCents: number;
    readonly dailyStakeCapCents: number;
    readonly dailyNetLossCapCents: number;
  };
  readonly today: {
    readonly stakedCents: number;
    readonly netLossCents: number;
    readonly stakeRemainingCents: number;
    readonly lossRemainingCents: number;
    readonly resetsAt: string;
  };
  readonly games: {
    readonly slots: {
      readonly reelWeights: CasinoConfig['slots']['reelWeights'];
      readonly paytable: CasinoConfig['slots']['paytable'];
      readonly rtp: number;
      readonly hitRate: number;
    };
    readonly crash: {
      readonly growthPerSecond: number;
      readonly maxMultiplier: number;
      readonly minAutoCashout: number;
      readonly rtp: number;
    };
    readonly coinflip: {
      readonly payoutMultiplier: number;
      readonly rtp: number;
      readonly h2hHouseCutBps: number;
      readonly challengeTtlSeconds: number;
    };
  };
}

/**
 * Everything the Rug Room UI needs before a bet: the age and exclusion
 * state, the caps and what is left of them today, and the paytables.
 * Readable by players who have not confirmed 18+ (so the UI can show the
 * gate); it places no bet.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 */
export async function getCasinoState(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<CasinoState> {
  const cfg = cfgOf(ctx);
  const { dailyStakeCapCents, dailyNetLossCapCents } = ctx.config.casino;
  return ctx.db.withConnection(async (client) => {
    const age = await client.query<{ age_confirmed_at: Date | null }>(
      `SELECT age_confirmed_at FROM characters WHERE user_id = $1`,
      [userId],
    );
    const ex = await client.query<{ self_excluded_until: Date | null }>(
      `SELECT self_excluded_until FROM casino_players WHERE user_id = $1`,
      [userId],
    );
    const until = ex.rows[0]?.self_excluded_until ?? null;
    const used = await dayUsage(client, userId, now);
    const stats = slotsStats(cfg);
    return {
      ...(await sessionOf(client, userId, now, cfg)),
      ageConfirmed: age.rows[0]?.age_confirmed_at != null,
      selfExcludedUntil:
        until !== null && until.getTime() > now.getTime() ? until.toISOString() : null,
      limits: {
        minStakeCents: cfg.limits.minStakeCents,
        maxStakeCents: cfg.limits.maxStakeCents,
        dailyStakeCapCents,
        dailyNetLossCapCents,
      },
      today: {
        stakedCents: used.stakedCents,
        netLossCents: used.netLossCents,
        stakeRemainingCents: Math.max(0, dailyStakeCapCents - used.stakedCents),
        lossRemainingCents: Math.max(0, dailyNetLossCapCents - used.netLossCents),
        resetsAt: new Date(utcDayStart(now).getTime() + DAY_MS).toISOString(),
      },
      games: {
        slots: {
          reelWeights: cfg.slots.reelWeights,
          paytable: cfg.slots.paytable,
          rtp: stats.rtp,
          hitRate: stats.hitRate,
        },
        crash: {
          growthPerSecond: cfg.crash.growthPerSecond,
          maxMultiplier: cfg.crash.maxMultiplier,
          minAutoCashout: cfg.crash.minAutoCashout,
          rtp: cfg.crash.targetRtp,
        },
        coinflip: {
          payoutMultiplier: cfg.coinflip.payoutMultiplier,
          rtp: cfg.coinflip.payoutMultiplier / 2,
          h2hHouseCutBps: cfg.coinflip.h2hHouseCutBps,
          challengeTtlSeconds: cfg.coinflip.challengeTtlSeconds,
        },
      },
    };
  });
}

/**
 * Exclude the caller from the casino for `days` days. It can be extended
 * but not shortened or lifted before it ends; that is the point of it.
 * New stakes are refused (`SELF_EXCLUDED`); an open crash round can still
 * be cashed out and a pending challenge refunded.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param days - Whole days.
 * @param now - The current time (injectable for tests).
 */
export async function selfExclude(
  ctx: AppContext,
  userId: string,
  days: number,
  now: Date = new Date(),
): Promise<Meta & { selfExcludedUntil: string }> {
  const cfg = cfgOf(ctx);
  const { minSelfExcludeDays, maxSelfExcludeDays } = cfg.limits;
  if (!Number.isInteger(days) || days < minSelfExcludeDays || days > maxSelfExcludeDays) {
    throw new ValidationFailedError({
      reason: `days must be an integer ${minSelfExcludeDays}..${maxSelfExcludeDays}`,
    });
  }
  return runInTransaction(
    async (client) => {
      const current = await lockPlayer(client, userId);
      const wanted = now.getTime() + days * DAY_MS;
      const until = new Date(Math.max(wanted, current?.getTime() ?? 0));
      await client.query(
        `UPDATE casino_players SET self_excluded_until = $2, updated_at = $3 WHERE user_id = $1`,
        [userId, until, now],
      );
      return {
        ...(await sessionOf(client, userId, now, cfg)),
        selfExcludedUntil: until.toISOString(),
      };
    },
    {},
    ctx.db,
  );
}
