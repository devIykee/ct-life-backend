/**
 * ORE routes.
 *
 *   GET  /v1/ore/board
 *   GET  /v1/ore/me
 *   POST /v1/ore/stake/tx
 *   POST /v1/ore/stake/submitted
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { NotFoundError, ValidationFailedError } from '../../shared/domain/errors.js';
import {
  markStakeSubmitted,
  readBoard,
  readOreMe,
} from '../../application/refinery.js';
import {
  buildOreStakeTx,
  encodeTxBase64,
  ORE_STAKE_PROGRAM_ID,
  ORE_MINT,
  STORE_MINT,
  stakePda,
  type OreStakeAction,
} from '../../shared/solana/ore-stake.js';

const StakeTxBody = z.object({
  action: z.enum(['deposit', 'withdraw', 'claim', 'compound']),
  amount: z.string().optional(),
});

const SubmittedBody = z.object({
  intentId: z.string().uuid(),
  signature: z.string().min(64).max(128),
});

/**
 * Register ORE routes (board, me, stake tx, stake submitted).
 * @param app - The Fastify instance.
 */
export function registerOreRoutes(app: FastifyInstance): void {
  app.get('/v1/ore/board', async (req, reply) => {
    const board = await readBoard(req.ctx);
    return reply.send(board);
  });

  app.get('/v1/ore/me', { preHandler: requireAuth }, async (req, reply) => {
    const me = await readOreMe(req.ctx, req.user!.sub);
    return reply.send(me);
  });

  app.post(
    '/v1/ore/stake/tx',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = StakeTxBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const userId = req.user!.sub;
      // The user_id (UUIDv7) is not the same as the on-chain
      // Solana pubkey. Look up the user's wallet and use that.
      const r = await req.ctx.db.withConnection((c) =>
        c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id = $1', [userId]),
      );
      const wallet = r.rows[0]?.wallet;
      if (wallet === undefined) throw new NotFoundError({ kind: 'user', id: userId });
      let userPubkey: PublicKey;
      try {
        userPubkey = new PublicKey(wallet);
      } catch {
        throw new ValidationFailedError({ reason: 'user wallet is not a valid pubkey' });
      }
      const amount = body.data.amount !== undefined ? BigInt(body.data.amount) : undefined;
      const tx = buildOreStakeTx({
        userPubkey,
        action: body.data.action as OreStakeAction,
        amount,
      });
      return reply.send({
        txBase64: encodeTxBase64(tx),
        action: body.data.action,
        stakeProgram: ORE_STAKE_PROGRAM_ID.toBase58(),
        oreMint: ORE_MINT.toBase58(),
        stOreMint: STORE_MINT.toBase58(),
        stakePda: stakePda(userPubkey).toBase58(),
      });
    },
  );

  app.post(
    '/v1/ore/stake/submitted',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = SubmittedBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      await markStakeSubmitted(req.ctx, req.user!.sub, body.data.intentId, body.data.signature);
      return reply.status(204).send();
    },
  );
}
