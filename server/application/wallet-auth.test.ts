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
  completeLoginChallenge as completeLoginChallengeRaw,
  issueLoginChallenge,
  listLoginIdentities,
  type LoginChallenge,
} from './wallet-auth.js';
import { completeWalletLink, issueWalletLinkChallenge, revokeWalletLink } from './wallet-links.js';
import * as proofs from './wallet-links-proofs.js';
import { registerAuthRoutes } from '../api/routes/auth.js';
import { registerCoreRoutes } from '../api/routes/core.js';
import { idempotencyOnSend } from '../api/middleware/idempotency.js';
import {
  resolveLoginCredential,
  invalidLoginCredentials,
  LOGIN_IDENTITY_REVOKED_CHANNEL,
} from './login-credentials.js';
import {
  completePrimarySolanaChallenge,
  type PrimarySolanaChallenge,
} from './wallet-auth-lifecycle.js';

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
  eval: async (script: string, _keys: number, key?: string, owner?: string) => {
    if (script.includes('ctl-refresh-release'))
      return key && values.get(key) === owner ? Number(values.delete(key)) : 0;
    return [1, '99'];
  },
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
const actors = new Map<string, import('../shared/auth/jwt.js').AccessClaims>();
const completeLoginChallenge = (...args: Parameters<typeof completeLoginChallengeRaw>) => {
  if (args[1] === 'enrolment' && args[7] === undefined) args[7] = actors.get(args[2] ?? '');
  return completeLoginChallengeRaw(...args);
};
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
    owner === null ? undefined : actors.get(owner),
  );
  return { a, c, proof: { signature: await a.signMessage({ message: c.message }) } };
}
async function login(a = account()) {
  const f = await issue(a);
  const u = await new AuthService(ctx).walletAuthenticate(f.c.id, f.proof, origin);
  users.add(u.id);
  actors.set(u.id, await ctx.jwt.verifyAccess(u.accessToken));
  return { ...f, u };
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, token?: string) =>
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

async function enrolWithToken(token: string, a = account()) {
  const issued = await call(
    'POST',
    '/v1/auth/identities/challenge',
    { network: 'eip155:4663', address: a.address },
    token,
  );
  expect(issued.statusCode, issued.body).toBe(201);
  const c = issued.json<LoginChallenge>();
  const verified = await call(
    'POST',
    '/v1/auth/identities/verify',
    { challengeId: c.id, signature: await a.signMessage({ message: c.message }) },
    token,
  );
  expect(verified.statusCode, verified.body).toBe(200);
  return { a, identity: verified.json().identity };
}
function solanaKey() {
  const key = generateKeyPairSync('ed25519');
  return {
    key,
    address: new PublicKey(
      key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ).toBase58(),
  };
}
async function primaryProof(token: string, key = solanaKey()) {
  const issued = await call(
    'POST',
    '/v1/auth/primary-solana/challenge',
    { address: key.address },
    token,
  );
  expect(issued.statusCode, issued.body).toBe(201);
  const c = issued.json<PrimarySolanaChallenge>();
  return {
    ...key,
    c,
    signature: sign(null, Buffer.from(c.message), key.key.privateKey).toString('base64'),
  };
}

