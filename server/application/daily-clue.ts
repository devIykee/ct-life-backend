/**
 * Daily clue service (M5 #60).
 *
 * Endpoints:
 *
 *   GET  /v1/daily-clue         — return today's clue (text + expiresAt;
 *                                  never the answer hash)
 *   POST /v1/daily-clue/answer  — submit a guess; correct -> credit prize
 *                                  via a 'daily_clue' ledger row, record
 *                                  a daily_clue_attempts row.
 *
 * The clue + answer are loaded from the `daily_clue` table
 * (M5 #58). The table is populated by the daily-clue seeder
 * (see `seedClue`) which writes one row per UTC date with a
 * deterministic answer hash. The application never sends the
 * answer hash to the client; it only sends `clueText` and
 * `expiresAt`.
 *
 * The `daily_clue_attempts` table has UNIQUE (user_id, clue_id)
 * so a second answer for the same day is rejected at the
 * database level. The application translates a 23505 into
 * 409 ALREADY_ATTEMPTED.
 */
import { createHash } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export interface DailyCluePublic {
  readonly date: string;
  readonly clueText: string;
  readonly expiresAt: string;
  readonly prizeCents: number;
}

export interface AnswerResult {
  readonly correct: boolean;
  readonly prizeCents: number;
}

const CLUE_POOL: ReadonlyArray<{ text: string; answer: string; prizeCents: number }> = [
  {
    text: 'What is the only letter that does not appear in any U.S. state name?',
    answer: 'q',
    prizeCents: 5000,
  },
  {
    text: 'How many continents are there?',
    answer: '7',
    prizeCents: 3000,
  },
  {
    text: 'What is the capital of Japan?',
    answer: 'tokyo',
    prizeCents: 4000,
  },
  {
    text: 'What year did the Berlin Wall fall?',
    answer: '1989',
    prizeCents: 4500,
  },
  {
    text: 'What is the smallest prime number?',
    answer: '2',
    prizeCents: 2500,
  },
  {
    text: 'Which planet is known as the Red Planet?',
    answer: 'mars',
    prizeCents: 3000,
  },
  {
    text: 'How many keys are on a standard piano?',
    answer: '88',
    prizeCents: 3500,
  },
  {
    text: 'What is the chemical symbol for gold?',
    answer: 'au',
    prizeCents: 4000,
  },
];

interface ClueDbRow {
  clue_id: string;
  date: Date;
  clue_text: string;
  answer_hash: string;
  prize_cents: string;
  expires_at: Date;
}

function hashAnswer(answer: string): string {
  return createHash('sha256').update(answer.trim().toLowerCase()).digest('hex');
}

function dateUtc(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function hashInt(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

/**
 * Idempotently seed today's clue row. The pool is small and
 * rotated deterministically by date so the same clue appears
 * for every player that day.
 */
export async function seedClue(ctx: AppContext, forDate: string = dateUtc()): Promise<void> {
  const exists = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ clue_id: string }>(`SELECT clue_id FROM daily_clue WHERE date = $1`, [
      forDate,
    ]);
    return r.rows[0];
  });
  if (exists) return;
  const idx = hashInt(forDate) % CLUE_POOL.length;
  const pick = CLUE_POOL[idx]!;
  const clueId = uuidv7();
  const expiresAt = new Date(`${forDate}T23:59:59.999Z`);
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO daily_clue (clue_id, date, clue_text, answer_hash, prize_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (date) DO NOTHING`,
      [clueId, forDate, pick.text, hashAnswer(pick.answer), pick.prizeCents, expiresAt],
    );
  });
}

/** Today's clue (UTC date). Returns the public shape. */
export async function getToday(ctx: AppContext): Promise<DailyCluePublic> {
  await seedClue(ctx);
  const today = dateUtc();
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<ClueDbRow>(
      `SELECT clue_id, date, clue_text, answer_hash, prize_cents, expires_at
       FROM daily_clue WHERE date = $1`,
      [today],
    );
  });
  const row = r.rows[0];
  if (!row) {
    throw new NotFoundError({ reason: 'no clue for today' });
  }
  return {
    date: today,
    clueText: row.clue_text,
    expiresAt: row.expires_at.toISOString(),
    prizeCents: Number(row.prize_cents),
  };
}

/**
 * Submit an answer. Idempotent on (user_id, clue_id) — the
 * UNIQUE index fires 23505 if the player already answered.
 * Correct first try credits the prize via a 'daily_clue' ledger
 * row; a wrong first try is recorded but pays nothing.
 */
export async function answer(
  ctx: AppContext,
  userId: string,
  attempt: string,
): Promise<AnswerResult> {
  if (typeof attempt !== 'string' || attempt.length === 0 || attempt.length > 200) {
    throw new ValidationFailedError({ reason: 'attempt 1..200 chars' });
  }
  await seedClue(ctx);
  const today = dateUtc();
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<ClueDbRow>(
      `SELECT clue_id, date, clue_text, answer_hash, prize_cents, expires_at
       FROM daily_clue WHERE date = $1`,
      [today],
    );
  });
  const row = r.rows[0];
  if (!row) {
    throw new NotFoundError({ reason: 'no clue for today' });
  }
  const expected = row.answer_hash;
  const correct = hashAnswer(attempt) === expected;
  const attemptId = uuidv7();
  try {
    await runInTransaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO daily_clue_attempts (attempt_id, user_id, clue_id, attempt_text, correct)
           VALUES ($1, $2, $3, $4, $5)`,
          [attemptId, userId, row.clue_id, attempt, correct],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new ForbiddenError({ reason: 'already_attempted' });
        }
        throw e;
      }
      if (correct) {
        await client.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
          [userId, row.prize_cents],
        );
        await client.query(
          `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
           VALUES ($1, $2, 'cash', 'daily_clue', 'clue', $3, $4)`,
          [userId, row.prize_cents, row.clue_id, `clue:${row.clue_id}:${userId}`],
        );
      }
    });
  } catch (e) {
    if (e instanceof ForbiddenError) throw e;
    throw e;
  }
  return { correct, prizeCents: correct ? Number(row.prize_cents) : 0 };
}
