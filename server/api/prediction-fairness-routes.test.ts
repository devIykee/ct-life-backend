/**
 * Prediction Pit verification over HTTP: every GET /v1/predictions row
 * carries its market's `fairness {commitment, seed}` (seed only once the
 * market is resolved or void; null for crypto markets), and
 * GET /v1/predictions/markets/{marketId} returns one market of any status
 * (404 unknown, 503 while `predict` is off).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { commitmentOf, drawOutcome } from '../application/prediction-markets.js';

let api: TestApi;
const markets: string[] = [];
const players: string[] = [];
const db = (): ReturnType<typeof createDb> => createDb();
const OUTCOMES =
  '[{"outcomeId":"yes","labelKey":"predict.outcome.yes"},{"outcomeId":"no","labelKey":"predict.outcome.no"}]';

/** An open market taking bets; sealed (with a secret) unless `crypto`. */
async function openMarket(kind: 'sim' | 'crypto', seed: string): Promise<string> {
  const id = `test:${uuidv7()}`;
  markets.push(id);
  const commitment = commitmentOf(seed);
  const sealed = kind === 'sim';
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO prediction_markets
         (market_id, kind, question_key, params, outcomes, horizon, opens_at, closes_at, resolves_at,
          source, payout_bps, min_stake_cents, max_stake_cents, basis)
       VALUES ($1, $2, $3, $4, $5, '5m', now() - interval '10 seconds', now() + interval '60 seconds',
               now() + interval '4 minutes', $6, 19000, 100, 50000, $7)`,
      [
        id,
        kind,
        sealed ? 'sim_call' : 'crypto_higher_24h',
        JSON.stringify(sealed ? { ticker: 'TEST', commitment } : { symbol: 'BTCUSDT' }),
        OUTCOMES,
        JSON.stringify(
          sealed ? { type: 'sim', ref: 'sealed_draw' } : { type: 'binance', ref: 'x' },
        ),
        JSON.stringify(sealed ? { seed, commitment } : { symbol: 'BTCUSDT' }),
      ],
    ),
  );
  return id;
}

async function resolve(id: string, outcome: string): Promise<void> {
  await db().withConnection((c) =>
    c.query(
      `UPDATE prediction_markets SET status = 'resolved', resolved_outcome_id = $2, resolved_at = now()
        WHERE market_id = $1`,
      [id, outcome],
    ),
  );
}

async function adult(): Promise<TestPlayer> {
  const p = await api.player();
  players.push(p.sub);
  await db().withConnection(async (c) => {
    await c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', '{}', 'dream', 'parents_basement', now())
       ON CONFLICT (user_id) DO UPDATE SET age_confirmed_at = now()`,
      [uuidv7(), p.sub, `fair_${p.sub.slice(-12)}`],
    );
    await c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [p.sub],
    );
  });
  return p;
}

const marketUrl = (id: string): string => `/v1/predictions/markets/${encodeURIComponent(id)}`;
type Row = Record<string, unknown>;

describe('prediction fairness', () => {
  beforeAll(async () => {
    api = await bootApi('predict', { LIVE_PHASE: '6' });
  }, 30_000);
  afterAll(async () => {
    await db().withConnection(async (c) => {
      await c.query(`DELETE FROM predictions WHERE user_id = ANY($1::uuid[])`, [players]);
      await c.query(`DELETE FROM prediction_markets WHERE market_id = ANY($1::text[])`, [markets]);
    });
    await api.stop();
  }, 30_000);

  it('history rows show the commitment, and the seed only once resolved', async () => {
    const seed = 'ab'.repeat(32);
    const commitment = commitmentOf(seed);
    const sealed = await openMarket('sim', seed);
    const crypto = await openMarket('crypto', 'ef'.repeat(32));
    const p = await adult();
    for (const id of [sealed, crypto]) {
      const r = await api.call(p, 'POST', `${marketUrl(id)}/bets`, {
        outcomeId: 'yes',
        stakeCents: 100,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const rowOf = async (id: string): Promise<Row | undefined> =>
      ((await api.call(p, 'GET', '/v1/predictions')).body as unknown as Row[]).find(
        (x) => x.marketId === id,
      );

    expect((await rowOf(sealed))?.fairness).toEqual({ commitment, seed: null });
    expect((await rowOf(crypto))?.fairness).toBeNull();
    const open = await api.call(p, 'GET', '/v1/predictions');
    expect(JSON.stringify(open.body)).not.toContain(seed);

    const outcome = drawOutcome(seed, sealed);
    await resolve(sealed, outcome);
    const row = await rowOf(sealed);
    expect(row).toMatchObject({ resolvedOutcomeId: outcome, fairness: { commitment, seed } });
    // What the client's Verify sheet does with it.
    const f = row!.fairness as { commitment: string; seed: string };
    expect(commitmentOf(f.seed)).toBe(f.commitment);
    expect(drawOutcome(f.seed, sealed)).toBe(row!.resolvedOutcomeId);
  });

  it('GET /predictions/markets/{marketId} returns one market of any status', async () => {
    const seed = 'cd'.repeat(32);
    const id = await openMarket('sim', seed);
    const p = await api.player();
    const open = await api.call(p, 'GET', marketUrl(id));
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({
      marketId: id,
      kind: 'sim',
      questionKey: 'sim_call',
      status: 'open',
      resolvedOutcomeId: null,
      fairness: { commitment: commitmentOf(seed), seed: null },
    });
    expect(JSON.stringify(open.body)).not.toContain(seed);

    await resolve(id, drawOutcome(seed, id));
    const done = await api.call(p, 'GET', marketUrl(id));
    expect(done.body).toMatchObject({ status: 'resolved', fairness: { seed } });

    const missing = await api.call(p, 'GET', marketUrl('test:nope'));
    expect(missing.status).toBe(404);
    expect(errCode(missing)).toBe('NOT_FOUND');
    expect((await api.call(null, 'GET', marketUrl(id))).status).toBe(401);
  });
});

describe('prediction market gate', () => {
  it('answers 503 CAPABILITY_OFF on one market while predict is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      const r = await off.call(p, 'GET', marketUrl('test:x'));
      expect(r.status).toBe(503);
      expect(errDetails(r)).toEqual({ capability: 'predict' });
    } finally {
      await off.stop();
    }
  });
});
