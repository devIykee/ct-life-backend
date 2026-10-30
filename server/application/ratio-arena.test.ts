/**
 * CT Beef, stake-free (unlock A6): open / accept / decline / cancel rules,
 * the phase machine (expired, voting, closed), hidden tallies, spectator vote
 * eligibility, the arena crowd from in-arena activity, Elo (including draws
 * and the per-pair daily cap), the capped house reward, the admin override,
 * old staked matches refunded to their owners, and the Cash invariant: a
 * loser's Cash never moves.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  AlreadyVotedError,
  BlockedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SybilJailedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  acceptMatch,
  cancelMatch,
  declineMatch,
  getElo,
  getMatch,
  listMatches,
  openMatch,
} from './ratio-arena.js';
import { advanceBeefPhases, settleMatch } from './beef-close.js';
import { castVote } from './beef-votes.js';
import { recordArenaActivity } from './beef-activity.js';
import { activityScore, beefConfig, crowdSplit, eloAfter } from './beef-rules.js';
import { setSybilJailed } from './airdrop-farm.js';
import { subscribeUserMessages, type UserMessage } from './realtime-bus.js';

_resetConfigForTests();
_resetContextForTests();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const cfg = beefConfig(ctx);
const TOPIC = 'beef_perps_vs_spot';
const S = 1000;
let sub: Redis;
const msgs: UserMessage[] = [];

async function player(
  opts: { ageHours?: number; level?: number; cash?: number } = {},
): Promise<string> {
  const id = uuidv7();
  const created = new Date(Date.now() - (opts.ageHours ?? 48) * 3_600_000);
  await pool.query(`INSERT INTO users (id, wallet, created_at) VALUES ($1, $2, $3)`, [
    id,
    `wpa6-${id}`,
    created.toISOString(),
  ]);
  await pool.query(`INSERT INTO skills (user_id, clout) VALUES ($1, $2)`, [id, opts.level ?? 3]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)`, [
    id,
    opts.cash ?? 0,
  ]);
  return id;
}

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

async function ledger(userId: string): Promise<Array<{ reason: string; delta: number }>> {
  const r = await pool.query<{ reason: string; delta_cents: string }>(
    `SELECT reason, delta_cents FROM ledger_entries WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return r.rows.map((x) => ({ reason: x.reason, delta: Number(x.delta_cents) }));
}

/** Open and accept at `t0`; returns ids and the voting / close instants. */
async function live(t0: Date): Promise<{ id: string; a: string; b: string }> {
  const a = await player();
  const b = await player();
  const m = await openMatch(ctx, a, { topicId: TOPIC }, t0);
  await acceptMatch(ctx, b, m.matchId, t0);
  return { id: m.matchId, a, b };
}

const at = (t0: Date, sec: number): Date => new Date(t0.getTime() + sec * S);
const toVoting = (t0: Date): Date => at(t0, cfg.phases.activeSeconds + 1);
const toClose = (t0: Date): Date => at(t0, cfg.phases.activeSeconds + cfg.phases.votingSeconds + 2);

beforeAll(async () => {
  sub = subscribeUserMessages(ctx.redis.main, (m) => {
    if (m.type.startsWith('beef_')) msgs.push(m);
  });
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  await sub.quit();
  await pool.end();
});

describe('beef rules (pure)', () => {
  it('splits the crowd by activity, leftover to the busier side, nothing when idle', () => {
    expect(crowdSplit(5, 0, 0)).toEqual({ challenger: 0, accepter: 0 });
    expect(crowdSplit(5, 10, 0)).toEqual({ challenger: 5, accepter: 0 });
    expect(crowdSplit(5, 30, 20)).toEqual({ challenger: 3, accepter: 2 });
    expect(crowdSplit(5, 10, 10)).toEqual({ challenger: 2, accepter: 2 });
    expect(crowdSplit(5, 1, 99)).toEqual({ challenger: 0, accepter: 5 });
  });

  it('caps the activity score and moves Elo symmetrically', () => {
    expect(activityScore(cfg, { talkSeconds: 10, emotes: 2, says: 1 })).toBe(10 + 6 + 2);
    expect(activityScore(cfg, { talkSeconds: 99_999, emotes: 0, says: 0 })).toBe(
      cfg.crowd.maxScorePerParticipant,
    );
    const won = eloAfter(1500, 1500, 1, 32);
    expect(won).toEqual({ challenger: 1516, accepter: 1484 });
    expect(eloAfter(1500, 1500, 0.5, 32)).toEqual({ challenger: 1500, accepter: 1500 });
  });
});

