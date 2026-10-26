/**
 * Server analytics (migration 098): the event writer, its privacy guard,
 * the instrumented actions and the daily rollup views.
 *
 * View tests write to a random far-future UTC day, so reruns against the
 * same database never see each other's rows.
 */
import { Keypair } from '@solana/web3.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  _setAnalyticsEnabledForTests,
  ANALYTICS_EVENT_NAMES,
  pruneAnalyticsEvents,
  recordEvent,
  safeProps,
} from './analytics.js';
import { AuthService } from './auth.js';
import { claimDaily } from './daily-streak.js';
import { sendCashTip, tipFeeCents } from './tips.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

async function newUser(cashCents = 0): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `analytics-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)`, [id, cashCents]);
  return id;
}

async function eventsOf(
  userId: string,
): Promise<{ name: string; props: Record<string, unknown>; amount_cents: string | null }[]> {
  const r = await pool.query(
    `SELECT name, props, amount_cents FROM analytics_events WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return r.rows;
}

/** A random UTC day between 2200 and 2700. */
function farDay(): Date {
  const d = new Date(Date.UTC(2200, 0, 1) + Math.floor(Math.random() * 500 * 365) * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

beforeEach(() => _setAnalyticsEnabledForTests(true));
afterEach(() => _setAnalyticsEnabledForTests(null));
afterAll(async () => {
  await pool.end();
});

describe('privacy guard', () => {
  it('accepts numbers, booleans and catalogue ids', () => {
    expect(safeProps({ questId: 'q_daily_shift_1', n: 3, ok: true })).toEqual({
      questId: 'q_daily_shift_1',
      n: 3,
      ok: true,
    });
  });

  it('refuses free text, wallet addresses and other strings that could carry PII', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(() => safeProps({ wallet })).toThrow();
    expect(() => safeProps({ alias: 'Vitalik Fan 99' })).toThrow();
    expect(() => safeProps({ email: 'a@b.co' })).toThrow();
    expect(() => safeProps({ nested: { a: 1 } })).toThrow();
    expect(() => safeProps({ n: Number.NaN })).toThrow();
  });

  it('the TS registry matches the CHECK constraint in the migration', async () => {
    const r = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'analytics_events'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%name%'`,
    );
    const def = r.rows.map((x) => x.def).join(' ');
    for (const name of ANALYTICS_EVENT_NAMES) expect(def).toContain(`'${name}'`);
    expect(def.match(/'[a-z_]+'/g)?.length).toBe(ANALYTICS_EVENT_NAMES.length);
  });
});

describe('recordEvent', () => {
  it('writes one row with the user id, props and amount', async () => {
    const u = await newUser();
    await recordEvent(pool, u, {
      name: 'shop_order',
      props: { lines: 2, units: 3 },
      amountCents: 4200,
    });
    expect(await eventsOf(u)).toEqual([
      { name: 'shop_order', props: { lines: 2, units: 3 }, amount_cents: '4200' },
    ]);
  });

  it('writes nothing when analytics is off', async () => {
    const u = await newUser();
    _setAnalyticsEnabledForTests(false);
    await recordEvent(pool, u, { name: 'session_start', props: { method: 'dev' } });
    expect(await eventsOf(u)).toEqual([]);
  });

  it('events go with the user (erasure)', async () => {
    const u = await newUser();
    await recordEvent(pool, u, { name: 'session_start', props: { method: 'dev' } });
    await pool.query(`DELETE FROM balances WHERE user_id = $1`, [u]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [u]);
    expect(await eventsOf(u)).toEqual([]);
  });

  it('prunes events past the retention window', async () => {
    const u = await newUser();
    await recordEvent(
      pool,
      u,
      { name: 'session_start', props: { method: 'dev' } },
      new Date(Date.UTC(2001, 0, 1)),
    );
    await recordEvent(pool, u, { name: 'session_start', props: { method: 'dev' } });
    expect(await pruneAnalyticsEvents(ctx.db, 180)).toBeGreaterThanOrEqual(1);
    expect((await eventsOf(u)).length).toBe(1);
  });
});

