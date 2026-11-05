/** Local Postgres + real signatures/JWT/HTTP; no external RPC or wallet transport. */
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { PublicKey, Keypair } from '@solana/web3.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, _resetDbForTests } from '../shared/db/pool.js';
import { loadConfig } from '../shared/config/config.js';
import { createJwtIssuer } from '../shared/auth/jwt.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { toErrorEnvelope } from '../shared/infra/error-envelope.js';
import { RedisIdempotencyStore } from '../shared/infra/idempotency.js';
import { ConfigCache, InMemoryNonceStore, type AppContext } from './context.js';
import { AuthService } from './auth.js';
import { deleteAccount } from './account-deletion.js';
import {
  completeLoginChallenge,
  issueLoginChallenge,
  listLoginIdentities,
  type LoginChallenge,
} from './wallet-auth.js';
import { completeWalletLink, issueWalletLinkChallenge, revokeWalletLink } from './wallet-links.js';
import * as proofs from './wallet-links-proofs.js';
import { registerAuthRoutes } from '../api/routes/auth.js';
import { registerCoreRoutes } from '../api/routes/core.js';
import { idempotencyOnSend } from '../api/middleware/idempotency.js';

let ctx: AppContext, app: FastifyInstance;
let admin: Pool;
const schema = 'wallet_auth_' + randomBytes(8).toString('hex');
let created = false;
const users = new Set<string>(),
  addresses = new Set<string>();
