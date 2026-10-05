/**
 * Blocks service.
 *
 * One-way block. Inserts (blocker, blocked) into the blocks table;
 * a UNIQUE (blocker_user_id, blocked_user_id) constraint makes
 * double-blocks idempotent. Unblock deletes the row.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export class BlocksService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Block a user. Idempotent: re-blocking returns silently.
   * Throws ValidationFailedError if the target is the caller.
   */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new ValidationFailedError({ reason: 'cannot_block_self' });
    }
    await runInTransaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`,
          [blockerId, blockedId],
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        // Already blocked. Idempotent.
      }
    });
  }

  /**
   * Unblock. Idempotent: silently succeeds if not blocked.
   */
  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.ctx.db.withConnection((c) =>
      c.query(`DELETE FROM blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2`, [
        blockerId,
        blockedId,
      ]),
    );
  }
}
