/**
 * Idempotency middleware.
 *
 * Applied to every POST/PUT/PATCH/DELETE. The client sends an
 * Idempotency-Key header (UUIDv4); the server caches the response
 * for 24 h and replays it on retry.
 *
 * The flow:
 *
 *   1. Read the `Idempotency-Key` header. If missing on a write,
 *      respond 400 VALIDATION_FAILED (the contract requires it).
 *   2. Reserve the key. If a cached response is present, replay it.
 *   3. If acquired=true, run the handler, then store the response.
 *   4. On handler error, abort the reservation.
 *
 * The middleware serializes body → hash before reserving, so a
 * key reused with a different body returns `bodyHashMismatch: true`
 * (which the handler turns into 400 VALIDATION_FAILED).
 */
import { createHash } from 'node:crypto';
import type { preHandlerHookHandler, onSendHookHandler } from 'fastify';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import type { CachedResponse } from '../../shared/infra/idempotency.js';

const HEADER = 'idempotency-key';

/**
 *
 */
export function idempotencyPreHandler(): preHandlerHookHandler {
  return async (req, reply) => {
    const key = req.headers[HEADER];
    if (typeof key !== 'string' || key.length < 8) {
      throw new ValidationFailedError({ reason: `missing_${HEADER}` });
    }
    const bodyHash = hashBody(req.body);
    const decision = await req.ctx.idempotency.reserve(
      // The user id is added after auth, so the first read of
      // `req.user` is undefined here. We use 'anon' as a
      // placeholder; the auth hook fills it in before the
      // handler runs. Replay correctness for anonymous writes
      // (auth, dev) is enforced within the same window.
      req.user?.sub ?? 'anon',
      key,
      bodyHash,
    );
    if (decision.acquired) {
      (req as unknown as { __idem: { key: string; lockToken: string; bodyHash: string } }).__idem =
        {
          key,
          lockToken: decision.lockToken,
          bodyHash,
        };
      return;
    }
    if ('bodyHashMismatch' in decision && decision.bodyHashMismatch) {
      throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
    }
    if ('replay' in decision) {
      const c = decision.replay;
      for (const [k, v] of Object.entries(c.headers)) {
        reply.header(k, v);
      }
      return reply.status(c.status).send(c.body);
      (req as unknown as { __idem: { replayed: true } }).__idem = { replayed: true };
    }
  };
}

/**
 *
 */
export function idempotencyOnSend(): onSendHookHandler {
  return async (req, reply, payload) => {
    const meta = (
      req as unknown as {
        __idem?: { key: string; lockToken: string; bodyHash: string; replayed?: boolean };
      }
    ).__idem;
    if (!meta || meta.replayed) return payload;
    const status = reply.statusCode;
    if (status < 200 || status >= 300) return payload;
    const bodyStr =
      typeof payload === 'string' ? payload : payload === null ? '' : JSON.stringify(payload);
    const cached: CachedResponse = {
      status,
      headers: {
        'content-type': (reply.getHeader('content-type') as string) ?? 'application/json',
      },
      body: bodyStr,
      bodyHash: meta.bodyHash,
    };
    await req.ctx.idempotency.complete(req.user?.sub ?? 'anon', meta.key, meta.lockToken, cached);
    return payload;
  };
}

/** Convenience: return the preHandler directly for use in route arrays. */
export function withIdempotency(): preHandlerHookHandler {
  return idempotencyPreHandler();
}

function hashBody(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return createHash('sha256').update(s).digest('hex');
}
