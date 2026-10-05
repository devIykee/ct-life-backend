/**
 * Daily clue service.
 *
 * One clue per UTC day. The clue is generated deterministically
 * from the date so every player sees the same clue. The answer is
 * a normalised string. Correct answers pay a config-driven prize
 * via a ledger entry.
 */
import { createHash } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

interface DailyClue {
  readonly date: string; // YYYY-MM-DD UTC
  readonly clueText: string;
  readonly expiresAt: string;
  readonly answerHash: string;
  readonly prizeCents: number;
}

const _clues = new Map<string, DailyClue>(); // date -> clue

export class DailyClueService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Today's clue (UTC date). Generated deterministically. */
  async getToday(userId: string): Promise<{ clueText: string; expiresAt: string }> {
    const date = todayUtc();
    const clue = this.getOrCreate(date);
    // Has the player already answered? We check a Redis key.
    const key = `clue:${date}:${userId}`;
    const already = await this.ctx.redis.main.get(key);
    void already;
    return { clueText: clue.clueText, expiresAt: clue.expiresAt };
  }

  /** Submit an answer. Idempotent on (date, user). Pays the prize on a correct first try. */
  async answer(userId: string, answer: string): Promise<{ correct: boolean; prizeCents: number }> {
    const date = todayUtc();
    const clue = this.getOrCreate(date);
    const key = `clue:${date}:${userId}`;
    const set = await this.ctx.redis.main.set(key, '1', 'EX', 60 * 60 * 26, 'NX');
    if (set !== 'OK') {
      throw new ForbiddenError({ reason: 'already_answered' });
    }
    const normalised = answer.trim().toLowerCase();
    const correct = createHash('sha256').update(normalised).digest('hex') === clue.answerHash;
    if (!correct) {
      return { correct: false, prizeCents: 0 };
    }
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [userId, clue.prizeCents],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'daily_clue', 'clue', $3, $4)`,
        [userId, clue.prizeCents, date, `clue:${date}:${userId}`],
      );
    });
    return { correct: true, prizeCents: clue.prizeCents };
  }

  private getOrCreate(date: string): DailyClue {
    const cached = _clues.get(date);
    if (cached) return cached;
    // Read the clue pool from contract/config (or fall back to a
    // minimal default). The pool is a list of { text, answer, prize }.
    const pool = this.loadPool();
    const idx = hashInt(date) % pool.length;
    const pick = pool[idx]!;
    const expiresAt = new Date(`${date}T23:59:59.999Z`).toISOString();
    const answerHash = createHash('sha256').update(pick.answer.trim().toLowerCase()).digest('hex');
    const clue: DailyClue = {
      date,
      clueText: pick.text,
      expiresAt,
      answerHash,
      prizeCents: pick.prizeCents,
    };
    _clues.set(date, clue);
    return clue;
  }

  private loadPool(): Array<{ text: string; answer: string; prizeCents: number }> {
    // The contract has no daily-clue config yet; ship a single
    // default clue. M4 will add a real pool.
    return [
      {
        text: 'What is the only letter that does not appear in any U.S. state name?',
        answer: 'q',
        prizeCents: 5000,
      },
    ];
  }
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function hashInt(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}
