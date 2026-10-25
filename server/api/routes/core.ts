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
import { createHash } from 'node:crypto';
import { getDreamProgress } from '../../application/world-pulse.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import {
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  addBeat,
  BEATS,
  getFirstSession,
  onCharacterCreated,
  onOriginRolled,
  replayFirstSession,
  skipFirstSession,
} from '../../application/onboarding.js';
import { LotteryService } from '../../application/lottery.js';
import { CharacterService, updateLook } from '../../application/character.js';
import { NeedsService } from '../../application/needs.js';
import { PublicProfileService } from '../../application/public-profile.js';
import { debtSchedule } from '../../application/bank.js';
import { loadMeHome } from '../../application/homes.js';
import { oreReaderAvailable } from '../../application/refinery.js';
import { CHARACTER_PALETTES } from '../../shared/domain/character-palettes.js';

/**
 * B34: Compare semver versions. Returns true if clientVersion < minVersion.
 */
function isVersionOutdated(clientVersion: string, minVersion: string): boolean {
  const parseVersion = (v: string): number[] => {
    return v.split('.').map((x) => parseInt(x, 10) || 0);
  };
  const client = parseVersion(clientVersion);
  const min = parseVersion(minVersion);
  for (let i = 0; i < 3; i++) {
    if ((client[i] ?? 0) < (min[i] ?? 0)) return true;
    if ((client[i] ?? 0) > (min[i] ?? 0)) return false;
  }
  return false;
}

