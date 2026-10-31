/**
 * Client platforms: which build is calling (Android APK, the web build, ...),
 * the per-platform minimum versions and the per-platform capability kill-list.
 *
 * Inputs are the request headers `X-Client-Platform` and `X-Client-Build` and the
 * env values `MIN_CLIENT_VERSION_BY_PLATFORM` and `CAPABILITIES_OFF_BY_PLATFORM`
 * (parsed here, read in the config loader). Pure: no I/O, no env reads.
 *
 * Resolution rules (`resolveClientPlatform`):
 *   - A request with an `Origin` header comes from a browser, so it is `web`
 *     whatever `X-Client-Platform` says. A web page cannot claim `android` to
 *     dodge the web kill-list. (A non-browser caller can still omit Origin and
 *     claim anything; the kill-list gates our official builds, it is not an
 *     anti-abuse control.)
 *   - Otherwise a known `X-Client-Platform` value is used.
 *   - An unknown value is `unknown`: it gets the union of every kill-list (fail closed).
 *   - No header and no Origin is a legacy native client (Android builds from before
 *     the header) or a server-to-server call. It is `android` for the version gate
 *     and is not scoped by any kill-list (`scoped: false`), so webhooks never lose a
 *     capability and old APKs behave exactly as before.
 */
import { isKnownCapability, type CapabilityName } from './capabilities.js';

