/**
 * JWT issuer test.
 *
 * Round-trips an access and refresh token through the issuer and
 * asserts the claims survive. Requires the local JWT key pair on
 * disk (created at M0; see .env JWT_PRIVATE_KEY).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { _resetConfigForTests } from './config/config.js';
import { createJwtIssuer } from './auth/jwt.js';
import { uuidv7 } from './domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

beforeAll(() => {
  _resetConfigForTests();
});

afterAll(() => {
  _resetConfigForTests();
});

describe('jwt issuer', () => {
  it('round-trips an access token', async () => {
    const issuer = createJwtIssuer();
    const userId = uuidv7();
    const wallet = 'So11111111111111111111111111111111111111111';
    const token = await issuer.signAccess(userId, wallet, true);
    const claims = await issuer.verifyAccess(token);
    expect(claims.sub).toBe(userId);
    expect(claims.wal).toBe(wallet);
    expect(claims.skr).toBe(true);
    expect(claims.typ).toBe('access');
  });

  it('round-trips a refresh token', async () => {
    const issuer = createJwtIssuer();
    const userId = uuidv7();
    const jti = uuidv7();
    const token = await issuer.signRefresh(userId, jti);
    const claims = await issuer.verifyRefresh(token);
    expect(claims.sub).toBe(userId);
    expect(claims.jti).toBe(jti);
    expect(claims.typ).toBe('refresh');
  });

  it('publishes a JWKS', async () => {
    const issuer = createJwtIssuer();
    const jwks = await issuer.jwks();
    // Public key not configured in M0; jwks returns empty.
    expect(Array.isArray(jwks.keys)).toBe(true);
  });
});
