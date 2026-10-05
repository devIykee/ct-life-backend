/**
 * Meta service (Weekly Meta).
 *
 *   GET  /v1/meta/current  — return the row in `meta` with key='current'
 *   POST /v1/admin/meta    — set the meta row (admin only)
 *
 * The Weekly Meta rotation runs at Sun 20:00 UTC. The worker
 * (server/workers/weekly-meta.ts) writes the new meta row when
 * it rotates; this service exposes the read + admin write.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export const META_CURRENT_KEY = 'current';

export interface MetaRow {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

/**
 *
 */
export async function getCurrentMeta(ctx: AppContext): Promise<MetaRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ key: string; value: unknown; updated_at: Date }>(
      `SELECT key, value, updated_at FROM meta WHERE key = $1`,
      [META_CURRENT_KEY],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'meta', key: META_CURRENT_KEY });
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Set the meta row (admin only). */
export async function setCurrentMeta(ctx: AppContext, value: unknown): Promise<MetaRow> {
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO meta (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [META_CURRENT_KEY, JSON.stringify(value)],
    );
  });
  return getCurrentMeta(ctx);
}