/** Platforms a client may name in `X-Client-Platform`. */
export const CLIENT_PLATFORMS = ['android', 'web', 'desktop', 'ios'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** What a request resolves to: a known platform, or `unknown` for an unrecognised value. */
export type ResolvedPlatform = ClientPlatform | 'unknown';

/** The scalar floor every platform starts from (the B34 `minClientVersion`). */
export const BASE_MIN_CLIENT_VERSION = '1.0.0';

const PLATFORM_SET: ReadonlySet<string> = new Set<string>(CLIENT_PLATFORMS);

/** @returns True when `v` is a platform this build knows. */
export function isClientPlatform(v: string): v is ClientPlatform {
  return PLATFORM_SET.has(v);
}

export interface ClientIdentity {
  /** The platform the request is treated as. */
  readonly platform: ResolvedPlatform;
  /** The raw `X-Client-Platform` value (trimmed, lower-cased), or null when absent. */
  readonly declared: string | null;
  /** `X-Client-Build` when it is a plain non-negative integer, else null. */
  readonly build: number | null;
  /** True when per-platform kill-lists apply (the request named a platform or came from a browser). */
  readonly scoped: boolean;
}

/**
 * Work out which platform a request is.
 *
 * @param headers - The request's `x-client-platform`, `x-client-build` and `origin` values.
 * @param headers.platform - The raw `X-Client-Platform` header.
 * @param headers.build - The raw `X-Client-Build` header.
 * @param headers.origin - The raw `Origin` header.
 * @returns The resolved identity.
 */
export function resolveClientPlatform(headers: {
  platform?: string | string[] | undefined;
  build?: string | string[] | undefined;
  origin?: string | string[] | undefined;
}): ClientIdentity {
  const declaredRaw = first(headers.platform)?.trim().toLowerCase();
  const declared = declaredRaw === undefined || declaredRaw === '' ? null : declaredRaw;
  const origin = first(headers.origin);
  const fromBrowser = origin !== undefined && origin !== '';
  const build = parseClientBuild(first(headers.build));
  if (fromBrowser) return { platform: 'web', declared, build, scoped: true };
  if (declared === null) return { platform: 'android', declared, build, scoped: false };
  return {
    platform: isClientPlatform(declared) ? declared : 'unknown',
    declared,
    build,
    scoped: true,
  };
}

/**
 * @param raw - The `X-Client-Build` value.
 * @returns The build number when it is 1 to 15 digits, else null.
 */
export function parseClientBuild(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (!/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// --- versions --------------------------------------------------------------

const SEMVER_CORE = /^\d+\.\d+\.\d+$/;

/**
 * B34: compare dotted versions numerically (major.minor.patch; missing parts are 0,
 * non-numeric parts are 0, a pre-release suffix is ignored).
 *
 * @param clientVersion - The client's version.
 * @param minVersion - The minimum.
 * @returns True when `clientVersion` is below `minVersion`.
 */
export function isVersionBelow(clientVersion: string, minVersion: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((x) => parseInt(x, 10) || 0);
  const client = parse(clientVersion);
  const min = parse(minVersion);
  for (let i = 0; i < 3; i++) {
    if ((client[i] ?? 0) < (min[i] ?? 0)) return true;
    if ((client[i] ?? 0) > (min[i] ?? 0)) return false;
  }
  return false;
}

/** @returns The higher of two dotted versions. */
function maxVersion(a: string, b: string): string {
  return isVersionBelow(a, b) ? b : a;
}

/** Per-platform minimum versions from `MIN_CLIENT_VERSION_BY_PLATFORM`. */
export type MinVersionByPlatform = Readonly<Partial<Record<ClientPlatform, string>>>;

/**
 * The minimum version a platform must run. Never below `BASE_MIN_CLIENT_VERSION`.
 * `unknown` gets the base floor (it has no store or reload path we can name).
 *
 * @param byPlatform - The parsed env map.
 * @param platform - The resolved platform.
 * @returns The effective minimum version.
 */
export function minClientVersionFor(
  byPlatform: MinVersionByPlatform,
  platform: ResolvedPlatform,
): string {
  const set = platform === 'unknown' ? undefined : byPlatform[platform];
  return set === undefined ? BASE_MIN_CLIENT_VERSION : maxVersion(BASE_MIN_CLIENT_VERSION, set);
}

/** What an outdated client is told to do. */
export type UpdateAction = 'reload' | 'store';

/**
 * @param platform - The resolved platform.
 * @returns The update action and the message for that platform.
 */
export function updateInstructionFor(platform: ResolvedPlatform): {
  action: UpdateAction;
  message: string;
} {
  if (platform === 'web') {
    return { action: 'reload', message: 'A new version of CT Life is live. Reload the page.' };
  }
  return {
    action: 'store',
    message: 'This version of CT Life is out of date. Update the app to keep playing.',
  };
}

// --- env parsing -----------------------------------------------------------

/** Thrown for a malformed per-platform env value; the config loader names the variable. */
export class PlatformEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformEnvError';
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new PlatformEnvError('expected a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlatformEnvError('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse `MIN_CLIENT_VERSION_BY_PLATFORM`, e.g. `{"android":"1.5.0","web":"1.6.0"}`.
 * Empty = no per-platform floors. Unknown platforms and non `x.y.z` values throw, so a
 * typo stops the boot instead of silently letting old clients in.
 *
 * @param raw - The env value.
 * @returns The map.
 */
export function parseMinVersionByPlatform(raw: string | undefined): MinVersionByPlatform {
  const obj = parseJsonObject(raw);
  if (obj === null) return {};
  const out: Partial<Record<ClientPlatform, string>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isClientPlatform(k)) {
      throw new PlatformEnvError(
        `unknown platform "${k}" (expected ${CLIENT_PLATFORMS.join(', ')})`,
      );
    }
    if (typeof v !== 'string' || !SEMVER_CORE.test(v)) {
      throw new PlatformEnvError(`"${k}" must be a version like "1.6.0"`);
    }
    out[k] = v;
  }
  return out;
}

export interface CapabilitiesOffByPlatform {
  /** Known capability names turned off per platform. */
  readonly off: Readonly<Partial<Record<ClientPlatform, ReadonlySet<CapabilityName>>>>;
  /** Names this build does not know (ignored; logged at boot), as `platform:name`. */
  readonly ignored: readonly string[];
}

/**
 * Parse `CAPABILITIES_OFF_BY_PLATFORM`, e.g. `{"web":["paidCalls","seasonPassPurchase"]}`.
 * Empty = no platform loses anything. Unknown platforms or a non-array value throw; an
 * unknown capability name is ignored and reported (same rule as `CAPABILITIES_ON`).
 *
 * @param raw - The env value.
 * @returns The parsed kill-list.
 */
export function parseCapabilitiesOffByPlatform(raw: string | undefined): CapabilitiesOffByPlatform {
  const obj = parseJsonObject(raw);
  if (obj === null) return { off: {}, ignored: [] };
  const off: Partial<Record<ClientPlatform, ReadonlySet<CapabilityName>>> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!isClientPlatform(k)) {
      throw new PlatformEnvError(
        `unknown platform "${k}" (expected ${CLIENT_PLATFORMS.join(', ')})`,
      );
    }
    if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) {
      throw new PlatformEnvError(`"${k}" must be an array of capability names`);
    }
    const names = new Set<CapabilityName>();
    for (const n of v as string[]) {
      const name = n.trim();
      if (isKnownCapability(name)) names.add(name);
      else if (name !== '') ignored.push(`${k}:${name}`);
    }
    off[k] = names;
  }
  return { off, ignored };
}

/**
 * The capabilities a platform loses. `unknown` loses the union of every list.
 *
 * @param kill - The parsed kill-list.
 * @param platform - The resolved platform.
 * @returns The names that are off for this platform.
 */
export function capabilitiesOffFor(
  kill: CapabilitiesOffByPlatform,
  platform: ResolvedPlatform,
): ReadonlySet<CapabilityName> {
  if (platform !== 'unknown') return kill.off[platform] ?? new Set<CapabilityName>();
  const all = new Set<CapabilityName>();
  for (const names of Object.values(kill.off)) for (const n of names ?? []) all.add(n);
  return all;
}

/**
 * `CAPABILITIES_ON` minus the platform's kill-list.
 *
 * @param on - The deployment's capabilities.
 * @param kill - The parsed kill-list.
 * @param platform - The resolved platform.
 * @returns The capabilities on for this platform.
 */
export function capabilitiesOnFor(
  on: ReadonlySet<CapabilityName>,
  kill: CapabilitiesOffByPlatform,
  platform: ResolvedPlatform,
): ReadonlySet<CapabilityName> {
  const off = capabilitiesOffFor(kill, platform);
  if (off.size === 0) return on;
  return new Set([...on].filter((n) => !off.has(n)));
}
