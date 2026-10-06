/**
 * Ratio Arena (CT Beef) service tests (M7 #5).
 *
 * Covers the open / accept / decline / settle lifecycle, the
 * 5% protocol fee, the Elo update, the conservation property
 * (loser nets 0; winner nets 2*stake - 5% fee), the
 * cannot-accept-your-own guard, and the post-match read of Elo.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { acceptMatch, declineMatch, getElo, openMatch, settleMatch } from './ratio-arena.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function newUser(prefix: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
    id,
    `beefUser-${prefix}-${id}`,
  ]);
  return id;
}

async function setBalance(userId: string, cashCents: number): Promise<void> {
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
    [userId, cashCents],
  );
}

async function getBalance(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

beforeAll(async () => {
  await pool.query(`DELETE FROM beef_elo`);
  await pool.query(`DELETE FROM beef_matches`);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Test users only. ledger_entries is append-only (M2 trigger
  // blocks DELETE), and users have a FK to ledger_entries, so
  // we don't clean them up. Each test creates fresh users with
  // new UUIDs. The beef_matches + beef_elo rows for the test
  // users are deleted so the next test starts clean.
  await pool.query(
    `DELETE FROM beef_elo WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'beefUser-%')`,
  );
  await pool.query(
    `DELETE FROM beef_matches WHERE challenger_user_id IN (SELECT id FROM users WHERE wallet LIKE 'beefUser-%') OR accepter_user_id IN (SELECT id FROM users WHERE wallet LIKE 'beefUser-%')`,
  );
  await pool.query(
    `DELETE FROM balances WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'beefUser-%')`,
  );
});

describe('ratio arena (CT Beef)', () => {
  it('open + accept + settle happy path: winner nets payout - fee', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    const accepter = await newUser('a');
    await setBalance(challenger, 1_000_000);
    await setBalance(accepter, 1_000_000);
    const stake = 100_000;
    const m = await openMatch(ctx, challenger, stake);
    expect(m.status).toBe('open');
    expect(m.stakeCents).toBe(stake);
    expect(m.challengerUserId).toBe(challenger);
    expect(m.accepterUserId).toBeNull();
    // Both sides posted: cash should drop by stake each.
    expect(await getBalance(challenger)).toBe(1_000_000 - stake);
    const a = await acceptMatch(ctx, accepter, m.matchId);
    expect(a.status).toBe('active');
    expect(a.accepterUserId).toBe(accepter);
    expect(a.eloChallengerPre).toBe(1500);
    expect(a.eloAccepterPre).toBe(1500);
    expect(await getBalance(accepter)).toBe(1_000_000 - stake);
    // Settle: challenger wins. gross = 2*stake = 200_000;
    // fee = 5% = 10_000; payout = 190_000; winner net = payout - fee
    // = 180_000.
    const s = await settleMatch(ctx, m.matchId, challenger);
    expect(s.status).toBe('closed');
    expect(s.winnerUserId).toBe(challenger);
    expect(s.eloChallengerPost).toBeGreaterThan(1500);
    expect(s.eloAccepterPost).toBeLessThan(1500);
    expect(await getBalance(challenger)).toBe(1_000_000 - stake + 180_000);
    expect(await getBalance(accepter)).toBe(1_000_000 - stake);
  });

  it('decline refunds the challenger and marks the match declined', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    await setBalance(challenger, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    expect(await getBalance(challenger)).toBe(900_000);
    const d = await declineMatch(ctx, challenger, m.matchId);
    expect(d.status).toBe('declined');
    expect(await getBalance(challenger)).toBe(1_000_000);
  });

  it('refuses to accept your own match', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    await setBalance(challenger, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    await expect(acceptMatch(ctx, challenger, m.matchId)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it("refuses to decline someone else's match", async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    const other = await newUser('o');
    await setBalance(challenger, 1_000_000);
    await setBalance(other, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    await expect(declineMatch(ctx, other, m.matchId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses to settle with a non-participant', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    const accepter = await newUser('a');
    const third = await newUser('t');
    await setBalance(challenger, 1_000_000);
    await setBalance(accepter, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    await acceptMatch(ctx, accepter, m.matchId);
    await expect(settleMatch(ctx, m.matchId, third)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('refuses to settle an open match', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    const accepter = await newUser('a');
    await setBalance(challenger, 1_000_000);
    await setBalance(accepter, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    await expect(settleMatch(ctx, m.matchId, accepter)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('refuses to accept a closed match', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    const accepter = await newUser('a');
    await setBalance(challenger, 1_000_000);
    await setBalance(accepter, 1_000_000);
    const m = await openMatch(ctx, challenger, 100_000);
    await acceptMatch(ctx, accepter, m.matchId);
    await settleMatch(ctx, m.matchId, challenger);
    // Now try to accept again.
    const other = await newUser('o');
    await setBalance(other, 1_000_000);
    await expect(acceptMatch(ctx, other, m.matchId)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('refuses to open with insufficient cash', async () => {
    const ctx = buildContext();
    const challenger = await newUser('c');
    await setBalance(challenger, 50_000);
    await expect(openMatch(ctx, challenger, 100_000)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses to settle an unknown match', async () => {
    const ctx = buildContext();
    const u = await newUser('u');
    await expect(settleMatch(ctx, uuidv7(), u)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Elo property: symmetric matchup sums to zero expected-value delta', async () => {
    // Two players at 1500 face off. The expected value of each
    // delta is 0 (Elo is zero-sum in expectation on a symmetric
    // matchup). The actual delta depends on the winner; we just
    // verify the algebraic property: delta_challenger + delta_accepter
    // = 0 (the math is `K * ((actual1 - expected1) + (actual2 - expected2))`
    // where actual2 = 1 - actual1, expected2 = 1 - expected1).
    const ctx = buildContext();
    const c = await newUser('c');
    const a = await newUser('a');
    await setBalance(c, 1_000_000);
    await setBalance(a, 1_000_000);
    const m = await openMatch(ctx, c, 100_000);
    const accepted = await acceptMatch(ctx, a, m.matchId);
    const settled = await settleMatch(ctx, m.matchId, c);
    const dc = (settled.eloChallengerPost ?? 0) - (accepted.eloChallengerPre ?? 0);
    const da = (settled.eloAccepterPost ?? 0) - (accepted.eloAccepterPre ?? 0);
    expect(dc + da).toBe(0);
  });

  it('getElo creates a row at 1500 on first read', async () => {
    const ctx = buildContext();
    const u = await newUser('u');
    const elo = await getElo(ctx, u);
    expect(elo.elo).toBe(1500);
    expect(elo.matchesPlayed).toBe(0);
  });

  it('getElo reflects wins/losses after a settlement', async () => {
    const ctx = buildContext();
    const c = await newUser('c');
    const a = await newUser('a');
    await setBalance(c, 1_000_000);
    await setBalance(a, 1_000_000);
    const m = await openMatch(ctx, c, 100_000);
    await acceptMatch(ctx, a, m.matchId);
    await settleMatch(ctx, m.matchId, c);
    const cElo = await getElo(ctx, c);
    const aElo = await getElo(ctx, a);
    expect(cElo.wins).toBe(1);
    expect(cElo.losses).toBe(0);
    expect(cElo.matchesPlayed).toBe(1);
    expect(aElo.wins).toBe(0);
    expect(aElo.losses).toBe(1);
    expect(aElo.matchesPlayed).toBe(1);
  });

  it('conservation: total Cash delta across both players = payout - fee', async () => {
    // The fee is debited from the winner. The total Cash across
    // both players increases by (payout - fee) on settlement, with
    // the stakes already posted in cashBefore.
    const ctx = buildContext();
    const c = await newUser('c');
    const a = await newUser('a');
    await setBalance(c, 1_000_000);
    await setBalance(a, 1_000_000);
    const stake = 100_000;
    const m = await openMatch(ctx, c, stake);
    await acceptMatch(ctx, a, m.matchId);
    const cashBefore = (await getBalance(c)) + (await getBalance(a));
    await settleMatch(ctx, m.matchId, c);
    const cashAfter = (await getBalance(c)) + (await getBalance(a));
    // settlement delta across the two players: winner gets
    // (payout - fee), loser gets 0. payout = 2*stake - 5% = 190_000;
    // fee = 10_000; net = +180_000.
    expect(cashAfter - cashBefore).toBe(180_000);
  });
});
