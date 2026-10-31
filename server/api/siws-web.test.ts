/**
 * SIWS with a web origin, end to end over HTTP with real Ed25519 signatures:
 * the challenge is bound to the requesting origin's domain / URI, verify accepts only
 * that pair, and a message signed for another site (or replayed) is refused.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, type TestApi } from './http-test-kit.js';
import { buildContext } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';

const WEB = 'https://play.ctlife.fun';
const LOCAL = 'http://localhost:8080';

interface Challenge {
  nonce: string;
  domain: string;
  statement: string;
  uri: string;
  chainId: string;
  issuedAt: string;
  expirationTime: string;
}

/** The SIWS text the verifier parses (application/auth.ts parseSIWSMessage). */
function siwsText(c: Challenge, address: string, over: Partial<Challenge> = {}): string {
  const m = { ...c, ...over };
  return [
    `${m.domain} wants you to sign in with your Solana account:`,
    address,
    '',
    m.statement,
    '',
    `URI: ${m.uri}`,
    'Version: 1',
    `Chain ID: ${m.chainId}`,
    `Nonce: ${m.nonce}`,
    `Issued At: ${m.issuedAt}`,
    `Expiration Time: ${m.expirationTime}`,
  ].join('\n');
}

/** Sign like a wallet: Ed25519 over the UTF-8 bytes. */
function signWith(kp: Keypair, text: string): { signedMessage: string; signature: string } {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(kp.secretKey.slice(0, 32)),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const bytes = Buffer.from(text, 'utf8');
  return {
    signedMessage: bytes.toString('base64'),
    signature: sign(null, bytes, key).toString('base64'),
  };
}

describe('SIWS domain allow-list', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await bootApi('', {
      WEB_ORIGINS: `${WEB},${LOCAL}`,
      SIWS_DOMAIN: 'ctlife.fun',
      SIWS_URI: 'https://ctlife.fun/',
    });
    // No network in tests: the Seeker token lookup answers "none".
    const helius = buildContext().helius as unknown as { sgtMintsFor: () => Promise<string[]> };
    helius.sgtMintsFor = async () => [];
  });

  afterAll(async () => {
    await api.stop();
  });

  async function challenge(origin?: string): Promise<{ status: number; body: Challenge }> {
    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/auth/challenge',
      headers: origin ? { origin } : {},
    });
    return { status: r.statusCode, body: r.json() as Challenge };
  }

  async function verify(
    kp: Keypair,
    c: Challenge,
    text: string,
    origin?: string,
  ): Promise<{ status: number; code?: string; reason?: string }> {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      headers: { 'idempotency-key': uuidv7(), ...(origin ? { origin } : {}) },
      payload: { address: kp.publicKey.toBase58(), nonce: c.nonce, ...signWith(kp, text) },
    });
    const b = r.json() as { error?: { code: string; details?: { reason?: string } } };
    return { status: r.statusCode, code: b.error?.code, reason: b.error?.details?.reason };
  }

  it('native (no Origin): the SIWS_DOMAIN / SIWS_URI challenge signs in as before', async () => {
    const { status, body } = await challenge();
    expect(status).toBe(200);
    expect(body).toMatchObject({ domain: 'ctlife.fun', uri: 'https://ctlife.fun/' });
    const kp = Keypair.generate();
    expect((await verify(kp, body, siwsText(body, kp.publicKey.toBase58()))).status).toBe(200);
  });

  it('web: the challenge carries the page host and origin URI, and signs in from that origin', async () => {
    const { body } = await challenge(WEB);
    expect(body).toMatchObject({ domain: 'play.ctlife.fun', uri: 'https://play.ctlife.fun/' });
    const kp = Keypair.generate();
    expect((await verify(kp, body, siwsText(body, kp.publicKey.toBase58()), WEB)).status).toBe(200);

    const local = (await challenge(LOCAL)).body;
    expect(local).toMatchObject({ domain: 'localhost:8080', uri: 'http://localhost:8080/' });
  });

  it('refuses a message a wallet signed on another site', async () => {
    const { body } = await challenge(WEB);
    const kp = Keypair.generate();
    const text = siwsText(body, kp.publicKey.toBase58(), {
      domain: 'evil.example',
      uri: 'https://evil.example/',
    });
    expect(await verify(kp, body, text, WEB)).toMatchObject({
      status: 401,
      code: 'SIGNATURE_INVALID',
    });
    // Even sent without an Origin (a relay off the browser).
    expect((await verify(kp, body, text)).code).toBe('SIGNATURE_INVALID');
  });

  it('a nonce only accepts the pair it was issued for', async () => {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    // Web nonce, native domain in the message.
    const web = (await challenge(WEB)).body;
    const swapped = siwsText(web, addr, { domain: 'ctlife.fun', uri: 'https://ctlife.fun/' });
    expect((await verify(kp, web, swapped)).code).toBe('SIGNATURE_INVALID');
    // Native nonce, web domain in the message.
    const native = (await challenge()).body;
    const toWeb = siwsText(native, addr, { domain: 'play.ctlife.fun', uri: `${WEB}/` });
    expect((await verify(kp, native, toWeb, WEB)).code).toBe('SIGNATURE_INVALID');
    // Right domain, other URI.
    const uri = siwsText(web, addr, { uri: `${WEB}/game` });
    expect((await verify(kp, web, uri, WEB)).code).toBe('SIGNATURE_INVALID');
  });

  it('verify from another allowed origin than the nonce was issued for is refused', async () => {
    const { body } = await challenge(WEB);
    const kp = Keypair.generate();
    expect(await verify(kp, body, siwsText(body, kp.publicKey.toBase58()), LOCAL)).toMatchObject({
      status: 401,
      code: 'SIGNATURE_INVALID',
      reason: 'origin_mismatch',
    });
  });

  it('an origin not on the list gets no challenge and cannot verify', async () => {
    const r = await api.app.inject({
      method: 'GET',
      url: '/v1/auth/challenge',
      headers: { origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'origin_not_allowed' },
    });
    const { body } = await challenge(WEB);
    const kp = Keypair.generate();
    expect(
      await verify(kp, body, siwsText(body, kp.publicKey.toBase58()), 'https://evil.example'),
    ).toMatchObject({ status: 403, code: 'FORBIDDEN', reason: 'origin_not_allowed' });
  });

  it('a signed message cannot be replayed', async () => {
    const { body } = await challenge(WEB);
    const kp = Keypair.generate();
    const text = siwsText(body, kp.publicKey.toBase58());
    expect((await verify(kp, body, text, WEB)).status).toBe(200);
    expect(await verify(kp, body, text, WEB)).toMatchObject({ status: 401, code: 'NONCE_INVALID' });
  });
});
