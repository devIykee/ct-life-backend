/**
 * Core routes.
 *
 *   GET  /v1/config        — every registry + game config (contract section 4)
 *   GET  /v1/me            — Me shape (contract section 4)
 *   POST /v1/characters    — create a character (contract 4)
 *   POST /v1/lottery/roll  — birth lottery, once per account
 *   POST /v1/needs/actions — eat/sleep/shower/touch_grass/party
 *   GET  /v1/users/{id}    — public profile with netWorthCents
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { NotFoundError, ValidationFailedError } from '../../shared/domain/errors.js';
import { LotteryService } from '../../application/lottery.js';
import { CharacterService } from '../../application/character.js';
import { NeedsService } from '../../application/needs.js';
import { PublicProfileService } from '../../application/public-profile.js';

const CharacterBody = z.object({
  alias: z.string().min(3).max(24),
  look: z.object({
    skinTone: z.string(),
    headId: z.string(),
    hairId: z.string(),
    topId: z.string(),
    bottomId: z.string(),
    shoesId: z.string(),
    accId: z.string(),
  }),
  traitIds: z.tuple([z.string(), z.string()]),
  dreamId: z.string(),
  tribeId: z.string(),
  ageConfirmed: z.literal(true),
});

const NeedsActionBody = z.object({
  actionId: z.enum(['eat', 'sleep', 'shower', 'touch_grass', 'party']),
});

/**
 *
 */
export function registerCoreRoutes(app: FastifyInstance): void {
  // GET /v1/config
  app.get('/v1/config', async (req, reply) => {
    const cache = req.ctx.configCache;
    // Aggregated response: all registries + game config in one shot.
    // The contract says the client caches by ETag.
    const payload = {
      version: '1.0.0-rc1',
      minClientVersion: '1.0.0',
      // Registries (subset for M2).
      venues: cache.load<unknown>('venues') ?? null,
      archetypes: cache.load<unknown>('archetypes') ?? null,
      traits: cache.load<unknown>('traits') ?? null,
      tribes: cache.load<unknown>('tribes') ?? null,
      dreams: cache.load<unknown>('dreams') ?? null,
      homes: cache.load<unknown>('homes') ?? null,
      toasts: cache.load<unknown>('toasts') ?? null,
      anims: cache.load<unknown>('anims') ?? null,
      sfx: cache.load<unknown>('sfx') ?? null,
      items: cache.load<unknown>('items') ?? null,
      // Game config.
      economy: cache.load<unknown>('economy'),
      needs: cache.load<unknown>('needs'),
      skills: cache.load<unknown>('skills'),
      lottery: cache.load<unknown>('lottery'),
      careers: cache.load<unknown>('careers'),
      events: cache.load<unknown>('events'),
      boards: cache.load<unknown>('boards'),
    };
    return reply.send(payload);
  });

  // GET /v1/me
  app.get('/v1/me', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.sub;
    const me = await loadMe(req, userId);
    return reply.send(me);
  });

  // POST /v1/characters
  app.post(
    '/v1/characters',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = CharacterBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      if (!body.data.ageConfirmed) throw new ValidationFailedError({ reason: 'age_unconfirmed' });
      const svc = new CharacterService(req.ctx.configCache);
      const created = await svc.create(req.user!.sub, body.data);
      return reply.status(201).send(created);
    },
  );

  // POST /v1/lottery/roll
  app.post(
    '/v1/lottery/roll',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const svc = new LotteryService(req.ctx);
      const result = await svc.roll(req.user!.sub, req.user!.wal);
      return reply.send(result);
    },
  );

  // POST /v1/needs/actions
  app.post(
    '/v1/needs/actions',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = NeedsActionBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const svc = new NeedsService(req.ctx);
      const result = await svc.apply(req.user!.sub, body.data.actionId);
      return reply.send(result);
    },
  );

  // GET /v1/users/{id}
  app.get('/v1/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const svc = new PublicProfileService(req.ctx);
    const profile = await svc.byId(id);
    if (profile === null) throw new NotFoundError({ kind: 'user', id });
    return reply.send(profile);
  });
}

async function loadMe(req: import('fastify').FastifyRequest, userId: string) {
  return req.ctx.db.withConnection(async (c: import('pg').PoolClient) => {
    const u = await c.query<{
      id: string;
      wallet: string;
      is_seeker: boolean;
      skr_name: string | null;
      is_sybil_jailed: boolean;
      sybil_jailed_at: Date | null;
      lottery_rolled_at: Date | null;
    }>(
      'SELECT id, wallet, is_seeker, skr_name, is_sybil_jailed, sybil_jailed_at, lottery_rolled_at FROM users WHERE id = $1',
      [userId],
    );
    if (u.rowCount === 0) throw new NotFoundError({ kind: 'user', id: userId });
    const uRow = u.rows[0]!;
    const ch = await c.query<{
      alias: string;
      look: unknown;
      tribe_id: string;
      trait_ids: string[];
      dream_id: string;
      home_id: string;
    }>(
      `SELECT alias, look, tribe_id, trait_ids, dream_id, home_id
       FROM characters WHERE user_id = $1`,
      [userId],
    );
    const need = await c.query<{
      energy: number;
      hunger: number;
      fun: number;
      hygiene: number;
      sanity: number;
    }>('SELECT energy, hunger, fun, hygiene, sanity FROM needs WHERE user_id = $1', [userId]);
    const sk = await c.query<{
      clout: number;
      coding: number;
      trading: number;
      writing: number;
      design: number;
      security: number;
    }>('SELECT clout, coding, trading, writing, design, security FROM skills WHERE user_id = $1', [
      userId,
    ]);
    const bal = await c.query<{ cash_cents: string; debt_cents: string }>(
      'SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1',
      [userId],
    );
    const chRow = ch.rows[0];
    const needRow = need.rows[0] ?? { energy: 50, hunger: 50, fun: 50, hygiene: 50, sanity: 50 };
    const skRow = sk.rows[0] ?? {
      clout: 1,
      coding: 1,
      trading: 1,
      writing: 1,
      design: 1,
      security: 1,
    };
    const balRow = bal.rows[0] ?? { cash_cents: '0', debt_cents: '0' };
    return {
      user: {
        id: uRow.id,
        wallet: uRow.wallet,
        isSeeker: uRow.is_seeker,
        skrName: uRow.skr_name,
        isSybilJailed: uRow.is_sybil_jailed,
        sybilJailedAt: uRow.sybil_jailed_at ? uRow.sybil_jailed_at.toISOString() : null,
      },
      character: chRow
        ? {
            alias: chRow.alias,
            look: chRow.look,
            tribeId: chRow.tribe_id,
            traitIds: chRow.trait_ids,
            dreamId: chRow.dream_id,
            homeId: chRow.home_id,
          }
        : null,
      needs: needRow,
      skills: skRow,
      cashCents: Number(balRow.cash_cents),
      debtCents: Number(balRow.debt_cents),
      homeId: chRow?.home_id ?? 'parents_basement',
      minerTier: 'none',
      flags: {
        lotteryRolled: uRow.lottery_rolled_at !== null,
      },
    };
  });
}