const CharacterBody = z.object({
  likenessJobId: z.uuid().optional(),
  alias: z.string().min(3).max(24),
  look: z.strictObject({
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

// Any subset of the seven look fields (at least one). Unknown fields are refused.
const LookPatchBody = z
  .strictObject({
    skinTone: z.string().min(1).max(64),
    headId: z.string().min(1).max(100),
    hairId: z.string().min(1).max(100),
    topId: z.string().min(1).max(100),
    bottomId: z.string().min(1).max(100),
    shoesId: z.string().min(1).max(100),
    accId: z.string().min(1).max(100),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one look field' });

/** First-session calls allowed per player per minute. */
const FIRST_SESSION_PER_MIN = 20;
// Exactly one of: a beat, skip, or replay. Unknown beats and extra fields are 400.
const FirstSessionBody = z.union([
  z.strictObject({ beat: z.enum(BEATS) }),
  z.strictObject({ skip: z.literal(true) }),
  z.strictObject({ replay: z.literal(true) }),
]);

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
    const anims = cache.loadOptional<{ anims?: string[] }>('anims');
    const payload = {
      version: '1.0.0-rc1',
      minClientVersion: '1.0.0',
      // The release phase this deployment has opened (env LIVE_PHASE, 1 to 6, default 1).
      livePhase: req.ctx.config.livePhase,
      // Kill-switch list. Only `ore_reader` is wired: it is listed when
      // GET /v1/ore/board cannot serve a live board (ORE_READER_ENABLED off).
      degraded: oreReaderAvailable(req.ctx) ? [] : ['ore_reader'],
      // Registries (subset for M2). Optional per the contract's
      // ConfigResponse, so a missing file yields null instead of failing
      // the whole response.
      venues: cache.loadOptional<unknown>('venues'),
      archetypes: cache.loadOptional<unknown>('archetypes'),
      traits: cache.loadOptional<unknown>('traits'),
      tribes: cache.loadOptional<unknown>('tribes'),
      dreams: cache.loadOptional<unknown>('dreams'),
      homes: cache.loadOptional<unknown>('homes'),
      toasts: cache.loadOptional<unknown>('toasts'),
      // Remote switches the client reads without a release.
      flags: { wireV3Kinds: req.ctx.config.flags.wireV3Kinds },
      anims: anims ?? null,
      sfx: cache.loadOptional<unknown>('sfx'),
      items: cache.loadOptional<unknown>('items'),
      characterPalettes: CHARACTER_PALETTES,
      spots: cache.loadOptional<unknown>('spots'), // B34: add spots
      // B34: emotes. There is no emotes.json and there is not meant to be:
      // the emote ids are published in the FE-owned contract/ids/anims.json
      // under the `emote_` prefix, so derive them rather than duplicating
      // the list into a file this service does not own.
      emotes: { emotes: (anims?.anims ?? []).filter((a) => a.startsWith('emote_')) },
      // Game config.
      economy: cache.load<unknown>('economy'),
      needs: cache.load<unknown>('needs'),
      skills: cache.load<unknown>('skills'),
      lottery: cache.load<unknown>('lottery'),
      careers: cache.load<unknown>('careers'),
      events: cache.load<unknown>('events'),
      boards: cache.load<unknown>('boards'),
    };

    // B34 fix: ETag support for caching.
    // Hash the payload, not the version string: version is the constant
    // '1.0.0-rc1', so a client that once sent If-None-Match was answered
    // 304 forever and never saw an edited economy.json or registry.
    const body = JSON.stringify(payload);
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const clientEtag = req.headers['if-none-match'];
    if (clientEtag === etag) {
      return reply.status(304).send();
    }

    // B34 fix: Check client version and return 426 if outdated
    const clientVersion = req.headers['x-client-version'] as string | undefined;
    if (clientVersion && isVersionOutdated(clientVersion, payload.minClientVersion)) {
      return reply.status(426).send({
        error: {
          code: 'UPGRADE_REQUIRED',
          message: `Client version ${clientVersion} is below minimum ${payload.minClientVersion}`,
          details: { minClientVersion: payload.minClientVersion },
        },
      });
    }

    reply.header('ETag', etag);
    reply.header('Cache-Control', 'public, max-age=300'); // 5 min cache
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
      await onCharacterCreated(req.ctx, req.user!.sub);
      return reply.status(201).send(created);
    },
  );

  // POST /v1/me/first-session: {beat} | {skip: true} | {replay: true}
  app.post(
    '/v1/me/first-session',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = FirstSessionBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const userId = req.user!.sub;
      const decision = await perUserTokenBucket(
        req.ctx.redis.main,
        `rl:first-session:${userId}`,
        FIRST_SESSION_PER_MIN,
        FIRST_SESSION_PER_MIN / 60,
        1,
      );
      if (!decision.allowed) {
        reply.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        throw new RateLimitedError(decision.retryAfterMs, { limit: FIRST_SESSION_PER_MIN });
      }
      const b = body.data;
      if ('beat' in b) return reply.send(await addBeat(req.ctx, userId, b.beat));
      if ('skip' in b) return reply.send(await skipFirstSession(req.ctx, userId));
      return reply.send(await replayFirstSession(req.ctx, userId));
    },
  );

  // PATCH /v1/characters/me/look: equip an owned cosmetic or change the look
  app.patch(
    '/v1/characters/me/look',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = LookPatchBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await updateLook(req.ctx, req.user!.sub, body.data));
    },
  );

  // POST /v1/lottery/roll
  app.post(
    '/v1/lottery/roll',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const svc = new LotteryService(req.ctx);
      const result = await svc.roll(req.user!.sub, req.user!.wal);
      await onOriginRolled(req.ctx, req.user!.sub);
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
      miner_tier: string;
    }>(
      `SELECT id, wallet, is_seeker, skr_name, is_sybil_jailed, sybil_jailed_at,
              lottery_rolled_at, miner_tier
         FROM users WHERE id = $1`,
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
      likeness_job_id: string | null;
    }>(
      `SELECT alias, look, tribe_id, trait_ids, dream_id, home_id,likeness_job_id
       FROM characters WHERE user_id = $1`,
      [userId],
    );
    const need = await c.query<{
      energy: number;
      hunger: number;
      fun: number;
      hygiene: number;
      sanity: number;
      last_action_at: Date;
    }>(
      'SELECT energy, hunger, fun, hygiene, sanity, last_action_at FROM needs WHERE user_id = $1',
      [userId],
    );
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
    const defaultNeeds = {
      energy: 50,
      hunger: 50,
      fun: 50,
      hygiene: 50,
      sanity: 50,
      last_action_at: new Date(),
    };
    let needRow = need.rows[0] ?? defaultNeeds;

    // B16 fix: Apply needs decay if no active shift
    const hasActiveShift = await checkActiveShift(req, userId);
    if (!hasActiveShift && need.rows[0]) {
      const decayed = applyNeedsDecay(req, needRow);
      needRow = { ...decayed, last_action_at: needRow.last_action_at };
    }

    const skRow = sk.rows[0] ?? {
      clout: 1,
      coding: 1,
      trading: 1,
      writing: 1,
      design: 1,
      security: 1,
    };
    const balRow = bal.rows[0] ?? { cash_cents: '0', debt_cents: '0' };
    const home = await loadMeHome(c, userId);
    const activeKind =
      home && (home.status === 'active' || home.status === 'overdue') ? home.kind : null;
    const dreamProgress = chRow ? await getDreamProgress(req.ctx, userId, chRow.dream_id) : null;
    return {
      user: {
        id: uRow.id,
        wallet: uRow.wallet,
        isSeeker: uRow.is_seeker,
        // The contract marks hasCharacter required on User. It is also
        // left in flags, which the client already reads.
        hasCharacter: chRow !== undefined,
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
            // The kind of the live lease; the character row keeps the birth home.
            homeId: activeKind ?? chRow.home_id,
            likenessJobId: chRow.likeness_job_id ?? null,
          }
        : null,
      needs: needRow,
      skills: skRow,
      cashCents: Number(balRow.cash_cents),
      debtCents: Number(balRow.debt_cents),
      ...debtSchedule(req.ctx, Number(balRow.debt_cents)),
      homeId: activeKind ?? chRow?.home_id ?? 'parents_basement',
      home,
      minerTier: uRow.miner_tier || 'none',
      flags: {
        // The first-session onboarding: new accounts start `active`, older ones read `done`.
        firstSession: await getFirstSession(req.ctx, userId),
        lotteryRolled: uRow.lottery_rolled_at !== null,
        hasCharacter: chRow !== undefined,
        // Optional per the contract: omitted when the dream's metric has no
        // data source yet, so the client keeps the bar hidden.
        ...(dreamProgress ? { dreamProgress } : {}),
      },
    };
  });
}

