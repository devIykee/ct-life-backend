/**
 * Reports service.
 *
 * Submit a report. The M2 moderation queue (M5) reads
 * `WHERE resolved_at IS NULL ORDER BY created_at ASC`.
 *
 * `npc_reply` reports an AI NPC chat reply: targetId is the `replyId` that
 * `POST /v1/llm/chat` returned (an `llm_npc_interactions` row). Only the
 * player the reply was written for can report it.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { RateLimitedError, ValidationFailedError } from '../shared/domain/errors.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import type { AppContext } from './context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportInput {
  readonly targetType: 'user' | 'message' | 'space' | 'call' | 'post' | 'ad' | 'npc_reply';
  readonly targetId: string;
  readonly reasonId: string;
  readonly note?: string;
}

/** Reports a player may file per hour (burst of 5, refilled evenly). */
export const REPORTS_PER_HOUR = 10;
const REPORT_BURST = 5;

export class ReportsService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  /**
   * Insert a report. Rate limited per player (`RATE_LIMITED`); reporting the
   * same target again while the first report is open is a silent no-op.
   */
  async submit(reporterId: string, input: ReportInput): Promise<void> {
    if (input.targetType === 'user' && input.targetId === reporterId) {
      throw new ValidationFailedError({ reason: 'cannot_report_self' });
    }
    const decision = await perUserTokenBucket(
      this.ctx.redis.main,
      `rl:reports:${reporterId}`,
      REPORT_BURST,
      REPORTS_PER_HOUR / 3600,
      1,
    );
    if (!decision.allowed) {
      throw new RateLimitedError(decision.retryAfterMs, {
        limit: REPORTS_PER_HOUR,
        window: 'hour',
      });
    }
    await runInTransaction(async (client) => {
      if (input.targetType === 'npc_reply') {
        const own = UUID.test(input.targetId)
          ? await client.query(
              `SELECT 1 FROM llm_npc_interactions WHERE interaction_id = $1 AND user_id = $2`,
              [input.targetId, reporterId],
            )
          : null;
        if (!own || own.rowCount === 0) {
          throw new ValidationFailedError({ reason: 'unknown_reply', targetId: input.targetId });
        }
      }
      await client.query(
        `INSERT INTO reports (reporter_user_id, target_type, target_id, reason_id, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (reporter_user_id, target_type, target_id) WHERE resolved_at IS NULL DO NOTHING`,
        [reporterId, input.targetType, input.targetId, input.reasonId, input.note ?? null],
      );
    });
  }
}
