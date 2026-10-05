/**
 * JWT signer and verifier (RS256).
 *
 * The backend mints an access token (15 min) and a refresh token
 * (30 days) per authenticated user. Both are signed with the RS256
 * private key loaded from `JWT_PRIVATE_KEY_PEM`. The public key is
 * served at `/v1/auth/jwks` for the client (or another service) to
 * verify offline.
 *
 * The `kid` (key ID) is in the JWT header so the same backend can
 * rotate to a new key by publishing both keys in JWKS. The current
 * implementation only ships one key; rotation is a M3 task.
 *
 * Claims:
 *   sub:  user UUID
 *   wal:  base58 wallet public key
 *   skr:  isSeeker (boolean)
 *   iat, exp: standard
 *   typ:  "access" | "refresh"
 */
import {
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { loadConfig } from '../config/config.js';

export interface AccessClaims extends JWTPayload {
  readonly sub: string;
  readonly wal: string;
  readonly skr: boolean;
  readonly typ: 'access';
}

export interface RefreshClaims extends JWTPayload {
  readonly sub: string;
  readonly jti: string;
  readonly typ: 'refresh';
}

export interface JwtIssuer {
  signAccess(userId: string, wallet: string, isSeeker: boolean): Promise<string>;
  signRefresh(userId: string, jti: string): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
  verifyRefresh(token: string): Promise<RefreshClaims>;
  jwks(): Promise<{
    keys: Array<{ kid: string; kty: string; alg: string; use: string; n: string; e: string }>;
  }>;
}

let cached: JwtIssuer | null = null;

/**
 * Build the process-wide JWT issuer. Reads the RS256 key pair from
 * `Config.jwt` and memoises. Subsequent calls return the same
 * instance.
 */
export function createJwtIssuer(): JwtIssuer {
  if (cached !== null) return cached;
  const cfg = loadConfig();
  // The private key is always required. The public key is optional —
  // if the M0 contract ships only the private key, we derive the
  // public key from it (Node's `createPublicKey({ key, format: 'jwk' })`
  // supports this for RSA keys). This means a single `JWT_PRIVATE_KEY`
  // env var is enough for both signing and verifying.
  const privateKeyPromise = importPKCS8(cfg.jwt.privateKeyPem, 'RS256');
  const publicKeyPromise: Promise<KeyLike> = cfg.jwt.publicKeyPem
    ? importSPKI(cfg.jwt.publicKeyPem, 'RS256')
    : (async () => {
        const privKeyObject = createPublicKey(cfg.jwt.privateKeyPem) as KeyObject;
        const jwk = await exportJWK(privKeyObject as unknown as KeyLike);
        // Re-create a public KeyObject from the JWK and export as SPKI PEM.
        const pubKeyObject = createPublicKey({ key: jwk as unknown as Buffer, format: 'jwk' });
        const pubPem = pubKeyObject.export({ type: 'spki', format: 'pem' }) as string;
        return (await importSPKI(pubPem, 'RS256')) as KeyLike;
      })();

  const issuer: JwtIssuer = {
    async signAccess(userId, wallet, isSeeker) {
      const key = await privateKeyPromise;
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({ wal: wallet, skr: isSeeker, typ: 'access' })
        .setProtectedHeader({ alg: 'RS256', kid: cfg.jwt.kid, typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(cfg.jwt.issuer)
        .setAudience(cfg.jwt.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + cfg.jwt.accessTtlSec)
        .sign(key);
    },
    async signRefresh(userId, jti) {
      const key = await privateKeyPromise;
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({ typ: 'refresh' })
        .setProtectedHeader({ alg: 'RS256', kid: cfg.jwt.kid, typ: 'JWT' })
        .setSubject(userId)
        .setJti(jti)
        .setIssuer(cfg.jwt.issuer)
        .setAudience(cfg.jwt.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + cfg.jwt.refreshTtlSec)
        .sign(key);
    },
    async verifyAccess(token) {
      const key = await publicKeyPromise;
      const { payload } = await jwtVerify<AccessClaims>(token, key, {
        issuer: cfg.jwt.issuer,
        audience: cfg.jwt.audience,
        algorithms: ['RS256'],
      });
      if (payload.typ !== 'access') {
        throw new Error('Not an access token');
      }
      return payload;
    },
    async verifyRefresh(token) {
      const key = await publicKeyPromise;
      const { payload } = await jwtVerify<RefreshClaims>(token, key, {
        issuer: cfg.jwt.issuer,
        audience: cfg.jwt.audience,
        algorithms: ['RS256'],
      });
      if (payload.typ !== 'refresh') {
        throw new Error('Not a refresh token');
      }
      return payload;
    },
    async jwks() {
      const key = await publicKeyPromise;
      const jwk = await exportJWK(key as KeyLike);
      return {
        keys: [
          {
            kid: cfg.jwt.kid,
            kty: jwk.kty ?? 'RSA',
            alg: 'RS256',
            use: 'sig',
            n: jwk.n ?? '',
            e: jwk.e ?? '',
          },
        ],
      };
    },
  };
  cached = issuer;
  return issuer;
}
