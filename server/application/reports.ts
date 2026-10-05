/**
 * Reports service.
 *
 * Submit a report. The M2 moderation queue (M5) reads
 * `WHERE resolved_at IS NULL ORDER BY created_at ASC`.
 */
import { runInTransaction } from '../shared/db/uow.js';
import type { AppContext } from './context.js';

export interface ReportInput {
  readonly targetType: 'user' | 'message' | 'space' | 'call' | 'post' | 'ad';
  readonly targetId: string;
  readonly reasonId: string;
  readonly note?: string;
}

export class ReportsService {
  // ctx is held for symmetry; unused here.

  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  /** Insert a report. Idempotency is handled at the middleware layer. */
  async submit(reporterId: string, input: ReportInput): Promise<void> {
    void this.ctx;
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO reports (reporter_user_id, target_type, target_id, reason_id, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [reporterId, input.targetType, input.targetId, input.reasonId, input.note ?? null],
      );
    });
  }
}