const values = new Map<string, string>();
const nearPermission = vi.fn(async () => true);
const origin = 'https://play.ctlife.fun';
const redis = {
  get: async (k: string) => values.get(k) ?? null,
  set: async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && values.has(k)) return null;
    values.set(k, v);
    return 'OK';
  },
  del: async (k: string) => Number(values.delete(k)),
  incr: async (k: string) => {
    const n = Number(values.get(k) ?? 0) + 1;
    values.set(k, String(n));
    return n;
  },
  decr: async (k: string) => {
    const n = Number(values.get(k) ?? 0) - 1;
    values.set(k, String(n));
    return n;
  },
  publish: vi.fn(async () => 1),
  expire: async () => 1,
  pttl: async () => 60000,
  eval: async () => [1, '99'],
};
beforeAll(async () => {
  const cfg = loadConfig();
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? cfg.databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  _resetDbForTests();
  const db = createDb({ options: `-c search_path=${schema},public` });
  const files = (await readdir('db/migrations')).filter((x) => x.endsWith('.sql')).sort();
  for (const file of files) {
    await db.pool.query(
      (await readFile('db/migrations/' + file, 'utf8')).split('-- Down Migration')[0]!,
    );
  }
  ctx = {
    config: {
      ...cfg,
      web: { origins: [origin, 'https://other.ctlife.fun'] },
      auth: { ...cfg.auth, devAuthEnabled: true },
      rateLimits: { ...cfg.rateLimits, loginPerIpPerMin: 10000 },
    },
    db,
    jwt: createJwtIssuer(),
    redis: { main: redis },
    idempotency: new RedisIdempotencyStore(redis as never),
    helius: { sgtMintsFor: vi.fn(async () => []) },
    nonces: new InMemoryNonceStore(),
    configCache: new ConfigCache(),
  } as unknown as AppContext;
  vi.spyOn(proofs, 'createNearFullAccessVerifier').mockReturnValue(nearPermission);
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.ctx = ctx;
    req.requestId = uuidv7();
  });
  app.addHook('onSend', idempotencyOnSend());
  app.setErrorHandler((err, _req, reply) => {
    const e = toErrorEnvelope(err);
    for (const [k, v] of Object.entries(e.headers)) reply.header(k, v);
    return reply.code(e.status).send(e.envelope);
  });
  registerAuthRoutes(app);
  registerCoreRoutes(app);
  await app.ready();
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  if (app) await app.close();
  if (ctx) await ctx.db.close();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if (admin) await admin.end();
});
const account = () => {
  const a = privateKeyToAccount(generatePrivateKey());
  addresses.add(a.address.toLowerCase());
  return a;
};
async function issue(
  a = account(),
  purpose: 'login' | 'enrolment' = 'login',
  owner: string | null = null,
) {
  const c = await issueLoginChallenge(
    ctx,
    purpose,
    owner,
    { network: 'eip155:4663', address: a.address },
    origin,
  );
  return { a, c, proof: { signature: await a.signMessage({ message: c.message }) } };
}
async function login(a = account()) {
  const f = await issue(a);
  const u = await new AuthService(ctx).walletAuthenticate(f.c.id, f.proof, origin);
  users.add(u.id);
  return { ...f, u };
}
const call = (method: 'GET' | 'POST', url: string, payload?: object, token?: string) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: {
      origin,
      'idempotency-key': uuidv7(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
async function paymentLink(uid: string, a: ReturnType<typeof account>) {
  const c = await issueWalletLinkChallenge(
    ctx,
    uid,
    { network: 'eip155:4663', address: a.address },
    origin,
  );
  return completeWalletLink(
    ctx,
    uid,
    c.id,
    { signature: await a.signMessage({ message: c.message }) },
    origin,
  );
}

async function siwsLogin(key = generateKeyPairSync('ed25519')) {
  const address = new PublicKey(
    key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ).toBase58();
  const service = new AuthService(ctx),
    c = await service.issueChallenge(address, origin);
  const message = [
    `${c.domain} wants you to sign in with your Solana account:`,
    address,
    '',
    c.statement,
    '',
    `URI: ${c.uri}`,
    `Version: ${c.version}`,
    `Chain ID: ${c.chainId}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expirationTime}`,
  ].join('\n');
  const u = await service.verifyAndAuthenticate(
    {
      address,
      nonce: c.nonce,
      signedMessage: Buffer.from(message).toString('base64'),
      signature: sign(null, Buffer.from(message), key.privateKey).toString('base64'),
    },
    origin,
  );
  users.add(u.id);
  return { u, key };
}
async function nearHttpLogin() {
  const key = generateKeyPairSync('ed25519'),
    pub = new PublicKey(
      key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ).toBase58();
  const address = 'http-' + randomBytes(8).toString('hex') + '.near';
  addresses.add(address);
  const r = await call('POST', '/v1/auth/wallet/challenge', { network: 'near:mainnet', address });
  expect(r.statusCode, r.body).toBe(201);
  const c = r.json<LoginChallenge>();
  const signature = sign(
    null,
    createHash('sha256')
      .update(proofs.serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, null))
      .digest(),
    key.privateKey,
  ).toString('base64');
  const v = await call('POST', '/v1/auth/wallet/verify', {
    challengeId: c.id,
    signature,
    publicKey: `ed25519:${pub}`,
  });
  expect(v.statusCode, v.body).toBe(200);
  const u = v.json();
  users.add(u.id);
  return { u };
}
describe('explicit wallet login credentials', () => {
  it('new/returning EVM login has a real null Solana wallet and stable UUID/identity; refresh preserves method and rotates once', async () => {
    const f = await login();
    expect(f.u.wallet).toBeNull();
    expect(f.u.isSeeker).toBe(false);
    expect(f.u.authMethod).toBe('wallet');
    const claims = await ctx.jwt.verifyAccess(f.u.accessToken);
    expect(claims).toMatchObject({
      sub: f.u.id,
      wal: null,
      lid: f.u.loginIdentity.id,
      am: 'wallet',
      skr: false,
    });
    const again = await login(f.a as ReturnType<typeof account>);
    expect(again.u.id).toBe(f.u.id);
    expect(again.u.loginIdentity).toEqual(f.u.loginIdentity);
    const rotated = await new AuthService(ctx).refresh(f.u.refreshToken);
    expect(rotated).toMatchObject({
      id: f.u.id,
      wallet: null,
      authMethod: 'wallet',
      loginIdentity: f.u.loginIdentity,
    });
    await expect(new AuthService(ctx).refresh(f.u.refreshToken)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    expect(ctx.helius.sgtMintsFor).not.toHaveBeenCalled();
  });
  it('concurrent first logins resolve one UUID and one identity', async () => {
    const a = account(),
      f1 = await issue(a),
      f2 = await issue(a);
    const r = await Promise.all(
      [f1, f2].map((f) => new AuthService(ctx).walletAuthenticate(f.c.id, f.proof, origin)),
    );
    r.forEach((x) => users.add(x.id));
    expect(r[0]!.id).toBe(r[1]!.id);
  });
  it('unsigned requests cannot fill a victim address and lock out its real holder; expiry cleanup is bounded', async () => {
    const a = account();
    for (let i = 0; i < 12; i++)
      await issueLoginChallenge(
        ctx,
        'login',
        null,
        { network: 'eip155:4663', address: a.address },
        origin,
      );
    const holder = await login(a);
    expect(holder.u.loginIdentity.address).toBe(a.address.toLowerCase());
    await ctx.db.pool.query(
      `INSERT INTO login_identity_challenges(id,purpose,network,address,nonce,message,domain,uri,issued_at,expires_at)
      SELECT gen_random_uuid(),'login','eip155:4663',$1,encode(gen_random_bytes(32),'hex'),'expired fixture','ctlife.fun','https://ctlife.fun/',now()-interval '10 minutes',now()-interval '5 minutes' FROM generate_series(1,120)`,
      [a.address.toLowerCase()],
    );
    const before = Number(
      (
        await ctx.db.pool.query(
          'SELECT count(*) AS n FROM login_identity_challenges WHERE expires_at<=now()',
        )
      ).rows[0].n,
    );
    await issue(a);
    const after = Number(
      (
        await ctx.db.pool.query(
          'SELECT count(*) AS n FROM login_identity_challenges WHERE expires_at<=now()',
        )
      ).rows[0].n,
    );
    expect(before - after).toBe(100);
  });
  it('same challenge concurrently succeeds once; response loss requires a fresh signature, never another account', async () => {
    const f = await issue();
    const rs = await Promise.allSettled(
      [1, 2].map(() => new AuthService(ctx).walletAuthenticate(f.c.id, f.proof, origin)),
    );
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const u = rs.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<AuthService['walletAuthenticate']>>
    >;
    users.add(u.value.id);
    const retry = await login(f.a);
    expect(retry.u.id).toBe(u.value.id);
  });
  it('rejects wrong signature, expiry, changed allowlist, wrong/missing Origin and wrong purpose/owner', async () => {
    const f = await issue(),
      other = account();
    await expect(
      completeLoginChallenge(
        ctx,
        'login',
        null,
        f.c.id,
        { signature: await other.signMessage({ message: f.c.message }) },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_PROOF_INVALID' });
    for (const requestOrigin of [undefined, 'https://other.ctlife.fun'])
      await expect(
        completeLoginChallenge(ctx, 'login', null, f.c.id, f.proof, requestOrigin),
      ).rejects.toMatchObject({ code: 'AUTH_ORIGIN_INVALID' });
    const denied = { ...ctx, config: { ...ctx.config, web: { origins: [] } } };
    await expect(
      completeLoginChallenge(denied, 'login', null, f.c.id, f.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_ORIGIN_INVALID' });
    await ctx.db.pool.query(
      "UPDATE login_identity_challenges SET issued_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=$1",
      [f.c.id],
    );
    await expect(
      completeLoginChallenge(ctx, 'login', null, f.c.id, f.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    const owner = await login(),
      enrol = await issue(other, 'enrolment', owner.u.id);
    await expect(
      completeLoginChallenge(ctx, 'login', null, enrol.c.id, enrol.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    await expect(
      completeLoginChallenge(ctx, 'enrolment', uuidv7(), enrol.c.id, enrol.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
  });
  it('a payment-only link (including revoked) requires explicit enrolment, preserves UUID/inventory and never authenticates its link proof', async () => {
    const owner = await login(),
      a = account(),
      link = await paymentLink(owner.u.id, a);
    await revokeWalletLink(ctx, owner.u.id, link.id);
    const f = await issue(a);
    await expect(
      completeLoginChallenge(ctx, 'login', null, f.c.id, f.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_ENROLMENT_REQUIRED' });
    const payment = await issueWalletLinkChallenge(
      ctx,
      owner.u.id,
      { network: 'eip155:4663', address: a.address },
      origin,
    );
    await expect(
      completeLoginChallenge(
        ctx,
        'login',
        null,
        payment.id,
        { signature: await a.signMessage({ message: payment.message }) },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    const enrol = await issue(a, 'enrolment', owner.u.id);
    const out = await completeLoginChallenge(
      ctx,
      'enrolment',
      owner.u.id,
      enrol.c.id,
      enrol.proof,
      origin,
    );
    expect(out.userId).toBe(owner.u.id);
    expect((await login(a)).u.id).toBe(owner.u.id);
    expect((await listLoginIdentities(ctx, owner.u.id)).map((x) => x.id)).toContain(
      out.identity.id,
    );
  });
  it('concurrent payment and login claims cannot assign different owners', async () => {
    const owner = await login(),
      a = account(),
      f = await issue(a);
    const p = await issueWalletLinkChallenge(
      ctx,
      owner.u.id,
      { network: 'eip155:4663', address: a.address },
      origin,
    );
    const rs = await Promise.allSettled([
      completeLoginChallenge(ctx, 'login', null, f.c.id, f.proof, origin),
      completeWalletLink(
        ctx,
        owner.u.id,
        p.id,
        { signature: await a.signMessage({ message: p.message }) },
        origin,
      ),
    ]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    if (rs[0]!.status === 'fulfilled') users.add(rs[0].value.userId);
    const ownership = await ctx.db.pool.query(
      'SELECT user_id FROM login_identities WHERE network=$1 AND address=$2 UNION SELECT user_id FROM economy_wallet_links WHERE network=$1 AND address=$2 AND ownership_released_at IS NULL',
      ['eip155:4663', a.address.toLowerCase()],
    );
    expect(ownership.rowCount).toBe(1);
  });
  it('two players cannot enrol the same login identity or link it for payments to another player', async () => {
    const u1 = await login(),
      u2 = await login(),
      a = account(),
      f1 = await issue(a, 'enrolment', u1.u.id),
      f2 = await issue(a, 'enrolment', u2.u.id);
    const rs = await Promise.allSettled([
      completeLoginChallenge(ctx, 'enrolment', u1.u.id, f1.c.id, f1.proof, origin),
      completeLoginChallenge(ctx, 'enrolment', u2.u.id, f2.c.id, f2.proof, origin),
    ]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const winner = rs.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{
      userId: string;
    }>;
    const loser = winner.value.userId === u1.u.id ? u2 : u1;
    await expect(paymentLink(loser.u.id, a)).rejects.toMatchObject({
      code: 'WALLET_LINK_IDENTITY_CONFLICT',
    });
  });
  it('NEP413 None signatures require finalized FullAccess ownership; FunctionCall/removed keys fail', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = new PublicKey(
        key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
      ).toBase58();
    const name = `auth-${randomBytes(8).toString('hex')}.near`;
    addresses.add(name);
    const c = await issueLoginChallenge(
      ctx,
      'login',
      null,
      { network: 'near:mainnet', address: name },
      origin,
    );
    expect(c.nearSignMessage).toMatchObject({
      callbackUrl: null,
      recipient: 'play.ctlife.fun',
      state: c.id,
    });
    const signature = sign(
      null,
      createHash('sha256')
        .update(proofs.serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, null))
        .digest(),
      key.privateKey,
    ).toString('base64');
    nearPermission.mockResolvedValueOnce(false);
    await expect(
      new AuthService(ctx).walletAuthenticate(
        c.id,
        { signature, publicKey: `ed25519:${pub}` },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_PROOF_INVALID' });
    const u = await new AuthService(ctx).walletAuthenticate(
      c.id,
      { signature, publicKey: `ed25519:${pub}` },
      origin,
    );
    users.add(u.id);
    expect(u).toMatchObject({
      wallet: null,
      loginIdentity: { network: 'near:mainnet', address: name },
    });
  });
  it('banned accounts cannot login or rotate a previously issued refresh token', async () => {
    const f = await login();
    await ctx.db.pool.query(
      'INSERT INTO user_moderation(user_id,banned_at) VALUES($1,now()) ON CONFLICT(user_id) DO UPDATE SET banned_at=now()',
      [f.u.id],
    );
    await expect(new AuthService(ctx).refresh(f.u.refreshToken)).rejects.toMatchObject({
      code: 'ACCOUNT_BANNED',
    });
    await expect(issue(f.a)).rejects.toMatchObject({ code: 'ACCOUNT_BANNED' });
  });
  it('deletion invalidates pre-ownership outstanding proofs; fresh login creates new UUID and relink keeps historical owner/ID', async () => {
    const a = account(),
      before = await issue(a),
      f = await login(a),
      link = await paymentLink(f.u.id, a);
    const itemId = uuidv7(),
      offerId = uuidv7(),
      orderId = uuidv7(),
      receiptId = uuidv7();
    await ctx.db.pool.query(
      "INSERT INTO cosmetic_items(item_id,slot,item_key,name,price_cents) VALUES($1,'top',$2,'Auth deletion fixture',100)",
      [itemId, uuidv7()],
    );
    await ctx.db.pool.query(
      "INSERT INTO economy_offers(offer_id,title,chain_id,asset_id,amount,recipient,terms_version,item_id) VALUES($1,'Auth fixture','eip155:4663','fixture-token','10',$2,'v1',$3)",
      [offerId, account().address.toLowerCase(), itemId],
    );
    await ctx.db.pool.query(
      `INSERT INTO economy_orders(order_id,user_id,wallet_link_id,offer_id,idempotency_key,chain_id,asset_id,amount,payer,recipient,terms_version,item_id,status,created_at,expires_at)
      SELECT $1,$2,$3,offer_id,$4,chain_id,asset_id,amount,$5,recipient,terms_version,item_id,'refund_due',now(),now()+interval '5 minutes' FROM economy_offers WHERE offer_id=$6`,
      [orderId, f.u.id, link.id, uuidv7(), a.address.toLowerCase(), offerId],
    );
    await ctx.db.pool.query(
      "INSERT INTO economy_receipts(receipt_id,order_id,chain_id,event_id,transaction_id,kind,disposition,evidence) VALUES($1,$2,'eip155:4663',$3,'fixture-tx','payment','refund_due','{}')",
      [receiptId, orderId, uuidv7()],
    );
    await deleteAccount(ctx, f.u.id);
    await expect(
      completeLoginChallenge(ctx, 'login', null, before.c.id, before.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_INVALID' });
    await expect(new AuthService(ctx).refresh(f.u.refreshToken)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    expect((await call('GET', '/v1/auth/identities', undefined, f.u.accessToken)).statusCode).toBe(
      401,
    );
    const fresh = await login(a);
    expect(fresh.u.id).not.toBe(f.u.id);
    expect(fresh.u.hasCharacter).toBe(false);
    const newLink = await paymentLink(fresh.u.id, a);
    expect(newLink.id).not.toBe(link.id);
    const old = (
      await ctx.db.pool.query(
        'SELECT user_id,ownership_released_at,revoked_at FROM economy_wallet_links WHERE id=$1',
        [link.id],
      )
    ).rows[0];
    expect(old.user_id).toBe(f.u.id);
    expect(old.ownership_released_at).not.toBeNull();
    expect(old.revoked_at).not.toBeNull();
    expect(
      (
        await ctx.db.pool.query(
          'SELECT user_id,wallet_link_id,status FROM economy_orders WHERE order_id=$1',
          [orderId],
        )
      ).rows[0],
    ).toEqual({ user_id: f.u.id, wallet_link_id: link.id, status: 'refund_due' });
    expect(
      (
        await ctx.db.pool.query(
          'SELECT order_id,disposition FROM economy_receipts WHERE receipt_id=$1',
          [receiptId],
        )
      ).rows[0],
    ).toEqual({ order_id: orderId, disposition: 'refund_due' });
  });
  it('a failed post-commit deletion cache write still attempts live-session publication and durable auth refuses the account', async () => {
    const f = await login();
    const broken = {
      ...ctx,
      redis: {
        ...ctx.redis,
        main: {
          ...redis,
          set: async () => {
            throw Error('fixture cache unavailable');
          },
        },
      },
    } as unknown as AppContext;
    redis.publish.mockClear();
    await expect(deleteAccount(broken, f.u.id)).rejects.toThrow('fixture cache unavailable');
    expect(redis.publish).toHaveBeenCalledWith(
      'ctl:account-deleted',
      JSON.stringify({ userId: f.u.id }),
    );
    expect((await call('GET', '/v1/auth/identities', undefined, f.u.accessToken)).statusCode).toBe(
      401,
    );
  });
  it('migration rollback refuses null-wallet accounts without deleting auth state', async () => {
    const f = await login();
    const sql = await readFile('db/migrations/1700000153000_login_identities.sql', 'utf8');
    const c = await ctx.db.connect();
    try {
      await c.query('BEGIN');
      await expect(c.query(sql.split('-- Down Migration')[1]!)).rejects.toThrow(/Cannot roll back/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await listLoginIdentities(ctx, f.u.id)).toHaveLength(1);
  });
  it('lost SGT refresh/sign-in returns the same false eligibility as the JWT, and competing SGT claims are typed conflicts', async () => {
    const helius = vi.mocked(ctx.helius.sgtMintsFor),
      sgt = Keypair.generate().publicKey.toBase58();
    helius.mockResolvedValue([sgt]);
    const f = await siwsLogin();
    expect(f.u.isSeeker).toBe(true);
    helius.mockResolvedValue([]);
    const gone = await siwsLogin(f.key);
    expect(gone.u.isSeeker).toBe(false);
    expect((await ctx.jwt.verifyAccess(gone.u.accessToken)).skr).toBe(false);
    expect((await new AuthService(ctx).refresh(gone.u.refreshToken)).isSeeker).toBe(false);
    helius.mockResolvedValue([Keypair.generate().publicKey.toBase58()]);
    const competing = await Promise.allSettled([siwsLogin(), siwsLogin()]);
    expect(competing.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      (competing.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'SGT_ALREADY_LINKED' });
    helius.mockResolvedValue([]);
  });
  it('legacy SIWS/dev users retain their wallet and UUID and old refresh tokens still resolve their Solana identity', async () => {
    const a = Keypair.generate().publicKey.toBase58(),
      service = new AuthService(ctx),
      u = await service.devAuthenticate(a);
    users.add(u.id);
    expect(u.wallet).toBe(a);
    expect(u.loginIdentity.network).toBe('solana:mainnet');
    expect((await service.devAuthenticate(a)).id).toBe(u.id);
    const old = await ctx.jwt.signRefresh(u.id, uuidv7());
    const r = await service.refresh(old);
    expect(r.id).toBe(u.id);
    expect(r.wallet).toBe(a);
  });
});

describe('wallet auth HTTP contract and playable first session', () => {
  it('auth routes strictly bind purpose, rate limits and identity list ownership', async () => {
    const a = account();
    const c = await call('POST', '/v1/auth/wallet/challenge', {
      network: 'eip155:4663',
      address: a.address,
    });
    expect(c.statusCode, c.body).toBe(201);
    const challenge = c.json<LoginChallenge>();
    const signature = await a.signMessage({ message: challenge.message });
    const bad = await call('POST', '/v1/auth/wallet/verify', {
      challengeId: challenge.id,
      signature,
      purpose: 'enrolment',
    });
    expect(bad.statusCode).toBe(400);
    const verified = await call('POST', '/v1/auth/wallet/verify', {
      challengeId: challenge.id,
      signature,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const body = verified.json();
    users.add(body.id);
    expect(body.user).toMatchObject({
      id: body.id,
      wallet: null,
      authMethod: 'wallet',
      loginIdentity: body.loginIdentity,
    });
    const identities = await call('GET', '/v1/auth/identities', undefined, body.accessToken);
    expect(identities.json().identities).toHaveLength(1);
    const other = await login();
    expect(
      (await call('GET', '/v1/auth/identities', undefined, other.u.accessToken)).json()
        .identities[0].id,
    ).not.toBe(body.loginIdentity.id);
    expect(
      (
        await call('POST', '/v1/auth/identities/challenge', {
          network: 'eip155:4663',
          address: a.address,
        })
      ).statusCode,
    ).toBe(401);
    values.set('rl:login:ip:127.0.0.1', '10000');
    expect(
      (
        await call('POST', '/v1/auth/wallet/challenge', {
          network: 'eip155:4663',
          address: a.address,
        })
      ).statusCode,
    ).toBe(429);
    values.delete('rl:login:ip:127.0.0.1');
  });
  it('enrolment requires fresh original authentication at issue and verify; refresh cannot renew old or missing authentication time', async () => {
    const f = await login(),
      a = account(),
      identity = f.u.loginIdentity,
      now = Math.floor(Date.now() / 1000);
    const claims = await ctx.jwt.verifyAccess(f.u.accessToken);
    expect(claims.auth_time).toBeGreaterThanOrEqual(now - 5);
    const fresh = await call(
      'POST',
      '/v1/auth/identities/challenge',
      { network: 'eip155:4663', address: a.address },
      f.u.accessToken,
    );
    expect(fresh.statusCode, fresh.body).toBe(201);
    const c = fresh.json<LoginChallenge>(),
      signature = await a.signMessage({ message: c.message });
    for (const authTime of [undefined, now - 601, now + 120]) {
      const token = await ctx.jwt.signAccess(f.u.id, null, false, identity.id, 'wallet', authTime);
      for (const [url, body] of [
        ['/v1/auth/identities/challenge', { network: 'eip155:4663', address: a.address }],
        ['/v1/auth/identities/verify', { challengeId: c.id, signature }],
      ] as const) {
        const r = await call('POST', url, body, token);
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json().error.code).toBe('AUTH_REAUTH_REQUIRED');
      }
      if (authTime === undefined || authTime < now) {
        const old = await ctx.jwt.signRefresh(f.u.id, uuidv7(), identity.id, 'wallet', authTime),
          rotated = await new AuthService(ctx).refresh(old);
        expect((await ctx.jwt.verifyAccess(rotated.accessToken)).auth_time).toBe(authTime);
        expect((await ctx.jwt.verifyRefresh(rotated.refreshToken)).auth_time).toBe(authTime);
        expect(
          (
            await call(
              'POST',
              '/v1/auth/identities/challenge',
              { network: 'eip155:4663', address: a.address },
              rotated.accessToken,
            )
          ).json().error.code,
        ).toBe('AUTH_REAUTH_REQUIRED');
      }
    }
    const added = await call(
      'POST',
      '/v1/auth/identities/verify',
      { challengeId: c.id, signature },
      f.u.accessToken,
    );
    expect(added.statusCode, added.body).toBe(200);
    const rotated = await new AuthService(ctx).refresh(f.u.refreshToken);
    expect((await ctx.jwt.verifyAccess(rotated.accessToken)).auth_time).toBe(claims.auth_time);
  });
  it('legacy-writer Solana rows can rotate pre-migration sessions without inventing recent authentication', async () => {
    const id = uuidv7(),
      wallet = Keypair.generate().publicKey.toBase58();
    users.add(id);
    await ctx.db.pool.query('INSERT INTO users(id,wallet) VALUES($1,$2)', [id, wallet]);
    const legacy = await ctx.jwt.signRefresh(id, uuidv7()),
      out = await new AuthService(ctx).refresh(legacy);
    expect(out).toMatchObject({
      id,
      wallet,
      authMethod: 'siws',
      loginIdentity: { network: 'solana:mainnet', address: wallet },
    });
    expect((await ctx.jwt.verifyAccess(out.accessToken)).auth_time).toBeUndefined();
    expect(
      (
        await call(
          'POST',
          '/v1/auth/identities/challenge',
          { network: 'eip155:4663', address: account().address },
          out.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_REAUTH_REQUIRED');
  });
  it('global verifier capacity rejects without consuming a challenge and releases capacity after invalid proofs', async () => {
    const f = await issue();
    values.set('rl:login:global', String(ctx.config.rateLimits.loginGlobalConcurrent));
    const busy = await call('POST', '/v1/auth/wallet/verify', { challengeId: f.c.id, ...f.proof });
    expect(busy.statusCode).toBe(503);
    values.delete('rl:login:global');
    const wrong = await account().signMessage({ message: f.c.message });
    const invalid = await call('POST', '/v1/auth/wallet/verify', {
      challengeId: f.c.id,
      signature: wrong,
    });
    expect(invalid.statusCode).toBe(401);
    expect(values.get('rl:login:global')).toBe('0');
    const valid = await call('POST', '/v1/auth/wallet/verify', { challengeId: f.c.id, ...f.proof });
    expect(valid.statusCode, valid.body).toBe(200);
    users.add(valid.json().id);
  });
  it.each(['EVM', 'NEAR'])(
    '%s-created account completes /me, birth lottery, character creation and refresh with stable inventory/session',
    async (network) => {
      const f = network === 'EVM' ? await login() : await nearHttpLogin();
      const me = await call('GET', '/v1/me', undefined, f.u.accessToken);
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().user.wallet).toBeNull();
      const roll = await call('POST', '/v1/lottery/roll', {}, f.u.accessToken);
      expect(roll.statusCode, roll.body).toBe(200);
      const made = await call(
        'POST',
        '/v1/characters',
        {
          alias: `wa${f.u.id.slice(-10)}`,
          look: {
            skinTone: 'tan',
            headId: 'head_a',
            hairId: 'hair_a',
            topId: 'top_a',
            bottomId: 'bottom_a',
            shoesId: 'shoes_a',
            accId: 'acc_none',
          },
          traitIds: ['fast_talker', 'deep_pockets'],
          dreamId: 'make_10k',
          tribeId: 'trencher',
          ageConfirmed: true,
        },
        f.u.accessToken,
      );
      expect(made.statusCode, made.body).toBe(201);
      const refresh = await call('POST', '/v1/auth/refresh', { refreshToken: f.u.refreshToken });
      expect(refresh.statusCode, refresh.body).toBe(200);
      expect(refresh.json().user).toMatchObject({
        id: f.u.id,
        wallet: null,
        hasCharacter: true,
        loginIdentity: f.u.loginIdentity,
      });
      if ('a' in f) {
        const again = await login(f.a as ReturnType<typeof account>);
        expect(again.u.hasCharacter).toBe(true);
        expect(again.u.id).toBe(f.u.id);
      }
    },
  );
});
