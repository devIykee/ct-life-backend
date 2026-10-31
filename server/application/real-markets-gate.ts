/**
 * Who may use Real Markets, checked on every route in this order:
 *
 *   1. Location. The edge's IP-country header (Cloudflare `CF-IPCountry` by default) must
 *      name a country that is not on the deny-list (built-in provider restrictions plus
 *      REAL_MARKETS_BLOCKED_COUNTRIES). No trusted country fails closed. The country
 *      header is trusted ONLY when the request also carries REAL_MARKETS_EDGE_AUTH_HEADER
 *      with REAL_MARKETS_EDGE_AUTH_SECRET (added by the edge, e.g. a Cloudflare Transform
 *      Rule). Without a configured secret nothing is trusted, so a client talking to the
 *      origin directly cannot claim a country. Railway's edge adds no country header.
 *      -> 451 REAL_MARKETS_GEO_BLOCKED
 *   2. 18+. The character's age confirmation (`characters.age_confirmed_at`, `GET /me`
 *      `ageConfirmed`). -> 403 AGE_REQUIRED
 *   3. Wallet. Orders and positions use only the SIWS wallet the player signed in with
 *      (`users.wallet`). -> 403 FORBIDDEN {reason: wallet_required}
 *
 * IP geolocation is evaded by VPNs; it is a required control, not a guarantee
 * (docs/REAL-MARKETS.md, lawyer note).
 */
import { timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from './context.js';
import {
  AgeRequiredError,
  ForbiddenError,
  NotFoundError,
  RealMarketsGeoBlockedError,
} from '../shared/domain/errors.js';
import { decideGeo, type GeoDecision } from '../shared/domain/real-markets.js';
import type { Config } from '../shared/config/config.js';

export interface RequestGeo {
  /** The edge-reported country, or null when absent or untrusted. */
  readonly country: string | null;
  readonly region: string | null;
  /** True only when the request carried the configured edge secret. */
  readonly trusted: boolean;
  /**
   * Why the location was ignored: no edge secret on this deployment, or a request that did
   * not come through the edge (e.g. straight to the Railway origin). Null when trusted.
   */
  readonly untrustedReason: 'edge_not_configured' | 'not_via_edge' | null;
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function header(h: Headers, name: string): string | null {
  if (name === '') return null;
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param config - The loaded config.
 * @param headers - The request headers (Fastify lower-cases names).
 * @returns The location the edge reported, if it can be trusted.
 */
export function readGeo(config: Pick<Config, 'realMarkets'>, headers: Headers): RequestGeo {
  const rm = config.realMarkets;
  // Fail closed: with no edge secret configured, or a request without the right one, the
  // country/region headers are client-controlled and are ignored.
  if (rm.edgeAuthHeader === '' || rm.edgeAuthSecret === '') {
    return { country: null, region: null, trusted: false, untrustedReason: 'edge_not_configured' };
  }
  const sent = header(headers, rm.edgeAuthHeader);
  if (sent === null || !safeEqual(sent, rm.edgeAuthSecret)) {
    return { country: null, region: null, trusted: false, untrustedReason: 'not_via_edge' };
  }
  return {
    country: header(headers, rm.countryHeader),
    region: header(headers, rm.regionHeader),
    trusted: true,
    untrustedReason: null,
  };
}

/**
 * @param config - The loaded config.
 * @param geo - The request location.
 * @returns The decision (never throws).
 */
export function geoDecision(config: Pick<Config, 'realMarkets'>, geo: RequestGeo): GeoDecision {
  const rm = config.realMarkets;
  return decideGeo({
    country: geo.country,
    region: geo.region,
    blockedCountries: rm.blockedCountries,
    blockedRegions: rm.blockedRegions,
    allowUnknown: rm.allowUnknownCountry,
  });
}

export interface PlayerGate {
  readonly wallet: string | null;
  readonly ageConfirmed: boolean;
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @returns Their linked wallet (null when it is not a valid Solana key) and age flag.
 */
export async function loadPlayerGate(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
): Promise<PlayerGate> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string; age_confirmed_at: Date | null }>(
      `SELECT u.wallet, ch.age_confirmed_at FROM users u
         LEFT JOIN characters ch ON ch.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'user' });
  let wallet: string | null = null;
  try {
    wallet = new PublicKey(row.wallet).toBase58();
  } catch {
    wallet = null; // e.g. a 'deleted:' placeholder
  }
  return { wallet, ageConfirmed: row.age_confirmed_at !== null };
}

export interface GatePass {
  readonly wallet: string;
  readonly country: string;
}

/**
 * Run the three checks; throw the first one that fails.
 *
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @returns The caller's wallet and country.
 */
export async function passGate(
  ctx: Pick<AppContext, 'db' | 'config'>,
  userId: string,
  geo: RequestGeo,
): Promise<GatePass> {
  const g = geoDecision(ctx.config, geo);
  if (!g.allowed) {
    throw new RealMarketsGeoBlockedError({ country: g.country, reason: g.reason });
  }
  const p = await loadPlayerGate(ctx, userId);
  if (!p.ageConfirmed) throw new AgeRequiredError({ feature: 'realMarkets' });
  if (p.wallet === null) throw new ForbiddenError({ reason: 'wallet_required' });
  return { wallet: p.wallet, country: g.country };
}
