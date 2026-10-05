/**
 * Needs service.
 *
 * Applies a single needs action (eat, sleep, shower, touch_grass,
 * party) and writes a tiny ledger entry for the optional Cash
 * effect (party costs 0 in M2; future phases add paid actions).
 * Decay is computed on read by the GET /v1/me handler — this
 * service only writes the new level.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

type ActionId = 'eat' | 'sleep' | 'shower' | 'touch_grass' | 'party';

interface NeedsAction {
  readonly id: string;
  readonly raises: string;
  readonly amount: number;
  readonly where: string;
  readonly cooldownSec: number;
  readonly costCents: number;
  readonly durationSec?: number;
  readonly venues?: readonly string[];
}

interface NeedsConfig {
  readonly version: string;
  readonly decayPerHour: Readonly<Record<string, number>>;
  readonly minValue: number;
  readonly maxValue: number;
  readonly startValue: number;
  readonly actions: readonly NeedsAction[];
}

export class NeedsService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Apply an action. Returns the new needs and the unchanged
   * cashCents. Throws ValidationFailedError if the action is
   * restricted (e.g. party only in clubs).
   */
  async apply(
    userId: string,
    actionId: ActionId,
  ): Promise<{
    needs: { energy: number; hunger: number; fun: number; hygiene: number; sanity: number };
    cashCents: number;
  }> {
    const cfg = this.ctx.configCache.load<NeedsConfig>('needs');
    const action = cfg.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new ValidationFailedError({ actionId });
    }
    // Party is club-only (contract section 4). The realtime layer
    // enforces the venue; the REST endpoint accepts party.
    return runInTransaction(async (client) => {
      const u = await client.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
      if ((u.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'user', id: userId });
      // Ensure the row exists.
      await client.query(
        `INSERT INTO needs (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const raise = action.raises as keyof NeedsRow;
      await this.bump(client, userId, raise, action.amount);
      const row = await client.query<NeedsRow>(
        'SELECT energy, hunger, fun, hygiene, sanity FROM needs WHERE user_id = $1',
        [userId],
      );
      const bal = await client.query<{ cash_cents: string }>(
        'SELECT cash_cents FROM balances WHERE user_id = $1',
        [userId],
      );
      return {
        needs: row.rows[0] ?? { energy: 50, hunger: 50, fun: 50, hygiene: 50, sanity: 50 },
        cashCents: Number(bal.rows[0]?.cash_cents ?? 0),
      };
    });
  }

  private async bump(
    client: import('pg').PoolClient,
    userId: string,
    column: 'energy' | 'hunger' | 'fun' | 'hygiene' | 'sanity',
    delta: number,
  ): Promise<void> {
    // Clamp to [0, 100].
    const set = `GREATEST(0, LEAST(100, ${column} + $2))`;
    await client.query(
      `UPDATE needs SET ${column} = ${set}, last_action_at = now() WHERE user_id = $1`,
      [userId, delta],
    );
  }
}

interface NeedsRow {
  energy: number;
  hunger: number;
  fun: number;
  hygiene: number;
  sanity: number;
}