describe('instrumented actions', () => {
  it('dev sign-in records signup once, and session_start on every sign-in', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const auth = new AuthService(ctx);
    const first = await auth.devAuthenticate(wallet);
    await auth.devAuthenticate(wallet);
    const names = (await eventsOf(first.id)).map((e) => e.name);
    expect(names).toEqual(['signup', 'session_start', 'session_start']);
    const props = (await eventsOf(first.id))[0]!.props;
    expect(props).toEqual({ method: 'dev', seeker: false });
    expect(JSON.stringify(await eventsOf(first.id))).not.toContain(wallet);
  });

  it('a daily claim records daily_claimed with the Cash paid; a repeat claim records nothing', async () => {
    const u = await newUser();
    const at = farDay();
    const a = await claimDaily(ctx, u, at);
    await claimDaily(ctx, u, at);
    const ev = await eventsOf(u);
    expect(ev).toEqual([
      {
        name: 'daily_claimed',
        props: { streakDay: 1, reset: false },
        amount_cents: String(a.claimed.rewards.cashCents),
      },
    ]);
  });

  it('a Cash tip records tip_sent on the sender only, with the burned fee', async () => {
    const from = await newUser(10_000);
    const to = await newUser();
    await sendCashTip(ctx, from, to, 1_000, 'gm');
    const ev = await eventsOf(from);
    expect(ev.length).toBe(1);
    expect(ev[0]!.name).toBe('tip_sent');
    expect(ev[0]!.amount_cents).toBe('1000');
    expect(ev[0]!.props.feeCents).toBe(tipFeeCents(1_000, ctx.config.tips.feeBps));
    expect(await eventsOf(to)).toEqual([]);
    // The message text is never recorded.
    expect(JSON.stringify(ev)).not.toContain('gm');
  });
});

describe('daily rollup views', () => {
  it('economy totals split faucets, sinks and player-to-player transfers', async () => {
    const day = farDay();
    const a = await newUser();
    const b = await newUser();
    const rows: [string, number, string][] = [
      [a, 1_000, 'daily_streak'], // faucet
      [a, -500, 'shop_order'], // sink
      [a, -97, 'tip_out'], // transfer out
      [a, -3, 'tip_fee_burn'], // sink (the burned fee)
      [b, 97, 'tip'], // transfer in
    ];
    for (const [u, delta, reason] of rows) {
      await pool.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, created_at)
         VALUES ($1, $2, 'cash', $3, $4)`,
        [u, delta, reason, day],
      );
    }
    const t = await pool.query(
      `SELECT faucet_cents, sink_cents, net_supply_change_cents, transferred_cents
         FROM analytics_economy_totals_daily WHERE day = $1`,
      [dayKey(day)],
    );
    expect(t.rows[0]).toEqual({
      faucet_cents: '1000',
      sink_cents: '503',
      net_supply_change_cents: '497',
      transferred_cents: '97',
    });
    const byReason = await pool.query(
      `SELECT reason, inflow_cents, outflow_cents, users FROM analytics_economy_daily
        WHERE day = $1 AND account = 'cash' ORDER BY reason`,
      [dayKey(day)],
    );
    expect(byReason.rows.find((r) => r.reason === 'tip_fee_burn')).toMatchObject({
      inflow_cents: '0',
      outflow_cents: '3',
      users: '1',
    });
  });

  it('the funnel counts first-session beats within 24 h and D1 returns per signup cohort', async () => {
    const day = farDay();
    const h = (n: number): Date => new Date(day.getTime() + n * 3_600_000);
    const u1 = await newUser();
    const u2 = await newUser();
    await recordEvent(pool, u1, { name: 'signup', props: { method: 'dev', seeker: false } }, h(0));
    await recordEvent(
      pool,
      u1,
      { name: 'lottery_rolled', props: { outcome: 'insider' }, amountCents: 1 },
      h(0),
    );
    await recordEvent(
      pool,
      u1,
      { name: 'character_created', props: { tribeId: 'trencher', likeness: false } },
      h(1),
    );
    await recordEvent(pool, u1, { name: 'session_start', props: { method: 'dev' } }, h(24));
    await recordEvent(pool, u2, { name: 'signup', props: { method: 'dev', seeker: false } }, h(2));
    // A character made two days later is not a first-session beat.
    await recordEvent(
      pool,
      u2,
      { name: 'character_created', props: { tribeId: 'trencher', likeness: false } },
      h(50),
    );
    const r = await pool.query(
      `SELECT signups, lottery_24h, character_24h, returned_d1, returned_d7
         FROM analytics_funnel_daily WHERE cohort_day = $1`,
      [dayKey(day)],
    );
    expect(r.rows[0]).toEqual({
      signups: '2',
      lottery_24h: '1',
      character_24h: '1',
      returned_d1: '1',
      returned_d7: '0',
    });
    const d = await pool.query(
      `SELECT events, users FROM analytics_daily WHERE day = $1 AND name = 'signup'`,
      [dayKey(day)],
    );
    expect(d.rows[0]).toEqual({ events: '2', users: '2' });
  });
});