describe('credential lifecycle and durable session generations', () => {
  it('returns retryable503 for durable REST/refresh outage without consuming the existing refresh', async () => {
    const f = await login();
    const lookup = vi
      .spyOn(ctx.db, 'withConnection')
      .mockRejectedValueOnce(Error('fixture DB unavailable'));
    const response = await call('GET', '/v1/auth/identities', undefined, f.u.accessToken);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error.code).toBe('AUTH_STATE_UNAVAILABLE');
    lookup.mockRejectedValueOnce(Error('fixture DB unavailable'));
    const rotated = await call('POST', '/v1/auth/refresh', { refreshToken: f.u.refreshToken });
    expect(rotated.statusCode, rotated.body).toBe(503);
    expect(rotated.json().error.code).toBe('AUTH_STATE_UNAVAILABLE');
    lookup.mockRestore();
    expect((await new AuthService(ctx).refresh(f.u.refreshToken)).id).toBe(f.u.id);
  });
  it('releases only its own failed pre-response refresh reservation, including a lost commit acknowledgement', async () => {
    const f = await login();
    const client = await ctx.db.connect();
    const actualQuery = client.query.bind(client);
    const query = vi.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
      const result = await (actualQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      if (args[0] === 'COMMIT') throw Error('fixture commit acknowledgement lost');
      return result;
    }) as typeof client.query);
    const connect = vi.spyOn(ctx.db, 'connect').mockResolvedValueOnce(client);
    const response = await call('POST', '/v1/auth/refresh', { refreshToken: f.u.refreshToken });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error.code).toBe('AUTH_STATE_UNAVAILABLE');
    query.mockRestore();
    connect.mockRestore();
    expect((await new AuthService(ctx).refresh(f.u.refreshToken)).id).toBe(f.u.id);
  });
  it('a concurrent refresh loser cannot clear the successful attempt single-use marker', async () => {
    const f = await login();
    const results = await Promise.allSettled(
      [1, 2].map(() => new AuthService(ctx).refresh(f.u.refreshToken)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(new AuthService(ctx).refresh(f.u.refreshToken)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
  });

  it('returns 401 for a signed refresh with malformed generation claims', async () => {
    const f = await login();
    const token = await ctx.jwt.signRefresh(
      f.u.id,
      uuidv7(),
      f.u.loginIdentity.id,
      'wallet',
      f.u.authenticatedAt!,
      -1,
    );
    const response = await call('POST', '/v1/auth/refresh', { refreshToken: token });
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses the last credential, current credential, primary Solana and another player target', async () => {
    const f = await login();
    expect(
      (
        await call(
          'DELETE',
          `/v1/auth/identities/${f.u.loginIdentity.id}`,
          undefined,
          f.u.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_LAST_IDENTITY');
    await enrolWithToken(f.u.accessToken);
    expect(
      (
        await call(
          'DELETE',
          `/v1/auth/identities/${f.u.loginIdentity.id}`,
          undefined,
          f.u.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_USE_ANOTHER_IDENTITY');
    const other = await login();
    expect(
      (
        await call(
          'DELETE',
          `/v1/auth/identities/${other.u.loginIdentity.id}`,
          undefined,
          f.u.accessToken,
        )
      ).statusCode,
    ).toBe(404);
    const legacy = await siwsLogin();
    expect(
      (
        await call(
          'DELETE',
          `/v1/auth/identities/${legacy.u.loginIdentity.id}`,
          undefined,
          legacy.u.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_PRIMARY_WALLET_IMMUTABLE');
  });
  it('revokes only the target sessions, preserves payment ownership, and re-enrolment never revives old tokens', async () => {
    const owner = await login(),
      added = await enrolWithToken(owner.u.accessToken),
      target = await login(added.a);
    const payment = await paymentLink(owner.u.id, added.a);
    const targetClaims = await ctx.jwt.verifyAccess(target.u.accessToken),
      ownerClaims = await ctx.jwt.verifyAccess(owner.u.accessToken);
    const before = await resolveLoginCredential(ctx.db, targetClaims),
      retained = await resolveLoginCredential(ctx.db, ownerClaims);
    const removed = await call(
      'DELETE',
      `/v1/auth/identities/${added.identity.id}`,
      undefined,
      owner.u.accessToken,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(redis.publish).toHaveBeenCalledWith(
      LOGIN_IDENTITY_REVOKED_CHANNEL,
      JSON.stringify({ userId: owner.u.id, identityId: added.identity.id, minVersion: 1 }),
    );
    const rejected = await call('GET', '/v1/auth/identities', undefined, target.u.accessToken);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe('AUTH_IDENTITY_REVOKED');
    await expect(new AuthService(ctx).refresh(target.u.refreshToken)).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_REVOKED',
    });
    expect(await invalidLoginCredentials(ctx.db, [before, retained, before])).toEqual([before]);
    expect(
      (await call('GET', '/v1/auth/identities', undefined, owner.u.accessToken)).json().identities,
    ).toHaveLength(1);
    const old = await issue(added.a);
    await expect(
      new AuthService(ctx).walletAuthenticate(old.c.id, old.proof, origin),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_REVOKED' });
    expect(
      (
        await ctx.db.pool.query(
          'SELECT user_id,revoked_at,ownership_released_at FROM economy_wallet_links WHERE id=$1',
          [payment.id],
        )
      ).rows[0],
    ).toEqual({ user_id: owner.u.id, revoked_at: null, ownership_released_at: null });
    const again = await enrolWithToken(owner.u.accessToken, added.a),
      fresh = await login(added.a);
    expect(again.identity.id).toBe(added.identity.id);
    expect(fresh.u.id).toBe(owner.u.id);
    expect(fresh.u.loginIdentityVersion).toBe(1);
    expect((await ctx.jwt.verifyAccess(fresh.u.accessToken)).liv).toBe(1);
    await expect(resolveLoginCredential(ctx.db, targetClaims)).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_REVOKED',
    });
    const legacyClaims = { ...targetClaims };
    delete legacyClaims.liv;
    await expect(resolveLoginCredential(ctx.db, legacyClaims)).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_REVOKED',
    });
    expect(
      await resolveLoginCredential(ctx.db, await ctx.jwt.verifyAccess(fresh.u.accessToken)),
    ).toMatchObject({ version: 1 });
    const refresh = await new AuthService(ctx).refresh(fresh.u.refreshToken);
    expect(refresh.loginIdentityVersion).toBe(1);
    expect(refresh.authenticatedAt).toBe(fresh.u.authenticatedAt);
  });
  it('serializes mutual revocation so one retained credential remains', async () => {
    const a = await login(),
      b = await enrolWithToken(a.u.accessToken),
      signedB = await login(b.a);
    const results = await Promise.all([
      call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, a.u.accessToken),
      call(
        'DELETE',
        `/v1/auth/identities/${a.u.loginIdentity.id}`,
        undefined,
        signedB.u.accessToken,
      ),
    ]);
    expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(1);
    expect(await listLoginIdentities(ctx, a.u.id)).toHaveLength(1);
  });
  it('binds pending enrolment to its initiating credential and invalidates it on revocation', async () => {
    const owner = await login(),
      b = await enrolWithToken(owner.u.accessToken),
      signedB = await login(b.a),
      c = account();
    const issued = await call(
      'POST',
      '/v1/auth/identities/challenge',
      { network: 'eip155:4663', address: c.address },
      signedB.u.accessToken,
    );
    const challenge = issued.json<LoginChallenge>(),
      body = {
        challengeId: challenge.id,
        signature: await c.signMessage({ message: challenge.message }),
      };
    expect(
      (await call('POST', '/v1/auth/identities/verify', body, owner.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_CHALLENGE_INVALID');
    await call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, owner.u.accessToken);
    expect(
      (await call('POST', '/v1/auth/identities/verify', body, signedB.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_IDENTITY_REVOKED');
    expect(
      (await call('POST', '/v1/auth/identities/verify', body, owner.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_CHALLENGE_INVALID');
    expect(await listLoginIdentities(ctx, owner.u.id)).toHaveLength(1);
  });
  it('requires recent authentication for removal and does not renew it on refresh', async () => {
    const owner = await login(),
      b = await enrolWithToken(owner.u.accessToken),
      now = Math.floor(Date.now() / 1000);
    for (const time of [undefined, now - 601, now + 31]) {
      const token = await ctx.jwt.signAccess(
        owner.u.id,
        null,
        false,
        owner.u.loginIdentity.id,
        'wallet',
        time,
      );
      const result = await call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, token);
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('AUTH_REAUTH_REQUIRED');
    }
  });
  it('commits despite pubsub failure, repeated removal does not advance generation, and events remain owner-scoped', async () => {
    const owner = await login(),
      b = await enrolWithToken(owner.u.accessToken),
      other = await login();
    redis.publish.mockRejectedValueOnce(Error('fixture pubsub unavailable'));
    for (let i = 0; i < 2; i++)
      expect(
        (
          await call(
            'DELETE',
            `/v1/auth/identities/${b.identity.id}`,
            undefined,
            owner.u.accessToken,
          )
        ).statusCode,
      ).toBe(204);
    expect(
      (
        await ctx.db.pool.query('SELECT session_version FROM login_identities WHERE id=$1', [
          b.identity.id,
        ])
      ).rows[0].session_version,
    ).toBe(1);
    const events = (await call('GET', '/v1/auth/identities', undefined, owner.u.accessToken)).json()
      .securityEvents;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      identityId: b.identity.id,
      kind: 'identity_revoked',
      network: 'eip155:4663',
    });
    expect(Object.keys(events[0]).sort()).toEqual([
      'createdAt',
      'id',
      'identityId',
      'kind',
      'network',
    ]);
    expect(
      (await call('GET', '/v1/auth/identities', undefined, other.u.accessToken)).json()
        .securityEvents,
    ).toEqual([]);
  });
  it('batches bounded distinct scopes and propagates database failures', async () => {
    const owner = await login(),
      scope = await resolveLoginCredential(ctx.db, await ctx.jwt.verifyAccess(owner.u.accessToken));
    const scopes = Array.from({ length: 260 }, (_, version) => ({ ...scope, version }));
    expect(await invalidLoginCredentials(ctx.db, [...scopes, scope])).toHaveLength(259);
    const broken = {
      ...ctx.db,
      withConnection: vi.fn(async () => {
        throw Error('fixture database down');
      }),
    };
    await expect(invalidLoginCredentials(broken, [scope])).rejects.toThrow('fixture database down');
  });
});

describe('explicit primary Solana attachment', () => {
  it('can remove a NEAR credential after fresh login with a retained EVM identity', async () => {
    const near = await nearHttpLogin(),
      retained = await enrolWithToken(near.u.accessToken),
      signed = await login(retained.a);
    expect(
      (
        await call(
          'DELETE',
          `/v1/auth/identities/${near.u.loginIdentity.id}`,
          undefined,
          signed.u.accessToken,
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await call('GET', '/v1/auth/identities', undefined, near.u.accessToken)).json().error.code,
    ).toBe('AUTH_IDENTITY_REVOKED');
    expect((await listLoginIdentities(ctx, near.u.id))[0]!.id).toBe(signed.u.loginIdentity.id);
  });
  it('a deleted owner releases a Solana address without moving its historical payment link', async () => {
    const old = await siwsLogin();
    const challenge = await issueWalletLinkChallenge(
      ctx,
      old.u.id,
      { network: 'solana:mainnet', address: old.u.wallet! },
      origin,
    );
    const link = await completeWalletLink(
      ctx,
      old.u.id,
      challenge.id,
      {
        signature: sign(null, Buffer.from(challenge.message), old.key.privateKey).toString(
          'base64',
        ),
      },
      origin,
    );
    await deleteAccount(ctx, old.u.id);
    const fresh = await login(),
      p = await primaryProof(fresh.u.accessToken, { key: old.key, address: old.u.wallet! });
    const receipt = await call(
      'POST',
      '/v1/auth/primary-solana/verify',
      { challengeId: p.c.id, signature: p.signature },
      fresh.u.accessToken,
    );
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json().userId).toBe(fresh.u.id);
    const historic = (
      await ctx.db.pool.query(
        'SELECT user_id,ownership_released_at FROM economy_wallet_links WHERE id=$1',
        [link.id],
      )
    ).rows[0];
    expect(historic.user_id).toBe(old.u.id);
    expect(historic.ownership_released_at).not.toBeNull();
    expect(
      (
        await ctx.db.pool.query('SELECT id FROM economy_wallet_links WHERE user_id=$1', [
          fresh.u.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it.each(['EVM', 'NEAR'])(
    'attaches to the %s player UUID, preserves inventory/balance and current login, and later SIWS resolves the same player',
    async (network) => {
      const f = network === 'EVM' ? await login() : await nearHttpLogin();
      const roll = await call('POST', '/v1/lottery/roll', {}, f.u.accessToken);
      expect(roll.statusCode, roll.body).toBe(200);
      const balance = (await ctx.db.pool.query('SELECT * FROM balances WHERE user_id=$1', [f.u.id]))
        .rows;
      const item = uuidv7(),
        inventory = uuidv7();
      await ctx.db.pool.query(
        "INSERT INTO cosmetic_items(item_id,slot,item_key,name,price_cents) VALUES($1,'top',$2,'Primary fixture',100)",
        [item, uuidv7()],
      );
      await ctx.db.pool.query(
        "INSERT INTO cosmetic_inventory(inventory_id,user_id,item_id,source) VALUES($1,$2,$3,'grant')",
        [inventory, f.u.id, item],
      );
      const p = await primaryProof(f.u.accessToken);
      expect(p.c).toMatchObject({
        purpose: 'primary-solana-enrolment',
        proofScheme: 'siws-ed25519',
        userId: f.u.id,
        network: 'solana:mainnet',
      });
      expect(p.c.message.endsWith('- urn:ctlife:purpose:primary-solana-enrolment')).toBe(true);
      const verified = await call(
        'POST',
        '/v1/auth/primary-solana/verify',
        { challengeId: p.c.id, signature: p.signature },
        f.u.accessToken,
      );
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({
        userId: f.u.id,
        challengeId: p.c.id,
        wallet: p.address,
        identity: { network: 'solana:mainnet', address: p.address },
      });
      expect(
        (await ctx.db.pool.query('SELECT * FROM balances WHERE user_id=$1', [f.u.id])).rows,
      ).toEqual(balance);
      expect(
        (
          await ctx.db.pool.query(
            'SELECT user_id,item_id FROM cosmetic_inventory WHERE inventory_id=$1',
            [inventory],
          )
        ).rows[0],
      ).toEqual({ user_id: f.u.id, item_id: item });
      expect(
        (await ctx.db.pool.query('SELECT id FROM economy_wallet_links WHERE user_id=$1', [f.u.id]))
          .rowCount,
      ).toBe(0);
      const refreshed = await call('POST', '/v1/auth/refresh', { refreshToken: f.u.refreshToken });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      const r = refreshed.json();
      expect(r.user).toMatchObject({
        id: f.u.id,
        wallet: p.address,
        authMethod: 'wallet',
        loginIdentity: f.u.loginIdentity,
        loginIdentityVersion: f.u.loginIdentityVersion,
        authenticatedAt: f.u.authenticatedAt,
      });
      expect((await ctx.jwt.verifyAccess(r.accessToken)).auth_time).toBe(
        (await ctx.jwt.verifyAccess(f.u.accessToken)).auth_time,
      );
      expect((await siwsLogin(p.key)).u.id).toBe(f.u.id);
      expect(
        (
          await call(
            'POST',
            '/v1/auth/primary-solana/verify',
            { challengeId: p.c.id, signature: p.signature },
            f.u.accessToken,
          )
        ).json().error.code,
      ).toBe('AUTH_CHALLENGE_INVALID');
    },
  );
  it('rejects wrong owner, signature, purpose, origin and expired proof; only the persisted exact message is signed', async () => {
    const f = await login(),
      other = await login(),
      p = await primaryProof(f.u.accessToken);
    const body = { challengeId: p.c.id, signature: p.signature };
    expect(
      (await call('POST', '/v1/auth/primary-solana/verify', body, other.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_CHALLENGE_INVALID');
    for (const message of [
      p.c.message.replace(f.u.id, other.u.id),
      p.c.message.replace('primary-solana-enrolment', 'wallet-link'),
      p.c.message.replace('solana:mainnet', 'solana:devnet'),
      p.c.message.replace('play.ctlife.fun', 'other.ctlife.fun'),
      p.c.message + '\n',
    ]) {
      const signature = sign(null, Buffer.from(message), p.key.privateKey).toString('base64');
      expect(
        (
          await call(
            'POST',
            '/v1/auth/primary-solana/verify',
            { ...body, signature },
            f.u.accessToken,
          )
        ).json().error.code,
      ).toBe('AUTH_PROOF_INVALID');
    }
    const actor = await ctx.jwt.verifyAccess(f.u.accessToken);
    await expect(
      completePrimarySolanaChallenge(ctx, actor, p.c.id, p.signature, 'https://other.ctlife.fun'),
    ).rejects.toMatchObject({ code: 'AUTH_ORIGIN_INVALID' });
    expect((await call('POST', '/v1/auth/wallet/verify', body)).json().error.code).toBe(
      'AUTH_CHALLENGE_INVALID',
    );
    await ctx.db.pool.query(
      "UPDATE login_identity_challenges SET issued_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=$1",
      [p.c.id],
    );
    expect(
      (await call('POST', '/v1/auth/primary-solana/verify', body, f.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_CHALLENGE_INVALID');
  });
  it('never accepts a payment-link challenge for primary account access', async () => {
    const f = await login(),
      p = solanaKey();
    // Use an EVM payment challenge to demonstrate table/purpose isolation, not only crypto differences.
    const link = await issueWalletLinkChallenge(
      ctx,
      f.u.id,
      { network: 'eip155:4663', address: f.a.address },
      origin,
    );
    const signature = sign(null, Buffer.from(link.message), p.key.privateKey).toString('base64');
    expect(
      (
        await call(
          'POST',
          '/v1/auth/primary-solana/verify',
          { challengeId: link.id, signature },
          f.u.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_CHALLENGE_INVALID');
  });
  it('does not merge an existing Solana player or steal an active owner revoked payment reservation', async () => {
    const existing = await siwsLogin(),
      f = await login(),
      p = await primaryProof(f.u.accessToken, { key: existing.key, address: existing.u.wallet! });
    const blocked = await call(
      'POST',
      '/v1/auth/primary-solana/verify',
      { challengeId: p.c.id, signature: p.signature },
      f.u.accessToken,
    );
    expect(blocked.json().error.code).toBe('AUTH_IDENTITY_CONFLICT');
    const reserved = await primaryProof(f.u.accessToken),
      linkId = uuidv7();
    await ctx.db.pool.query(
      "INSERT INTO economy_wallet_links(id,user_id,network,address,proof_scheme,proof_digest,verified_at,revoked_at) VALUES($1,$2,'solana:mainnet',$3,'solana-ed25519','fixture',now(),now())",
      [linkId, existing.u.id, reserved.address],
    );
    expect(
      (
        await call(
          'POST',
          '/v1/auth/primary-solana/verify',
          { challengeId: reserved.c.id, signature: reserved.signature },
          f.u.accessToken,
        )
      ).json().error.code,
    ).toBe('AUTH_IDENTITY_CONFLICT');
    expect(
      (await ctx.db.pool.query('SELECT wallet FROM users WHERE id=$1', [f.u.id])).rows[0].wallet,
    ).toBeNull();
    expect(
      (await ctx.db.pool.query('SELECT user_id FROM economy_wallet_links WHERE id=$1', [linkId]))
        .rows[0].user_id,
    ).toBe(existing.u.id);
  });
  it('serializes two primary candidates for one player and does not replace the winner', async () => {
    const f = await login(),
      p1 = await primaryProof(f.u.accessToken),
      p2 = await primaryProof(f.u.accessToken);
    const results = await Promise.all(
      [p1, p2].map((p) =>
        call(
          'POST',
          '/v1/auth/primary-solana/verify',
          { challengeId: p.c.id, signature: p.signature },
          f.u.accessToken,
        ),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.find((r) => r.statusCode !== 200)!.json().error.code).toBe(
      'AUTH_PRIMARY_WALLET_EXISTS',
    );
    expect(
      (await listLoginIdentities(ctx, f.u.id)).filter((i) => i.network === 'solana:mainnet'),
    ).toHaveLength(1);
  });
  it('serializes primary enrolment against simultaneous legacy SIWS creation without moving either player', async () => {
    const f = await login(),
      p = await primaryProof(f.u.accessToken);
    const [attach, legacy] = await Promise.all([
      call(
        'POST',
        '/v1/auth/primary-solana/verify',
        { challengeId: p.c.id, signature: p.signature },
        f.u.accessToken,
      ),
      siwsLogin(p.key),
    ]);
    if (attach.statusCode === 200) expect(legacy.u.id).toBe(f.u.id);
    else {
      expect(attach.json().error.code).toBe('AUTH_IDENTITY_CONFLICT');
      expect(legacy.u.id).not.toBe(f.u.id);
    }
    expect(
      (await ctx.db.pool.query('SELECT id FROM users WHERE wallet=$1', [p.address])).rowCount,
    ).toBe(1);
  });
  it('rejects a revoked initiator and never lets another current identity finish its primary ceremony', async () => {
    const f = await login(),
      b = await enrolWithToken(f.u.accessToken),
      signedB = await login(b.a),
      p = await primaryProof(signedB.u.accessToken);
    const body = { challengeId: p.c.id, signature: p.signature };
    expect(
      (await call('POST', '/v1/auth/primary-solana/verify', body, f.u.accessToken)).json().error
        .code,
    ).toBe('AUTH_CHALLENGE_INVALID');
    await call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, f.u.accessToken);
    expect(
      (await call('POST', '/v1/auth/primary-solana/verify', body, signedB.u.accessToken)).json()
        .error.code,
    ).toBe('AUTH_IDENTITY_REVOKED');
    expect(
      (await ctx.db.pool.query('SELECT wallet FROM users WHERE id=$1', [f.u.id])).rows[0].wallet,
    ).toBeNull();
  });
  it('SGT lookup failures keep non-Seeker status and duplicate verified SGT ownership is a typed conflict', async () => {
    const f = await login(),
      p = await primaryProof(f.u.accessToken),
      helius = vi.mocked(ctx.helius.sgtMintsFor);
    helius.mockRejectedValueOnce(Error('fixture lookup unavailable'));
    expect(
      (
        await call(
          'POST',
          '/v1/auth/primary-solana/verify',
          { challengeId: p.c.id, signature: p.signature },
          f.u.accessToken,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await ctx.db.pool.query('SELECT is_seeker FROM users WHERE id=$1', [f.u.id])).rows[0]
        .is_seeker,
    ).toBe(false);
    const sgt = Keypair.generate().publicKey.toBase58();
    helius.mockResolvedValue([sgt]);
    await siwsLogin();
    const other = await login(),
      candidate = await primaryProof(other.u.accessToken);
    expect(
      (
        await call(
          'POST',
          '/v1/auth/primary-solana/verify',
          { challengeId: candidate.c.id, signature: candidate.signature },
          other.u.accessToken,
        )
      ).json().error.code,
    ).toBe('SGT_ALREADY_LINKED');
    expect(
      (await ctx.db.pool.query('SELECT wallet FROM users WHERE id=$1', [other.u.id])).rows[0]
        .wallet,
    ).toBeNull();
    helius.mockResolvedValue([]);
  });
  it('deletion erases security events, retires pending ceremonies and permits only a fresh player UUID', async () => {
    const f = await login(),
      b = await enrolWithToken(f.u.accessToken),
      p = await primaryProof(f.u.accessToken);
    await call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, f.u.accessToken);
    await deleteAccount(ctx, f.u.id);
    expect(
      (await ctx.db.pool.query('SELECT id FROM account_access_events WHERE user_id=$1', [f.u.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await ctx.db.pool.query('SELECT id FROM login_identity_challenges WHERE id=$1', [p.c.id]))
        .rowCount,
    ).toBe(0);
    expect((await login(f.a)).u.id).not.toBe(f.u.id);
  });
  it('migration rollback refuses used generation/access history rather than resurrecting credentials', async () => {
    const f = await login(),
      b = await enrolWithToken(f.u.accessToken);
    await call('DELETE', `/v1/auth/identities/${b.identity.id}`, undefined, f.u.accessToken);
    const sql = await readFile('db/migrations/1700000154000_login_identity_lifecycle.sql', 'utf8'),
      c = await ctx.db.connect();
    try {
      await c.query('BEGIN');
      await expect(c.query(sql.split('-- Down Migration')[1]!)).rejects.toThrow('Cannot roll back');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(
      (
        await ctx.db.pool.query('SELECT session_version FROM login_identities WHERE id=$1', [
          b.identity.id,
        ])
      ).rows[0].session_version,
    ).toBe(1);
  });
});
