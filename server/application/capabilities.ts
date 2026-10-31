/**
 * Capability checks for feature routes and services.
 *
 * A feature PR merges dark: its routes call `assertCapabilityOn` (or use the
 * `requireCapability` preHandler in server/api/middleware/capability.ts) and answer
 * `503 CAPABILITY_OFF` until the operator adds the name to `CAPABILITIES_ON`.
 * The list is read once per process from the config loader; changing it needs a
 * redeploy, same as every other env switch.
 */
import type { Config } from '../shared/config/config.js';
import type { CapabilityName } from '../shared/domain/capabilities.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import {
  capabilitiesOffFor,
  capabilitiesOnFor,
  type ResolvedPlatform,
} from '../shared/domain/client-platform.js';

/** Anything that carries the loaded config (the AppContext does). */
export interface HasCapabilities {
  readonly config: Pick<Config, 'capabilities'>;
}

/**
 * @param ctx - The app context (or anything with `config.capabilities`).
 * @param name - The capability to check.
 * @returns True only when `name` is listed in `CAPABILITIES_ON`.
 */
export function isCapabilityOn(ctx: HasCapabilities, name: CapabilityName): boolean {
  return ctx.config.capabilities.on.has(name);
}

/**
 * Throw `503 CAPABILITY_OFF {capability}` unless `name` is on.
 *
 * @param ctx - The app context (or anything with `config.capabilities`).
 * @param name - The capability the caller needs.
 */
export function assertCapabilityOn(ctx: HasCapabilities, name: CapabilityName): void {
  if (!isCapabilityOn(ctx, name)) throw new CapabilityOffError({ capability: name });
}

/**
 * The context a request from `platform` runs with: the same services and config, except
 * `config.capabilities.on` is `CAPABILITIES_ON` minus `CAPABILITIES_OFF_BY_PLATFORM` for
 * that platform. Every gate that reads `req.ctx` (`requireCapability`, the inline
 * `assertCapabilityOn(req.ctx, ...)` calls, the `GET /config` blocks) then refuses or
 * hides the feature for that platform with no change at the call site. Workers and the
 * realtime rooms keep the unscoped context.
 *
 * One scoped object per (context, platform), built on first use. When the platform loses
 * nothing the base context itself is returned.
 *
 * @param ctx - The base context.
 * @param platform - The resolved platform.
 * @returns The context to hang on the request.
 */
export function contextForPlatform<T extends { readonly config: Config }>(
  ctx: T,
  platform: ResolvedPlatform,
): T {
  const kill = ctx.config.clients.capabilitiesOffByPlatform;
  if (capabilitiesOffFor(kill, platform).size === 0) return ctx;
  let perCtx = scopedContexts.get(ctx);
  if (perCtx === undefined) {
    perCtx = new Map();
    scopedContexts.set(ctx, perCtx);
  }
  const hit = perCtx.get(platform);
  if (hit !== undefined) return hit as T;
  const on = capabilitiesOnFor(ctx.config.capabilities.on, kill, platform);
  const scoped: T = {
    ...ctx,
    config: { ...ctx.config, capabilities: { ...ctx.config.capabilities, on } },
  };
  perCtx.set(platform, scoped);
  return scoped;
}

const scopedContexts = new WeakMap<object, Map<ResolvedPlatform, unknown>>();