/**
 * B16: Check if user has an active shift (not completed)
 */
async function checkActiveShift(
  _req: import('fastify').FastifyRequest,
  userId: string,
): Promise<boolean> {
  // Import the shifts module to access the in-memory _shifts Map
  // Since shifts are in-memory, we need to check via the ShiftsService
  // For now, we'll import the internal _shifts Map
  // TODO M5: Move to Redis-based check
  const { _shifts } = await import('../../application/shifts.js');
  const now = Date.now();

  for (const shift of _shifts.values()) {
    if (shift.userId === userId && !shift.completed && shift.endsAt > now) {
      return true;
    }
  }
  return false;
}

/**
 * B16: Apply needs decay based on time elapsed since last_action_at
 */
function applyNeedsDecay(
  req: import('fastify').FastifyRequest,
  needs: {
    energy: number;
    hunger: number;
    fun: number;
    hygiene: number;
    sanity: number;
    last_action_at: Date;
  },
): { energy: number; hunger: number; fun: number; hygiene: number; sanity: number } {
  const cfg = req.ctx.configCache.load<{
    decayPerHour: Record<string, number>;
  }>('needs');

  const now = new Date();
  const elapsedMs = now.getTime() - needs.last_action_at.getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  const decayPerHour = cfg.decayPerHour;

  return {
    energy: Math.max(0, Math.min(100, needs.energy - (decayPerHour.energy ?? 0) * elapsedHours)),
    hunger: Math.max(0, Math.min(100, needs.hunger - (decayPerHour.hunger ?? 0) * elapsedHours)),
    fun: Math.max(0, Math.min(100, needs.fun - (decayPerHour.fun ?? 0) * elapsedHours)),
    hygiene: Math.max(0, Math.min(100, needs.hygiene - (decayPerHour.hygiene ?? 0) * elapsedHours)),
    sanity: Math.max(0, Math.min(100, needs.sanity - (decayPerHour.sanity ?? 0) * elapsedHours)),
  };
}
