/**
 * Capabilities: which finished-but-dark features this deployment has turned on.
 *
 * The only input is the env `CAPABILITIES_ON` (a comma list of names, parsed in
 * the config loader). There are no code defaults: a name that is not in the list
 * is off, a name this build does not know is ignored, and an empty or missing
 * list turns everything off (fail closed). Feature PRs never edit a shared list;
 * the operator adds a name after the PR deploys.
 *
 * `GET /config` sends the result as `capabilities` and the derived
 * `competitionCapabilities` (read by v1.2 clients). Routes refuse with
 * `503 CAPABILITY_OFF` while their capability is off
 * (`server/application/capabilities.ts`, `server/api/middleware/capability.ts`).
 */

/** Phone apps. `capabilities.apps.<id>`; the client withholds the tile while false. */
export const CAPABILITY_APPS = ['beef', 'builder', 'vc', 'predict'] as const;

/** Features inside apps. `capabilities.features.<key>`. */
export const CAPABILITY_FEATURES = [
  'beefVoting',
  'districtStandings',
  'seasonResults',
  'sybilBail',
  'sybilBarn',
  'cabalRevoke',
  'xUnlink',
  'worldEvents',
  'homeMove',
  'visitorPolicy',
  'nftGallery',
  'paidCalls',
  'creatorMode',
  'seasonPassPurchase',
  'factory',
  'projectHq',
] as const;

/**
 * Names that are not sent under `capabilities` but drive a derived key:
 * `cabalInvites` turns on `competitionCapabilities.targetedCabalInvites`.
 */
export const CAPABILITY_EXTRAS = ['cabalInvites'] as const;

export type CapabilityApp = (typeof CAPABILITY_APPS)[number];
export type CapabilityFeature = (typeof CAPABILITY_FEATURES)[number];
export type CapabilityExtra = (typeof CAPABILITY_EXTRAS)[number];
export type CapabilityName = CapabilityApp | CapabilityFeature | CapabilityExtra;

const KNOWN: ReadonlySet<string> = new Set<string>([
  ...CAPABILITY_APPS,
  ...CAPABILITY_FEATURES,
  ...CAPABILITY_EXTRAS,
]);

/** @returns True when `name` is a capability this build knows. */
export function isKnownCapability(name: string): name is CapabilityName {
  return KNOWN.has(name);
}

export interface ParsedCapabilities {
  /** The known names that are on. */
  readonly on: ReadonlySet<CapabilityName>;
  /** Names in the list this build does not know (ignored; logged at boot). */
  readonly ignored: readonly string[];
}

/**
 * Parse `CAPABILITIES_ON`. Names are trimmed and matched exactly (case-sensitive,
 * so a typo stays off instead of guessing). Empty entries are skipped.
 *
 * @param raw - The env value, or undefined when unset.
 * @returns The names that are on and the names that were ignored.
 */
export function parseCapabilitiesOn(raw: string | undefined): ParsedCapabilities {
  const on = new Set<CapabilityName>();
  const ignored: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim();
    if (name === '') continue;
    if (isKnownCapability(name)) on.add(name);
    else if (!ignored.includes(name)) ignored.push(name);
  }
  return { on, ignored };
}

export interface CapabilitiesPayload {
  readonly capabilities: {
    readonly version: 2;
    readonly apps: Readonly<Record<CapabilityApp, boolean>>;
    readonly features: Readonly<Record<CapabilityFeature, boolean>>;
  };
  readonly competitionCapabilities: {
    readonly version: 1;
    readonly beefChallenges: boolean;
    readonly targetedCabalInvites: boolean;
  };
}

/**
 * The two `GET /config` blocks. Every known key is always present, so the client
 * can tell "off" from "this server predates the key" by the block's `version`.
 *
 * @param on - The capabilities that are on.
 * @returns `{ capabilities, competitionCapabilities }`.
 */
export function buildCapabilitiesPayload(on: ReadonlySet<CapabilityName>): CapabilitiesPayload {
  const apps = Object.fromEntries(CAPABILITY_APPS.map((id) => [id, on.has(id)])) as Record<
    CapabilityApp,
    boolean
  >;
  const features = Object.fromEntries(CAPABILITY_FEATURES.map((k) => [k, on.has(k)])) as Record<
    CapabilityFeature,
    boolean
  >;
  return {
    capabilities: { version: 2, apps, features },
    competitionCapabilities: {
      version: 1,
      beefChallenges: apps.beef,
      targetedCabalInvites: on.has('cabalInvites'),
    },
  };
}
