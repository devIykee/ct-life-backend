/**
 * Rent worker.
 *
 * Weekly rent debits. Runs at Monday 00:00 UTC. Iterates every
 * home and debits `rent_cents_per_week` from the owner's cash.
 * If the owner has insufficient cash, `debt_cents` on the
 * balances table is incremented (exit-liquidity-baby semantics), the
 * home goes `overdue` and `missed_weeks` counts up; after
 * EVICT_AFTER_MISSED_WEEKS misses in a row it is `evicted` and its unit
 * is free again. A paid week clears the overdue state. Moved-out and
 * evicted homes owe nothing.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { Db } from '../shared/db/pool.js';
import { EVICT_AFTER_MISSED_WEEKS } from '../application/homes.js';
import { publishHomeAccess } from '../application/home-units.js';
import { createRedis } from '../shared/redis/client.js';

/**
 *
 */
export async function runWeeklyRent(db: Db): Promise<{ debited: number; debt: number }> {
  let debited = 0;
  let debt = 0;
  const evicted: string[] = [];
  const homes = await db.withConnection(async (c) => {
    const r = await c.query<{
      home_id: string;
      owner_user_id: string;
      rent_cents_per_week: string;
    }>(
      `SELECT home_id, owner_user_id, rent_cents_per_week FROM homes
       WHERE rent_cents_per_week > 0 AND status IN ('active', 'overdue')`,
    );
    return r.rows;
  });
  for (const row of homes) {
    const rent = Number(row.rent_cents_per_week);
    try {
      await runInTransaction(async (client) => {
        // The list above is a snapshot. Lock the row and look again: a home
        // moved out or evicted since then owes nothing and must not be revived.
        const live = await client.query<{ status: string }>(
          `SELECT status FROM homes WHERE home_id = $1 FOR UPDATE`,
          [row.home_id],
        );
        const status = live.rows[0]?.status;
        if (status !== 'active' && status !== 'overdue') return;
        await client.query(
          `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [row.owner_user_id],
        );
        const bal = await client.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
          [row.owner_user_id],
        );
        const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
        if (cash >= BigInt(rent)) {
          const paid = await client.query(
            `UPDATE homes SET last_rent_paid_at = now(), status = 'active', missed_weeks = 0
              WHERE home_id = $1 AND status IN ('active', 'overdue')`,
            [row.home_id],
          );
          if (paid.rowCount === 0) return;
          await client.query(
            `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now()
             WHERE user_id = $2`,
            [rent, row.owner_user_id],
          );
          await client.query(
            `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
             VALUES ($1, $2, 'cash', 'rent', 'home', $3, $4)`,
            [row.owner_user_id, -rent, row.home_id, `home-rent-weekly:${uuidv7()}`],
          );
          debited += 1;
        } else {
          const missed = await client.query<{ status: string }>(
            `UPDATE homes
                SET missed_weeks = missed_weeks + 1,
                    status = CASE WHEN missed_weeks + 1 >= $2 THEN 'evicted' ELSE 'overdue' END,
                    ended_at = CASE WHEN missed_weeks + 1 >= $2 THEN now() ELSE ended_at END
              WHERE home_id = $1 AND status IN ('active', 'overdue')
          RETURNING status`,
            [row.home_id, EVICT_AFTER_MISSED_WEEKS],
          );
          if (missed.rowCount === 0) return;
          await client.query(
            `UPDATE balances SET debt_cents = debt_cents + $1, updated_at = now()
             WHERE user_id = $2`,
            [rent, row.owner_user_id],
          );
          if (missed.rows[0]?.status === 'evicted') evicted.push(row.home_id);
          debt += 1;
        }
      });
    } catch (e) {
      // One bad home must not stop the run; the next run picks it up again.
      console.error(`[rent] home ${row.home_id} failed:`, (e as Error).message);
    }
  }
  // Whoever is standing in an evicted home gets shown out.
  if (evicted.length > 0) {
    const redis = createRedis().main;
    for (const homeId of evicted) await publishHomeAccess(redis, homeId);
  }
  return { debited, debt };
}
