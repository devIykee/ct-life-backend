/**
 * Blocks service.
 *
 * B15: Bidirectional block. When A blocks B, both (A,B) and (B,A) rows
 * are inserted. This ensures blocked users cannot see/interact with
 * the blocker either. Unblock removes both rows.
 *
 * A UNIQUE (blocker_user_id, blocked_user_id) constraint makes
 * double-blocks idempotent.
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
   * Block a user bidirectionally. Idempotent: re-blocking returns silently.
   * Throws ValidationFailedError if the target is the caller.
   * B15: Inserts both (blocker, blocked) and (blocked, blocker) for bidirectional effect.
   */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new ValidationFailedError({ reason: 'cannot_block_self' });
    }
    await runInTransaction(async (client) => {
      // B15: Insert both directions for bidirectional block
      try {
        await client.query(
          `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($2, $1)`,
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
   * B15: Removes both (blocker, blocked) and (blocked, blocker) rows.
   */
  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.ctx.db.withConnection((c) =>
      c.query(
        `DELETE FROM blocks WHERE
         (blocker_user_id = $1 AND blocked_user_id = $2) OR
         (blocker_user_id = $2 AND blocked_user_id = $1)`,
        [blockerId, blockedId],
      ),
    );
  }
}
