/**
 * Ops: requeue paid calls parked as `stuck` (unlock C2, security review M3).
 *
 * A refund-path row is parked as `stuck` after repeated chain failures (ALERT in the
 * worker log). Once the cause is fixed (RPC down, the settle authority out of SOL, ...),
 * this puts the rows back into the status they were parked from with their attempts
 * reset; the paid-call worker then retries them on its next pass. It only updates the
 * database and never signs or sends a transaction.
 *
 * Usage (with the API's env, e.g. `railway run`):
 *   pnpm exec tsx tools/scripts/paid-calls-requeue.ts --list
 *   pnpm exec tsx tools/scripts/paid-calls-requeue.ts --call <callId> [--call <callId> ...]
 *   pnpm exec tsx tools/scripts/paid-calls-requeue.ts --all-stuck
 */
import { buildContext } from '../../server/application/context.js';
import { requeueStuckCalls } from '../../server/application/paid-calls.js';

function callIds(): string[] {
  const ids: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === '--call' && process.argv[i + 1]) ids.push(process.argv[i + 1]!);
  });
  return ids;
}

async function main(): Promise<void> {
  const ctx = buildContext();
  try {
    if (process.argv.includes('--list')) {
      const r = await ctx.db.withConnection((c) =>
        c.query<{ call_id: string; stuck_from: string; attempts: number; last_error: string }>(
          `SELECT call_id, stuck_from, attempts, last_error FROM paid_calls
            WHERE status = 'stuck' ORDER BY created_at`,
        ),
      );
      for (const row of r.rows)
        console.log(row.call_id, row.stuck_from, row.attempts, row.last_error);
      console.log(`${r.rows.length} stuck call(s)`);
      return;
    }
    const ids = callIds();
    if (ids.length === 0 && !process.argv.includes('--all-stuck')) {
      console.error('pass --list, --call <callId> (repeatable) or --all-stuck');
      process.exit(2);
    }
    const out = await requeueStuckCalls(ctx, ids.length > 0 ? ids : undefined);
    console.log(`requeued ${out.requeued.length}:`, out.requeued.join(' ') || '-');
    if (out.skipped.length > 0) {
      console.log(`skipped ${out.skipped.length} (not stuck, or would clash with an open call):`);
      console.log(out.skipped.join(' '));
    }
  } finally {
    await ctx.db.close();
    await ctx.redis.close();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
