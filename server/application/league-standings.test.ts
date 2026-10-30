/**
 * District standings (live today, same capped formula as the rollover, my
 * contribution hidden for anon) and season results (latest finished season,
 * promoted / relegated / stayed, final rank by end-of-season net worth, ledger
 * rewards). Uses dates far from today so other suites' rows never interfere.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { ensureDistricts } from './tribes.js';
import { ensureLeagues } from './leagues.js';
import {
  getDistrictStandings,
  standingsDay,
  MAX_POSTS_PER_PLAYER_PER_DAY,
} from './district-standings.js';
import { getSeasonResults, seasonOutcome } from './season-results.js';
import { dayToRoll } from '../workers/district-rollover.js';

_resetConfigForTests();
_resetContextForTests();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const created: string[] = [];

async function newPlayer(tribe: string): Promise<string> {
  const id = uuidv7();
  created.push(id);
  await pool.query(`INSERT INTO users (id, wallet, lottery_rolled_at) VALUES ($1, $2, now())`, [
    id,
    `wpa2-${id}`,
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', $4, '{a,b}', 'make_10k', now(), 'studio')`,
    [uuidv7(), id, `w2_${id.slice(-10)}`, tribe],
  );
  return id;
}

async function post(userId: string, district: string, at: Date, kind = 'player'): Promise<void> {
  await pool.query(
    `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, district_slug)
     VALUES ($1, $2, 'gm', $3, $4, $5)`,
    [uuidv7(), userId, at.toISOString(), kind, district],
  );
}

beforeAll(async () => {
  await ensureDistricts(ctx);
  await ensureLeagues(ctx);
});

afterAll(async () => {
  await pool.query(`DELETE FROM feed_posts WHERE user_id = ANY($1::uuid[])`, [created]);
  await pool.query(`DELETE FROM season_memberships WHERE user_id = ANY($1::uuid[])`, [created]);
  await pool.query(`DELETE FROM characters WHERE user_id = ANY($1::uuid[])`, [created]);
  await pool.end();
});

describe('district standings', () => {
  // A UTC day no other suite writes posts on.
  const now = new Date('2031-03-05T15:00:00.000Z');
  const at = (min: number): Date => new Date(Date.parse('2031-03-05T00:00:00.000Z') + min * 60_000);

  it('scores today live with the per-player cap and shows my contribution', async () => {
    const district = (
      await pool.query<{ district_id: string; slug: string; base: number; holder: string }>(
        `SELECT district_id, slug, base_score_per_day AS base, default_holder_tribe_id AS holder
         FROM districts WHERE slug = 'the_trenches'`,
      )
    ).rows[0]!;
    const me = await newPlayer('perp_degen');
    const spammer = await newPlayer('perp_degen');
    const other = await newPlayer('degen_trader');
    for (let i = 0; i < 2; i++) await post(me, district.slug, at(10 + i));
    for (let i = 0; i < 20; i++) await post(spammer, district.slug, at(20 + i));
    await post(other, district.slug, at(30));
    // Not counted: yesterday, tomorrow, another district, a server-written post kind.
    await post(other, district.slug, at(-5));
    await post(other, district.slug, at(24 * 60 + 1));
    await post(other, 'airdrop_farm', at(40));
    await post(other, district.slug, at(41), 'career');

    const s = await getDistrictStandings(ctx, me, district.district_id, now);
    expect(s.districtId).toBe(district.district_id);
    expect(s.dayDate).toBe('2031-03-05');
    expect(s.rolloverAt).toBe('2031-03-06T00:05:00.000Z');
    expect(s.myTribeId).toBe('perp_degen');
    expect(s.myContribution).toBe(2);
    const score = (t: string): number | undefined =>
      s.standings.find((r) => r.tribeId === t)?.score;
    expect(score('perp_degen')).toBe(2 + MAX_POSTS_PER_PLAYER_PER_DAY);
    expect(score('degen_trader')).toBe(1);
    expect(score(district.holder)).toBe(
      district.base +
        (district.holder === 'perp_degen' ? 5 : district.holder === 'degen_trader' ? 1 : 0),
    );
    const scores = s.standings.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('hides the contribution of an anon player, and 404s an unknown district', async () => {
    const anon = await newPlayer('anon');
    await post(anon, 'the_trenches', at(50));
    const ds = (
      await pool.query<{ district_id: string }>(
        `SELECT district_id FROM districts WHERE slug = 'the_trenches'`,
      )
    ).rows[0]!;
    const s = await getDistrictStandings(ctx, anon, ds.district_id, now);
    expect(s.myTribeId).toBe('anon');
    expect(s.myContribution).toBeNull();
    await expect(getDistrictStandings(ctx, anon, 'no_such_district', now)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rolls over at 00:05 the next UTC day, and the 00:05 job rolls the day that ended', () => {
    expect(standingsDay(new Date('2031-12-31T23:59:00Z')).rolloverAt).toBe(
      '2032-01-01T00:05:00.000Z',
    );
    expect(dayToRoll(new Date('2031-03-06T00:05:00Z'))).toBe('2031-03-05');
    expect(dayToRoll(new Date('2032-01-01T00:05:00Z'))).toBe('2031-12-31');
  });
});

describe('season results', () => {
  const now = new Date('2001-03-28T12:00:00Z'); // current season 2001-W13
  async function member(
    user: string,
    season: string,
    league: string,
    rank: number,
    nw: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO season_memberships (membership_id, user_id, season_iso, league_id, net_worth_cents, rank)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), user, season, league, nw, rank],
    );
  }

  it('reports the latest finished season with outcome and end-of-season rank', async () => {
    const me = await newPlayer('trencher');
    const a = await newPlayer('trencher');
    const b = await newPlayer('trencher');
    // 2001-W11: all three in silver. 2001-W12 (the next rollover): me promoted to gold
    // with the most net worth, a stays, b relegated.
    await member(me, '2001-W11', 'silver', 3, 1_100_000);
    await member(a, '2001-W11', 'silver', 1, 1_500_000);
    await member(b, '2001-W11', 'silver', 2, 1_200_000);
    await member(me, '2001-W12', 'gold', 1, 12_000_000);
    await member(a, '2001-W12', 'silver', 1, 2_000_000);
    await member(b, '2001-W12', 'bronze', 1, 500_000);
    // The current season row is never "finished".
    await member(me, '2001-W13', 'gold', 1, 12_000_000);

    const r = await getSeasonResults(ctx, me, '2001-W11', now);
    expect(r).toEqual({
      seasonId: '2001-W11',
      leagueId: 'silver',
      finalRank: 1,
      outcome: 'promoted',
      toLeagueId: 'gold',
      rewards: [],
    });
    expect((await getSeasonResults(ctx, b, '2001-W11', now)).outcome).toBe('relegated');
    expect(await getSeasonResults(ctx, a, '2001-W11', now)).toMatchObject({
      outcome: 'stayed',
      toLeagueId: null,
      finalRank: 2,
    });
    // No seasonId: the latest finished one (W12), with no later row yet -> stayed, start rank.
    expect(await getSeasonResults(ctx, me, undefined, now)).toMatchObject({
      seasonId: '2001-W12',
      leagueId: 'gold',
      outcome: 'stayed',
      finalRank: 1,
    });
  });

  it('404s an unfinished or missing season and 400s a malformed id', async () => {
    const me = await newPlayer('trencher');
    await expect(getSeasonResults(ctx, me, undefined, now)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSeasonResults(ctx, me, '2001-W13', now)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSeasonResults(ctx, me, 's1', now)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('reads cash rewards from the ledger', async () => {
    const me = await newPlayer('trencher');
    await member(me, '2001-W11', 'iron', 1, 0);
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
                      ON CONFLICT (user_id) DO NOTHING`,
      [me],
    );
    await pool.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id)
       VALUES ($1, 50000, 'cash', 'season_reward', 'season', '2001-W11')`,
      [me],
    );
    const r = await getSeasonResults(ctx, me, '2001-W11', now);
    expect(r.rewards).toEqual([{ kind: 'cash', cashCents: 50000, itemId: null, badgeId: null }]);
  });

  it('decides the outcome from the contract tier order', () => {
    const tiers = new Map([
      ['iron', 0],
      ['bronze', 1],
      ['silver', 2],
    ]);
    expect(seasonOutcome('bronze', 'silver', tiers)).toEqual({
      outcome: 'promoted',
      toLeagueId: 'silver',
    });
    expect(seasonOutcome('bronze', 'iron', tiers)).toEqual({
      outcome: 'relegated',
      toLeagueId: 'iron',
    });
    expect(seasonOutcome('bronze', null, tiers)).toEqual({ outcome: 'stayed', toLeagueId: null });
  });
});