describe('open, accept, decline, cancel', () => {
  it('opens stake-free with the reward and refuses stakes and unknown topics', async () => {
    const a = await player();
    const m = await openMatch(ctx, a, { topicId: TOPIC, stakeCents: 0 });
    expect(m).toMatchObject({
      status: 'open',
      stakeCents: 0,
      feeBps: 0,
      rewardCents: cfg.reward.winnerCents,
      topicId: TOPIC,
      invitedUserId: null,
      votes: null,
      crowdVotes: null,
    });
    expect(Date.parse(m.phaseEndsAt!) - Date.parse(m.openedAt)).toBe(cfg.phases.openSeconds * S);
    await expect(openMatch(ctx, a, { topicId: TOPIC, stakeCents: 500 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'stakes_disabled' },
    });
    await expect(openMatch(ctx, a, { topicId: 'free text' })).rejects.toMatchObject({
      details: { reason: 'unknown_topic' },
    });
    expect(await ledger(a)).toEqual([]);
  });

  it('aims a challenge at one player, who alone may accept or decline it', async () => {
    const a = await player();
    const b = await player();
    const c = await player();
    msgs.length = 0;
    const m = await openMatch(ctx, a, { topicId: TOPIC, invitedUserId: b });
    expect(m.invitedUserId).toBe(b);
    await new Promise((r) => setTimeout(r, 150));
    const rung = msgs.find((x) => x.type === 'beef_challenge' && x.userId === b);
    expect(rung?.payload).toMatchObject({
      matchId: m.matchId,
      fromUserId: a,
      topicId: TOPIC,
      stakeCents: 0,
    });
    expect(msgs.some((x) => x.type === 'beef_update' && x.userId === '*')).toBe(true);
    await expect(acceptMatch(ctx, c, m.matchId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(declineMatch(ctx, c, m.matchId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(declineMatch(ctx, a, m.matchId)).rejects.toBeInstanceOf(ForbiddenError);
    const d = await declineMatch(ctx, b, m.matchId);
    expect(d.status).toBe('declined');
    await expect(acceptMatch(ctx, b, m.matchId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses self, unknown, blocked and jailed players, and caps open challenges', async () => {
    const a = await player();
    const blocked = await player();
    await expect(openMatch(ctx, a, { topicId: TOPIC, invitedUserId: a })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      openMatch(ctx, a, { topicId: TOPIC, invitedUserId: uuidv7() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      blocked,
      a,
    ]);
    await expect(
      openMatch(ctx, a, { topicId: TOPIC, invitedUserId: blocked }),
    ).rejects.toBeInstanceOf(BlockedError);
    for (let i = 0; i < cfg.limits.maxOpenPerChallenger; i++) {
      await openMatch(ctx, a, { topicId: TOPIC });
    }
    await expect(openMatch(ctx, a, { topicId: TOPIC })).rejects.toMatchObject({
      details: { reason: 'too_many_open' },
    });
    const jailed = await player();
    await setSybilJailed(ctx, jailed);
    await expect(openMatch(ctx, jailed, { topicId: TOPIC })).rejects.toBeInstanceOf(
      SybilJailedError,
    );
  });

  it('accept: not your own, not after it expired, not while in another live match', async () => {
    const t0 = new Date();
    const a = await player();
    const b = await player();
    const m = await openMatch(ctx, a, { topicId: TOPIC }, t0);
    await expect(acceptMatch(ctx, a, m.matchId, t0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      acceptMatch(ctx, b, m.matchId, at(t0, cfg.phases.openSeconds + 1)),
    ).rejects.toMatchObject({ details: { reason: 'not_open' } });
    const ok = await acceptMatch(ctx, b, m.matchId, t0);
    expect(ok).toMatchObject({ status: 'active', accepterUserId: b, eloChallengerPre: 1500 });
    expect(Date.parse(ok.phaseEndsAt!) - t0.getTime()).toBe(cfg.phases.activeSeconds * S);
    const other = await openMatch(ctx, await player(), { topicId: TOPIC }, t0);
    await expect(acceptMatch(ctx, b, other.matchId, t0)).rejects.toMatchObject({
      details: { reason: 'in_match' },
    });
  });

  it('cancel: the challenger only, while open', async () => {
    const a = await player();
    const b = await player();
    const m = await openMatch(ctx, a, { topicId: TOPIC });
    await expect(cancelMatch(ctx, b, m.matchId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await cancelMatch(ctx, a, m.matchId)).status).toBe('cancelled');
    await expect(cancelMatch(ctx, a, m.matchId)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('phases, votes and the result', () => {
  it('an open challenge nobody takes expires', async () => {
    const t0 = new Date();
    const m = await openMatch(ctx, await player(), { topicId: TOPIC }, t0);
    await advanceBeefPhases(ctx, at(t0, cfg.phases.openSeconds + 1));
    expect((await getMatch(ctx, m.challengerUserId, m.matchId)).status).toBe('expired');
  });

  it('voting: eligibility, one vote each, hidden tally, the winner gets the capped reward', async () => {
    const t0 = new Date();
    const { id, a, b } = await live(t0);
    const voter = await player();
    await expect(castVote(ctx, voter, id, a, t0)).rejects.toMatchObject({
      details: { reason: 'not_voting' },
    });
    await advanceBeefPhases(ctx, toVoting(t0));
    const tv = toVoting(t0);
    expect((await getMatch(ctx, a, id)).status).toBe('voting');
    await expect(castVote(ctx, a, id, a, tv)).rejects.toMatchObject({
      code: 'VOTE_NOT_ALLOWED',
      details: { reason: 'participant' },
    });
    await expect(castVote(ctx, await player({ ageHours: 1 }), id, a, tv)).rejects.toMatchObject({
      details: { reason: 'too_new' },
    });
    await expect(castVote(ctx, await player({ level: 1 }), id, a, tv)).rejects.toMatchObject({
      details: { reason: 'level' },
    });
    const jailed = await player();
    await setSybilJailed(ctx, jailed);
    await expect(castVote(ctx, jailed, id, a, tv)).rejects.toBeInstanceOf(SybilJailedError);
    await expect(castVote(ctx, voter, id, uuidv7(), tv)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    const receipt = await castVote(ctx, voter, id, b, tv);
    expect(receipt).toMatchObject({ matchId: id, votedUserId: b });
    await expect(castVote(ctx, voter, id, a, tv)).rejects.toBeInstanceOf(AlreadyVotedError);
    const mid = await getMatch(ctx, voter, id);
    expect(mid.votes).toBeNull();
    expect(mid.myVote).toBe(b);
    await expect(castVote(ctx, await player(), id, a, toClose(t0))).rejects.toMatchObject({
      details: { reason: 'not_voting' },
    });

    msgs.length = 0;
    const bBefore = await cash(b);
    const aBefore = await cash(a);
    await advanceBeefPhases(ctx, toClose(t0));
    const done = await getMatch(ctx, voter, id);
    expect(done).toMatchObject({
      status: 'closed',
      winnerUserId: b,
      votes: { challenger: 0, accepter: 1, total: 1 },
      crowdVotes: { challenger: 0, accepter: 0 },
      rewardPaidCents: cfg.reward.winnerCents,
      eloChallengerPost: 1484,
      eloAccepterPost: 1516,
    });
    // Cash never moves between players: the loser is untouched, the winner is paid by the house.
    expect(await cash(a)).toBe(aBefore);
    expect(await cash(b)).toBe(bBefore + cfg.reward.winnerCents);
    expect(await ledger(a)).toEqual([]);
    expect(await ledger(b)).toEqual([{ reason: 'beef_reward', delta: cfg.reward.winnerCents }]);
    await new Promise((r) => setTimeout(r, 150));
    const result = msgs.find((x) => x.type === 'beef_result');
    expect(result?.payload).toMatchObject({
      matchId: id,
      winnerUserId: b,
      votesAccepter: 1,
      payoutCents: cfg.reward.winnerCents,
      eloDeltaAccepter: 16,
    });
    expect((await getElo(ctx, b)).wins).toBe(1);
  });

  it('the arena crowd follows in-arena activity and can decide a match', async () => {
    const t0 = new Date();
    const { id, a, b } = await live(t0);
    await recordArenaActivity(ctx.redis.main, a, 'talk', 30);
    await recordArenaActivity(ctx.redis.main, a, 'emote', 2);
    await recordArenaActivity(ctx.redis.main, b, 'say', 1);
    await advanceBeefPhases(ctx, toVoting(t0));
    const pres = await pool.query(
      `SELECT user_id, talk_seconds, emotes, says FROM beef_presence WHERE match_id = $1 ORDER BY user_id`,
      [id],
    );
    expect(pres.rows).toHaveLength(2);
    await advanceBeefPhases(ctx, toClose(t0));
    const done = await getMatch(ctx, a, id);
    // a: 30 + 2x3 = 36, b: 2 -> 4.73 / 0.26 of 5 -> 4 + leftover 1 to a, 0.
    expect(done.crowdVotes).toEqual({ challenger: 5, accepter: 0 });
    expect(done.winnerUserId).toBe(a);
  });

  it('no votes and no activity is a draw: Elo as a draw, no reward', async () => {
    const t0 = new Date();
    const { id, a, b } = await live(t0);
    await advanceBeefPhases(ctx, toVoting(t0));
    await advanceBeefPhases(ctx, toClose(t0));
    const done = await getMatch(ctx, a, id);
    expect(done).toMatchObject({ status: 'closed', winnerUserId: null, rewardPaidCents: 0 });
    expect((await getElo(ctx, a)).draws).toBe(1);
    expect(await ledger(a)).toEqual([]);
    expect(await ledger(b)).toEqual([]);
  });

  it('caps rewards per pair per day and skips young accounts; Elo stops after the pair cap', async () => {
    const t0 = new Date();
    const a = await player();
    const b = await player();
    const settleOnce = async (): Promise<string> => {
      const m = await openMatch(ctx, a, { topicId: TOPIC }, t0);
      await acceptMatch(ctx, b, m.matchId, t0);
      return (await settleMatch(ctx, m.matchId, a, t0)).matchId;
    };
    const first = await getMatch(ctx, a, await settleOnce());
    expect(first.rewardPaidCents).toBe(cfg.reward.winnerCents);
    const second = await getMatch(ctx, a, await settleOnce());
    expect(second.rewardPaidCents).toBe(0); // one rewarded win per pair per day
    await settleOnce();
    const fourth = await getMatch(ctx, a, await settleOnce());
    // Past maxRatedMatchesPerPairPerDay the rating no longer moves.
    expect(fourth.eloChallengerPost).toBe(fourth.eloChallengerPre);
    expect(await ledger(b)).toEqual([]);

    const young = await player({ ageHours: 1 });
    const c = await player();
    const m = await openMatch(ctx, young, { topicId: TOPIC }, t0);
    await acceptMatch(ctx, c, m.matchId, t0);
    expect((await settleMatch(ctx, m.matchId, young, t0)).rewardPaidCents).toBe(0);
  });

  it('caps rewarded wins per player per day', async () => {
    const t0 = new Date();
    const a = await player();
    for (let i = 0; i < cfg.reward.maxRewardedWinsPerDay + 1; i++) {
      const m = await openMatch(ctx, a, { topicId: TOPIC }, t0);
      await acceptMatch(ctx, await player(), m.matchId, t0);
      await settleMatch(ctx, m.matchId, a, t0);
    }
    const paid = (await ledger(a)).filter((l) => l.reason === 'beef_reward');
    expect(paid).toHaveLength(cfg.reward.maxRewardedWinsPerDay);
  });

  it('admin settle needs an active or voting match and a participant', async () => {
    const t0 = new Date();
    const m = await openMatch(ctx, await player(), { topicId: TOPIC }, t0);
    await expect(settleMatch(ctx, m.matchId, m.challengerUserId, t0)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const { id } = await live(t0);
    await expect(settleMatch(ctx, id, uuidv7(), t0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(settleMatch(ctx, uuidv7(), uuidv7(), t0)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an old staked match gives each stake back to its owner', async () => {
    const t0 = new Date();
    const a = await player({ cash: 0 });
    const b = await player({ cash: 0 });
    const id = uuidv7();
    await pool.query(
      `INSERT INTO beef_matches (match_id, challenger_user_id, accepter_user_id, stake_cents, status,
                                 elo_challenger_pre, elo_accepter_pre, phase_ends_at, opened_at, accepted_at)
       VALUES ($1, $2, $3, 700, 'active', 1500, 1500, $4, $4, $4)`,
      [id, a, b, t0.toISOString()],
    );
    await settleMatch(ctx, id, a, t0);
    expect((await ledger(b)).filter((l) => l.reason === 'beef_stake_refund')).toEqual([
      { reason: 'beef_stake_refund', delta: 700 },
    ]);
    expect((await ledger(a)).filter((l) => l.reason === 'beef_stake_refund')).toEqual([
      { reason: 'beef_stake_refund', delta: 700 },
    ]);
  });
});

describe('listing', () => {
  it('scopes mine (including invites), open and arena, and pages with a cursor', async () => {
    const t0 = new Date();
    const me = await player();
    const other = await player();
    const aimed = await openMatch(ctx, other, { topicId: TOPIC, invitedUserId: me }, t0);
    const mine = await openMatch(ctx, me, { topicId: TOPIC }, t0);
    const page = await listMatches(ctx, me, 'mine', null, 10, null, t0);
    const ids = page.matches.map((x) => x.matchId);
    expect(ids).toEqual(expect.arrayContaining([aimed.matchId, mine.matchId]));
    const open = await listMatches(ctx, me, 'open', null, 100, null, t0);
    expect(open.matches.map((x) => x.matchId)).toContain(aimed.matchId);
    expect(open.matches.map((x) => x.matchId)).not.toContain(mine.matchId);
    const p1 = await listMatches(ctx, me, 'mine', null, 1, null, t0);
    expect(p1.matches).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listMatches(ctx, me, 'mine', null, 1, p1.nextCursor, t0);
    expect(p2.matches[0]!.matchId).not.toBe(p1.matches[0]!.matchId);
    await expect(listMatches(ctx, me, 'all', null, 1, 'garbage', t0)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});
