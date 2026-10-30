/**
 * Game-rolled Sybil jail (unlock A5): attempt counting and tiers, the roll
 * only while sybilBail is on, SYBIL_JAILED on claims, lazy release, bail (a
 * ledger sink, once per stay, INSUFFICIENT_CASH, not_jailed, admin
 * not_bailable), the Barn board (count of all, aliases of game stays only,
 * anon hidden) and the venue gate.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ConflictError, InsufficientCashError, SybilJailedError } from '../shared/domain/errors.js';
import {
  bailCentsFor,
  getSybilBarn,
  getSybilStatus,
  isSybilJailed,
  paySybilBail,
  rollSybilJail,
  sybilConfig,
  tierFor,
} from './sybil-jail.js';
import { claimAirdrop, setSybilJailed } from './airdrop-farm.js';
import { getVenueAccess } from './venues-gating.js';

const savedCaps = process.env.CAPABILITIES_ON;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const always = (): number => 0; // roll 0 < any chanceBps > 0: jail
const never = (): number => 9_999;

function ctxWith(caps: string): ReturnType<typeof buildContext> {
  process.env.CAPABILITIES_ON = caps;
  _resetConfigForTests();
  _resetContextForTests();
  return buildContext();
}

async function newPlayer(tribe = 'airdrop_farmer', cash = 0): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `wpa5-${id}`]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', $4, '{a,b}', 'make_10k', now(), 'studio')`,
    [uuidv7(), id, `w5_${id.slice(-10)}`, tribe],
  );
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)`, [
    id,
    cash,
  ]);
  return id;
}

beforeEach(async () => {
  const ctx = buildContext();
  const keys = await ctx.redis.main.keys('sybil:claims:*');
  if (keys.length) await ctx.redis.main.del(...keys);
});

afterAll(async () => {
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
});

describe('sybil tiers and bail price', () => {
  it('picks the highest tier reached and prices bail per started hour, clamped', () => {
    const cfg = sybilConfig(buildContext());
    expect(tierFor(cfg, 1)).toBeNull();
    expect(tierFor(cfg, 5)?.reasonId).toBe('sybil_claim_spam');
    expect(tierFor(cfg, 12)?.reasonId).toBe('sybil_bot_pattern');
    expect(tierFor(cfg, 99)?.reasonId).toBe('sybil_clone_farm');
    const now = new Date('2031-01-01T00:00:00Z');
    const in90m = new Date(now.getTime() + 90 * 60_000);
    expect(bailCentsFor(cfg, 575, in90m, now)).toBe(1150); // 2 started hours x $5.75
    expect(bailCentsFor(cfg, 1, in90m, now)).toBe(cfg.minBailCents);
    expect(bailCentsFor(cfg, 100_000, in90m, now)).toBe(cfg.maxBailCents);
  });
});

describe('game-rolled jail on claims', () => {
  it('never rolls while sybilBail is off', async () => {
    const ctx = ctxWith('');
    const u = await newPlayer();
    for (let i = 0; i < 25; i++) await claimAirdrop(ctx, u, new Date(), always);
    expect((await getSybilStatus(ctx, u)).jailed).toBe(false);
  });

  it('jails on the attempt that reaches a tier and refuses claims until release', async () => {
    const ctx = ctxWith('sybilBail');
    const u = await newPlayer();
    const now = new Date();
    for (let i = 0; i < 4; i++) await claimAirdrop(ctx, u, now, always);
    await expect(claimAirdrop(ctx, u, now, always)).rejects.toBeInstanceOf(SybilJailedError);
    const s = await getSybilStatus(ctx, u, now);
    expect(s).toMatchObject({
      jailed: true,
      reasonId: 'sybil_claim_spam',
      bailable: true,
      source: 'game',
    });
    expect(Date.parse(s.releaseAt!) - now.getTime()).toBe(120 * 60_000);
    // 2 h left x the farmer's $5.75 yield.
    expect(s.bailCents).toBe(1150);
    await expect(claimAirdrop(ctx, u, now, never)).rejects.toMatchObject({
      code: 'SYBIL_JAILED',
      details: { releaseAt: s.releaseAt, reasonId: 'sybil_claim_spam' },
    });
    // Lazy release: after release_at the stay no longer counts.
    const later = new Date(Date.parse(s.releaseAt!) + 1000);
    expect((await getSybilStatus(ctx, u, later)).jailed).toBe(false);
    expect(await isSybilJailed(pool, u, later)).toBe(false);
  });

  it('does not jail below the threshold or when the roll misses', async () => {
    const ctx = ctxWith('sybilBail');
    const u = await newPlayer();
    for (let i = 0; i < 9; i++) await claimAirdrop(ctx, u, new Date(), never);
    expect((await getSybilStatus(ctx, u)).jailed).toBe(false);
    expect(await rollSybilJail(ctx, u, 500, new Date(), never)).toBeNull();
  });
});

describe('bail', () => {
  it('debits Cash once to the house (ledger sybil_bail) and frees the player', async () => {
    const ctx = ctxWith('sybilBail');
    const u = await newPlayer('degen_trader', 5_000);
    const now = new Date();
    for (let i = 0; i < 5; i++) await rollSybilJail(ctx, u, 500, now, always);
    const s = await getSybilStatus(ctx, u, now);
    expect(s.bailCents).toBe(1000);
    const out = await paySybilBail(ctx, u, now);
    expect(out).toMatchObject({ jailed: false, bailable: false, source: null });
    const cash = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [u],
    );
    expect(Number(cash.rows[0]!.cash_cents)).toBe(4_000);
    const led = await pool.query<{ delta_cents: string; reason: string }>(
      `SELECT delta_cents, reason FROM ledger_entries WHERE user_id = $1`,
      [u],
    );
    expect(led.rows).toEqual([{ delta_cents: '-1000', reason: 'sybil_bail' }]);
    await expect(paySybilBail(ctx, u, now)).rejects.toMatchObject({
      details: { reason: 'not_jailed' },
    });
  });

  it('refuses without enough Cash, and never bails an admin jail', async () => {
    const ctx = ctxWith('sybilBail');
    const poor = await newPlayer('degen_trader', 10);
    for (let i = 0; i < 5; i++) await rollSybilJail(ctx, poor, 500, new Date(), always);
    await expect(paySybilBail(ctx, poor)).rejects.toBeInstanceOf(InsufficientCashError);
    const admin = await newPlayer('degen_trader', 1_000_000);
    await setSybilJailed(ctx, admin);
    expect(await getSybilStatus(ctx, admin)).toMatchObject({
      jailed: true,
      bailable: false,
      source: 'admin',
      releaseAt: null,
      bailCents: null,
      reasonId: 'sybil_admin_review',
    });
    await expect(paySybilBail(ctx, admin)).rejects.toBeInstanceOf(ConflictError);
    await expect(paySybilBail(ctx, admin)).rejects.toMatchObject({
      details: { reason: 'not_bailable' },
    });
  });
});

describe('the Barn', () => {
  it('counts everyone jailed, lists game stays by alias, hides anon, opens the venue', async () => {
    const ctx = ctxWith('sybilBail');
    const now = new Date();
    const game = await newPlayer('degen_trader');
    const anon = await newPlayer('anon');
    const admin = await newPlayer('degen_trader');
    for (let i = 0; i < 5; i++) await rollSybilJail(ctx, game, 500, now, always);
    for (let i = 0; i < 5; i++) await rollSybilJail(ctx, anon, 500, now, always);
    await setSybilJailed(ctx, admin);
    const barn = await getSybilBarn(ctx, now);
    const ids = barn.inmates.map((i) => i.userId);
    expect(ids).toContain(game);
    expect(ids).not.toContain(anon);
    expect(ids).not.toContain(admin);
    expect(barn.count).toBeGreaterThanOrEqual(3);
    expect(barn.inmates.length).toBeLessThanOrEqual(50);
    const row = barn.inmates.find((i) => i.userId === game)!;
    expect(row.alias).toBe(`w5_${game.slice(-10)}`);
    expect(row.reasonId).toBe('sybil_claim_spam');
    expect((await getVenueAccess(ctx, game, 'sybil_barn')).allowed).toBe(true);
    const free = await newPlayer('degen_trader');
    expect((await getVenueAccess(ctx, free, 'sybil_barn')).allowed).toBe(false);
  });
});
