/**
 * Path-param validation helpers for Fastify routes.
 *
 * Master prompt rule: every user-controlled string that flows into a
 * SQL query must be either a UUID (validated here) or escaped by
 * the parameterised query layer. Anything else is a class of bugs
 * the M8 fuzz harness surfaced: an attacker (or the fuzzer) puts a
 * non-UUID `userId` in the URL and we hand a bare string to Postgres,
 * which then complains about "operator does not exist: uuid = text"
 * or a foreign-key constraint violation that should have been a
 * 404.
 *
 * `requireUuidParam(name)` returns a pre-handler hook that asserts
 * the named path parameter is a valid UUIDv1-v8 string. On failure
 * it throws `ValidationFailedError` (HTTP 400) so the global error
 * envelope maps it to a contract error code.
 */
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ValidationFailedError } from '../../shared/domain/errors.js';

/**
 * RFC 9562 UUID grammar — accepts v1 through v8 and the two
 * well-known UUIDs (nil, max). Matches the same regex Zod uses
 * for `z.string().uuid()`.
 */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * Build a pre-handler hook that validates one or more path params
 * as UUIDs. Unknown params are passed through (Fastify's path
 * parser already validates the route shape).
 *
 * @param names - One or more path-parameter names that must be UUIDs.
 * @returns A Fastify preHandler that throws 400 on bad input.
 */
export function requireUuidParam(...names: string[]): preHandlerHookHandler {
  return async (req: FastifyRequest): Promise<void> => {
    const params = (req.params ?? {}) as Record<string, string>;
    for (const n of names) {
      const v = params[n];
      if (v === undefined || !UUID_REGEX.test(v)) {
        throw new ValidationFailedError({ reason: `${n} must be a UUID`, value: v });
      }
    }
  };
}
