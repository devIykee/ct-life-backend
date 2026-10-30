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
