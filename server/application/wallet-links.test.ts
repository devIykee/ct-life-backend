/** Real Postgres concurrency tests in a disposable schema, never shared game tables. */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PublicKey } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../shared/domain/uuid.js';
import { loadConfig } from '../shared/config/config.js';
import type { Db } from '../shared/db/pool.js';
import {
  completeWalletLink,
  getVerifiedWalletLink,
  issueWalletLinkChallenge,
  listWalletLinks,
  revokeWalletLink,
  type WalletContext,
} from './wallet-links.js';
import {
  createWalletLinkMessage,
  serializeNep413,
  type WalletLinkChallenge,
} from './wallet-links-proofs.js';

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `wallet_links_${randomBytes(8).toString('hex')}`;
let admin: Pool;
let pool: Pool;
let ctx: WalletContext;
let created = false;
let legacyNearChallenge: string;
const evm = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const otherEvm = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const ed = generateKeyPairSync('ed25519');
const solana = new PublicKey(
  ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
).toBase58();

beforeAll(async () => {
  if (!connectionString)
    throw new Error('DATABASE_URL or TEST_DATABASE_URL required for wallet-link DB tests');
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema}`,
    statement_timeout: 5_000,
    lock_timeout: 3_000,
  });
  // Minimal real users shape is enough to exercise the migration's ownership FKs.
  await pool.query('CREATE TABLE users (id uuid PRIMARY KEY, wallet text NOT NULL UNIQUE)');
  const sql = await readFile(
    new URL('../../db/migrations/1700000150000_economy_wallet_links.sql', import.meta.url),
    'utf8',
  );
  await pool.query(sql.split('-- Down Migration')[0]!);
  const legacyUser = await user();
  legacyNearChallenge = uuidv7();
  await pool.query(
    `INSERT INTO economy_wallet_link_challenges
    (id,user_id,network,address,proof_scheme,nonce,message,domain,uri,issued_at,expires_at)
    VALUES ($1,$2,'near:mainnet','legacy.near','nep413-ed25519',$3,'legacy message','ctlife.fun','https://ctlife.fun/',now(),now()+interval '5 minutes')`,
    [legacyNearChallenge, legacyUser, randomBytes(32).toString('hex')],
  );
  const callbackMigration = await readFile(
    new URL('../../db/migrations/1700000152000_near_wallet_callback.sql', import.meta.url),
    'utf8',
  );
  await pool.query(callbackMigration.split('-- Down Migration')[0]!);
  const db: Db = {
    pool,
    connect: () => pool.connect(),
    close: () => pool.end(),
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
  };
  ctx = {
    db,
    config: {
      ...loadConfig(),
      siws: { domain: 'ctlife.fun', uri: 'https://ctlife.fun/' },
      web: { origins: ['https://play.ctlife.fun', 'https://other.ctlife.fun'] },
    },
  };
});

afterAll(async () => {
  if (pool) await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if (admin) await admin.end();
});

async function user(wallet = `wallet-link-test-${uuidv7()}`): Promise<string> {
  const id = uuidv7();
  await pool.query('INSERT INTO users (id,wallet) VALUES ($1,$2)', [id, wallet]);
  return id;
}
async function evmChallenge(userId: string, account = evm, origin?: string) {
  const c = await issueWalletLinkChallenge(
    ctx,
    userId,
    { network: 'eip155:4663', address: account.address },
    origin,
  );
  const proof = { signature: await account.signMessage({ message: c.message }) };
  return { c, proof };
}

describe('durable verified wallet links', () => {
  it('backfills existing NEAR challenges to their original Some(uri) bytes', async () => {
    const row = (
      await pool.query(
        'SELECT near_callback_url,uri FROM economy_wallet_link_challenges WHERE id=$1',
        [legacyNearChallenge],
      )
    ).rows[0];
    expect(row.near_callback_url).toBe(row.uri);
    expect(row.near_callback_url).toBe('https://ctlife.fun/');
  });

  it('accepts Some(uri) from an old writer after migration and distinguishes explicit None', async () => {
    const uid = await user();
    const fields = {
      id: uuidv7(),
      userId: uid,
      network: 'near:mainnet' as const,
      address: 'old-writer.near',
      proofScheme: 'nep413-ed25519' as const,
      nonce: randomBytes(32).toString('hex'),
      domain: 'ctlife.fun',
      uri: 'https://ctlife.fun/',
      origin: null,
      nearCallbackUrl: 'https://ctlife.fun/',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
    const c: WalletLinkChallenge = { ...fields, message: createWalletLinkMessage(fields) };
    const row = (
      await pool.query(
        `INSERT INTO economy_wallet_link_challenges
      (id,user_id,network,address,proof_scheme,nonce,message,domain,uri,origin,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING near_callback_mode,near_callback_url`,
        [
          c.id,
          c.userId,
          c.network,
          c.address,
          c.proofScheme,
          c.nonce,
          c.message,
          c.domain,
          c.uri,
          c.origin,
          c.issuedAt,
          c.expiresAt,
        ],
      )
    ).rows[0];
    expect(row).toEqual({ near_callback_mode: 'uri', near_callback_url: null });
    const signature = (callback: string | null) =>
      sign(
        null,
        createHash('sha256')
          .update(serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, callback))
          .digest(),
        ed.privateKey,
      ).toString('base64');
    await expect(
      completeWalletLink(
        ctx,
        uid,
        c.id,
        { publicKey: `ed25519:${solana}`, signature: signature(null) },
        undefined,
        async () => true,
      ),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_PROOF_INVALID' });
    expect(
      await completeWalletLink(
        ctx,
        uid,
        c.id,
        { publicKey: `ed25519:${solana}`, signature: signature(c.uri) },
        undefined,
        async () => true,
      ),
    ).toMatchObject({ address: c.address });
  });

  it('enforces callback modes in the database and rollback consumes only explicit None challenges', async () => {
    const uid = await user();
    const none = await issueWalletLinkChallenge(ctx, uid, {
      network: 'near:mainnet',
      address: 'rollback.near',
      nearCallbackMode: 'none',
    });
    const uri = await issueWalletLinkChallenge(ctx, uid, {
      network: 'near:mainnet',
      address: 'rollback.near',
    });
    const evmProof = await evmChallenge(uid);
    await expect(
      pool.query(
        "UPDATE economy_wallet_link_challenges SET near_callback_mode='none' WHERE id=$1",
        [evmProof.c.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('UPDATE economy_wallet_link_challenges SET near_callback_url=uri WHERE id=$1', [
        none.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // Legacy row: omitted callback column, mode still default uri.
    await pool.query(
      'UPDATE economy_wallet_link_challenges SET near_callback_url=NULL WHERE id=$1',
      [uri.id],
    );
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const migration = await readFile(
        new URL('../../db/migrations/1700000152000_near_wallet_callback.sql', import.meta.url),
        'utf8',
      );
      await db.query(migration.split('-- Down Migration')[1]!);
      const rows = (
        await db.query(
          'SELECT id,consumed_at FROM economy_wallet_link_challenges WHERE id=ANY($1::uuid[])',
          [[none.id, uri.id]],
        )
      ).rows;
      expect(rows.find((r) => r.id === none.id).consumed_at).not.toBeNull();
      expect(rows.find((r) => r.id === uri.id).consumed_at).toBeNull();
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it('persists an explicitly requested None option and refuses a different signed option', async () => {
    const uid = await user();
    const c = await issueWalletLinkChallenge(
      ctx,
      uid,
      { network: 'near:mainnet', address: 'no-callback.near', nearCallbackMode: 'none' },
      'https://play.ctlife.fun',
    );
    expect(c.nearCallbackUrl).toBeNull();
    expect(c.nearSignMessage?.callbackUrl).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT near_callback_url FROM economy_wallet_link_challenges WHERE id=$1',
          [c.id],
        )
      ).rows[0].near_callback_url,
    ).toBeNull();
    const proof = (callback: string | null) => ({
      publicKey: `ed25519:${solana}`,
      signature: sign(
        null,
        createHash('sha256')
          .update(serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, callback))
          .digest(),
        ed.privateKey,
      ).toString('base64'),
    });
    await expect(
      completeWalletLink(ctx, uid, c.id, proof(c.uri), 'https://play.ctlife.fun', async () => true),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_PROOF_INVALID' });
    expect(
      await completeWalletLink(
        ctx,
        uid,
        c.id,
        proof(null),
        'https://play.ctlife.fun',
        async () => true,
      ),
    ).toMatchObject({ address: 'no-callback.near', spendingAuthorized: false });
    await expect(
      issueWalletLinkChallenge(ctx, uid, {
        network: 'eip155:4663',
        address: evm.address,
        nearCallbackMode: 'none',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('links real EVM proof without changing legacy identity or granting spending', async () => {
    const uid = await user();
    const original = (await pool.query('SELECT wallet FROM users WHERE id=$1', [uid])).rows[0]
      .wallet;
    const { c, proof } = await evmChallenge(uid, otherEvm);
    const link = await completeWalletLink(ctx, uid, c.id, proof);
    expect(link).toMatchObject({
      userId: uid,
      network: 'eip155:4663',
      address: otherEvm.address.toLowerCase(),
      spendingAuthorized: false,
    });
    expect(await getVerifiedWalletLink(ctx, uid, link.id)).toEqual(link);
    expect(await listWalletLinks(ctx, uid)).toEqual([link]);
    expect((await pool.query('SELECT wallet FROM users WHERE id=$1', [uid])).rows[0].wallet).toBe(
      original,
    );
    await expect(getVerifiedWalletLink(ctx, await user(), link.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('consumes one challenge exactly once under concurrent valid submissions', async () => {
    const uid = await user();
    const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const { c, proof } = await evmChallenge(uid, account);
    const results = await Promise.allSettled([
      completeWalletLink(ctx, uid, c.id, proof),
      completeWalletLink(ctx, uid, c.id, proof),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'WALLET_LINK_CHALLENGE_INVALID' });
    expect(await listWalletLinks(ctx, uid)).toHaveLength(1);
  });

  it('allows only one player to claim one wallet concurrently and consumes both proven challenges', async () => {
    const a = await user();
    const b = await user();
    const ca = await evmChallenge(a);
    const cb = await evmChallenge(b);
    const results = await Promise.allSettled([
      completeWalletLink(ctx, a, ca.c.id, ca.proof),
      completeWalletLink(ctx, b, cb.c.id, cb.proof),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'WALLET_LINK_IDENTITY_CONFLICT' });
    const rows = await pool.query(
      'SELECT consumed_at FROM economy_wallet_link_challenges WHERE id=ANY($1::uuid[])',
      [[ca.c.id, cb.c.id]],
    );
    expect(rows.rows.every((r) => r.consumed_at !== null)).toBe(true);
    expect(
      (
        await pool.query('SELECT id FROM economy_wallet_links WHERE network=$1 AND address=$2', [
          'eip155:4663',
          evm.address.toLowerCase(),
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('rejects player substitution, changed origin, expired challenges and invalid proofs', async () => {
    const uid = await user();
    const { c, proof } = await evmChallenge(uid, evm, 'https://play.ctlife.fun');
    await expect(
      completeWalletLink(ctx, await user(), c.id, proof, 'https://play.ctlife.fun'),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_CHALLENGE_INVALID' });
    await expect(
      completeWalletLink(ctx, uid, c.id, proof, 'https://other.ctlife.fun'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(completeWalletLink(ctx, uid, c.id, proof)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      completeWalletLink(ctx, uid, c.id, { signature: '0xdeadbeef' }, 'https://play.ctlife.fun'),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_PROOF_INVALID' });
    expect(
      (
        await pool.query('SELECT consumed_at FROM economy_wallet_link_challenges WHERE id=$1', [
          c.id,
        ])
      ).rows[0].consumed_at,
    ).toBeNull();
    await pool.query(
      "UPDATE economy_wallet_link_challenges SET issued_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=$1",
      [c.id],
    );
    await expect(
      completeWalletLink(ctx, uid, c.id, proof, 'https://play.ctlife.fun'),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_CHALLENGE_INVALID' });
  });

  it('revocation invalidates pending proofs, preserves owner and permits explicit re-proof by same player', async () => {
    const uid = await user();
    const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
    const first = await evmChallenge(uid, account);
    const link = await completeWalletLink(ctx, uid, first.c.id, first.proof);
    const pending = await evmChallenge(uid, account);
    await expect(revokeWalletLink(ctx, await user(), link.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await revokeWalletLink(ctx, uid, link.id);
    expect(await listWalletLinks(ctx, uid)).toEqual([]);
    await expect(getVerifiedWalletLink(ctx, uid, link.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(completeWalletLink(ctx, uid, pending.c.id, pending.proof)).rejects.toMatchObject({
      code: 'WALLET_LINK_CHALLENGE_INVALID',
    });
    const stranger = await user();
    const conflict = await evmChallenge(stranger, account);
    await expect(
      completeWalletLink(ctx, stranger, conflict.c.id, conflict.proof),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_IDENTITY_CONFLICT' });
    const again = await evmChallenge(uid, account);
    expect((await completeWalletLink(ctx, uid, again.c.id, again.proof)).id).toBe(link.id);
  });

  it('requires the primary Solana wallet, then verifies its real Ed25519 proof', async () => {
    const uid = await user(solana);
    const c = await issueWalletLinkChallenge(ctx, uid, {
      network: 'solana:mainnet',
      address: solana,
    });
    const signature = sign(null, Buffer.from(c.message), ed.privateKey).toString('base64');
    expect(await completeWalletLink(ctx, uid, c.id, { signature })).toMatchObject({
      network: 'solana:mainnet',
      address: solana,
      spendingAuthorized: false,
    });
    await expect(
      issueWalletLinkChallenge(ctx, await user(), { network: 'solana:mainnet', address: solana }),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_PRIMARY_REQUIRED' });
  });

  it('persists NEAR only after both a valid NEP-413 signature and FullAccess ownership', async () => {
    const uid = await user();
    const c = await issueWalletLinkChallenge(ctx, uid, {
      network: 'near:mainnet',
      address: 'wallet-link-test.near',
    });
    expect(c.nearSignMessage?.state).toBe(c.id);
    expect(c.nearCallbackUrl).toBe(c.uri);
    expect(c.nearSignMessage?.callbackUrl).toBe(c.uri);
    expect(Buffer.from(c.nearSignMessage!.nonceBase64, 'base64')).toEqual(
      Buffer.from(c.nonce, 'hex'),
    );
    const bytes = serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, c.uri);
    const proof = {
      publicKey: `ed25519:${solana}`,
      signature: sign(null, createHash('sha256').update(bytes).digest(), ed.privateKey).toString(
        'base64',
      ),
    };
    await expect(
      completeWalletLink(ctx, uid, c.id, proof, undefined, async () => false),
    ).rejects.toMatchObject({ code: 'WALLET_LINK_PROOF_INVALID' });
    expect(await listWalletLinks(ctx, uid)).toEqual([]);
    expect(
      await completeWalletLink(ctx, uid, c.id, proof, undefined, async () => true),
    ).toMatchObject({
      userId: uid,
      network: 'near:mainnet',
      address: 'wallet-link-test.near',
      spendingAuthorized: false,
    });
  });

  it('rechecks expiry after an asynchronous NEAR ownership verification', async () => {
    const uid = await user();
    const c = await issueWalletLinkChallenge(ctx, uid, {
      network: 'near:mainnet',
      address: 'expiry-test.near',
    });
    const bytes = serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, c.uri);
    const proof = {
      publicKey: `ed25519:${solana}`,
      signature: sign(null, createHash('sha256').update(bytes).digest(), ed.privateKey).toString(
        'base64',
      ),
    };
    let started!: () => void;
    let finish!: (value: boolean) => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ownership = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const pending = completeWalletLink(ctx, uid, c.id, proof, undefined, () => {
      started();
      return ownership;
    });
    await entered;
    await pool.query(
      "UPDATE economy_wallet_link_challenges SET issued_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes' WHERE id=$1",
      [c.id],
    );
    finish(true);
    await expect(pending).rejects.toMatchObject({ code: 'WALLET_LINK_CHALLENGE_INVALID' });
    expect(await listWalletLinks(ctx, uid)).toEqual([]);
  });

  it('bounds outstanding challenges and rejects non-allowlisted origins before storage', async () => {
    const uid = await user();
    await expect(evmChallenge(uid, evm, 'https://attacker.test')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (let i = 0; i < 10; i++) await evmChallenge(uid);
    await expect(evmChallenge(uid)).rejects.toMatchObject({ code: 'WALLET_LINK_CHALLENGE_LIMIT' });
  });
});
