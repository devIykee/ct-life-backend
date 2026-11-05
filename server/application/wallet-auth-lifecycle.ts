/** Explicit account-access changes; never creates payment links or moves a player. */
import { randomBytes } from 'node:crypto';
import type { AppContext } from './context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { runInTransaction } from '../shared/db/uow.js';
import { SGTAlreadyLinkedError } from '../shared/domain/errors.js';
import { createLogger } from '../shared/logger/logger.js';
import { lockWalletOwnership } from './wallet-ownership.js';
import {
  LOGIN_IDENTITY_REVOKED_CHANNEL,
  type CredentialClaims,
  type LoginIdentityRevokedEvent,
} from './login-credentials.js';
import {
  assertAuthInitiator,
  authWalletError,
  lockActiveAuthUser,
  recordAccountAccessEvent,
  walletAuthBinding,
  type LoginIdentity,
} from './wallet-auth.js';
import {
  normalizeWalletLinkAddress,
  verifyWalletLinkProof,
  WalletLinkError,
} from './wallet-links-proofs.js';

/** Remove only a non-primary credential after authentication with a retained one. */
export async function revokeLoginIdentity(
  ctx: AppContext,
  actor: CredentialClaims,
  identityId: string,
  origin?: string,
): Promise<void> {
  walletAuthBinding(ctx, origin);
  const target = (
    await ctx.db.withConnection((c) =>
      c.query<{ network: LoginIdentity['network']; address: string }>(
        'SELECT network,address FROM login_identities WHERE id=$1 AND user_id=$2',
        [identityId, actor.sub],
      ),
    )
  ).rows[0];
  if (!target) throw authWalletError('AUTH_IDENTITY_NOT_FOUND', 'Sign-in wallet not found.', 404);
  const event = await runInTransaction(
    async (client) => {
      await lockWalletOwnership(client, target.network, target.address);
      await lockActiveAuthUser(client, actor.sub);
      const retained = await assertAuthInitiator(client, ctx, actor.sub, actor);
      const row = (
        await client.query<{ revoked_at: Date | null; session_version: number }>(
          'SELECT revoked_at,session_version FROM login_identities WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [identityId, actor.sub],
        )
      ).rows[0];
      if (!row) throw authWalletError('AUTH_IDENTITY_NOT_FOUND', 'Sign-in wallet not found.', 404);
      if (target.network === 'solana:mainnet')
        throw authWalletError(
          'AUTH_PRIMARY_WALLET_IMMUTABLE',
          'The primary Solana wallet cannot be removed.',
          409,
        );
      if (row.revoked_at !== null) return null;
      const count = (
        await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM login_identities i JOIN users u ON u.id=i.user_id
       WHERE i.user_id=$1 AND i.revoked_at IS NULL AND (i.network<>'solana:mainnet' OR i.address=u.wallet)`,
          [actor.sub],
        )
      ).rows[0]!;
      if (Number(count.n) <= 1)
        throw authWalletError('AUTH_LAST_IDENTITY', 'Keep at least one sign-in wallet.', 409);
      if (retained.identityId === identityId)
        throw authWalletError(
          'AUTH_USE_ANOTHER_IDENTITY',
          'Sign in with a wallet you are keeping before removing this one.',
          409,
        );
      const minVersion = row.session_version + 1;
      await client.query(
        'UPDATE login_identities SET revoked_at=clock_timestamp(),session_version=$2 WHERE id=$1',
        [identityId, minVersion],
      );
      await client.query(
        `UPDATE login_identity_challenges SET consumed_at=clock_timestamp() WHERE consumed_at IS NULL
      AND ((network=$1 AND address=$2) OR (initiator_identity_id=$3 AND initiator_session_version<$4))`,
        [target.network, target.address, identityId, minVersion],
      );
      await recordAccountAccessEvent(
        client,
        actor.sub,
        identityId,
        'identity_revoked',
        target.network,
      );
      return { userId: actor.sub, identityId, minVersion } satisfies LoginIdentityRevokedEvent;
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  if (event) {
    try {
      await ctx.redis.main.publish(LOGIN_IDENTITY_REVOKED_CHANNEL, JSON.stringify(event));
    } catch {
      createLogger().warn(
        { mod: 'auth' },
        'Credential revocation publication failed; durable session checks remain authoritative',
      );
    }
  }
}

export interface PrimarySolanaChallenge {
  id: string;
  purpose: 'primary-solana-enrolment';
  userId: string;
  network: 'solana:mainnet';
  address: string;
  proofScheme: 'siws-ed25519';
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  issuedAt: string;
  expiresAt: string;
}

/** Exact owner/purpose-bound SIWS bytes, independent of legacy anonymous login. */
export function createPrimarySolanaMessage(c: Omit<PrimarySolanaChallenge, 'message'>): string {
  return [
    `${c.domain} wants you to sign in with your Solana account:`,
    c.address,
    '',
    `Add this Solana wallet as the primary Solana wallet and a sign-in identity for CT Life player ${c.userId}. This grants access to that player account; it does not authorize payments or transactions.`,
    '',
    `URI: ${c.uri}`,
    'Version: 1',
    'Chain ID: solana:mainnet',
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expiresAt}`,
    `Request ID: ${c.id}`,
    'Resources:',
    `- urn:ctlife:player:${c.userId}`,
    '- urn:ctlife:purpose:primary-solana-enrolment',
  ].join('\n');
}

/** Only an explicit, recently authenticated account may request a primary attachment. */
export async function issuePrimarySolanaChallenge(
  ctx: AppContext,
  actor: CredentialClaims,
  address: string,
  origin?: string,
): Promise<PrimarySolanaChallenge> {
  const binding = walletAuthBinding(ctx, origin),
    now = new Date();
  const fields: Omit<PrimarySolanaChallenge, 'message'> = {
    id: uuidv7(),
    purpose: 'primary-solana-enrolment',
    userId: actor.sub,
    network: 'solana:mainnet',
    address: normalizeWalletLinkAddress('solana:mainnet', address),
    proofScheme: 'siws-ed25519',
    nonce: randomBytes(32).toString('hex'),
    domain: binding.domain,
    uri: binding.uri,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
  };
  const challenge = { ...fields, message: createPrimarySolanaMessage(fields) };
  await runInTransaction(
    async (client) => {
      await lockWalletOwnership(client, challenge.network, challenge.address);
      await lockActiveAuthUser(client, actor.sub);
      const caller = await assertAuthInitiator(client, ctx, actor.sub, actor);
      const user = (
        await client.query<{ wallet: string | null }>('SELECT wallet FROM users WHERE id=$1', [
          actor.sub,
        ])
      ).rows[0]!;
      if (user.wallet !== null && user.wallet !== address)
        throw authWalletError(
          'AUTH_PRIMARY_WALLET_EXISTS',
          'This player already has a primary Solana wallet.',
          409,
        );
      const count = (
        await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM login_identity_challenges WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
          [actor.sub],
        )
      ).rows[0]!;
      if (Number(count.n) >= 10)
        throw authWalletError(
          'AUTH_CHALLENGE_LIMIT',
          'Too many pending enrolment requests. Wait for them to expire.',
          429,
        );
      await client.query(
        `DELETE FROM login_identity_challenges WHERE id IN (SELECT id FROM login_identity_challenges WHERE expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      );
      await client.query(
        `INSERT INTO login_identity_challenges(id,purpose,user_id,account_hint,network,address,nonce,message,domain,uri,origin,issued_at,expires_at,initiator_identity_id,initiator_session_version)
      VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          challenge.id,
          challenge.purpose,
          actor.sub,
          challenge.network,
          challenge.address,
          challenge.nonce,
          challenge.message,
          challenge.domain,
          challenge.uri,
          binding.origin,
          challenge.issuedAt,
          challenge.expiresAt,
          caller.identityId,
          caller.version,
        ],
      );
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  return challenge;
}

interface PrimaryRow {
  id: string;
  user_id: string;
  address: string;
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  origin: string | null;
  issued_at: Date;
  expires_at: Date;
  initiator_identity_id: string;
  initiator_session_version: number;
}
export interface PrimarySolanaReceipt {
  userId: string;
  challengeId: string;
  wallet: string;
  identity: LoginIdentity;
}
function invalidPrimary(): WalletLinkError {
  return authWalletError(
    'AUTH_CHALLENGE_INVALID',
    'Primary wallet proof is missing, expired, used or belongs to another ceremony.',
  );
}

/** Attach to the existing UUID only; no player merge, payment link or transaction. */
export async function completePrimarySolanaChallenge(
  ctx: AppContext,
  actor: CredentialClaims,
  challengeId: string,
  signature: string,
  origin?: string,
): Promise<PrimarySolanaReceipt> {
  const row = (
    await ctx.db.withConnection((c) =>
      c.query<PrimaryRow>(
        `SELECT * FROM login_identity_challenges WHERE id=$1 AND user_id=$2 AND purpose='primary-solana-enrolment' AND network='solana:mainnet' AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [challengeId, actor.sub],
      ),
    )
  ).rows[0];
  if (!row) throw invalidPrimary();
  const binding = walletAuthBinding(ctx, origin);
  if (row.origin !== binding.origin || row.domain !== binding.domain || row.uri !== binding.uri)
    throw authWalletError(
      'AUTH_ORIGIN_INVALID',
      'Origin does not match this primary-wallet challenge.',
      403,
    );
  const verified = await verifyWalletLinkProof(
    {
      id: row.id,
      userId: row.user_id,
      network: 'solana:mainnet',
      address: row.address,
      proofScheme: 'solana-ed25519',
      nonce: row.nonce,
      message: row.message,
      domain: row.domain,
      uri: row.uri,
      origin: row.origin,
      nearCallbackUrl: null,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    },
    { signature },
    async () => false,
  );
  if (!verified)
    throw authWalletError(
      'AUTH_PROOF_INVALID',
      'The primary Solana wallet signature could not be verified.',
    );
  let sgtMint: string | null = null;
  try {
    sgtMint =
      (
        await ctx.helius.sgtMintsFor(row.address, 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te')
      )[0] ?? null;
  } catch {
    /* Same fail-closed non-Seeker behavior as existing SIWS. */
  }
  const result = await runInTransaction(
    async (client) => {
      await lockWalletOwnership(client, 'solana:mainnet', row.address);
      await lockActiveAuthUser(client, actor.sub);
      const caller = await assertAuthInitiator(client, ctx, actor.sub, actor);
      if (
        caller.identityId !== row.initiator_identity_id ||
        caller.version !== row.initiator_session_version
      )
        throw invalidPrimary();
      const consumed = await client.query(
        'UPDATE login_identity_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!consumed.rowCount) throw invalidPrimary();
      const current = (
        await client.query<{ wallet: string | null }>('SELECT wallet FROM users WHERE id=$1', [
          actor.sub,
        ])
      ).rows[0]!;
      if (current.wallet !== null && current.wallet !== row.address)
        return authWalletError(
          'AUTH_PRIMARY_WALLET_EXISTS',
          'This player already has a primary Solana wallet.',
          409,
        );
      const owners = await client.query<{ user_id: string }>(
        `SELECT id AS user_id FROM users WHERE wallet=$1 AND deleted_at IS NULL
       UNION SELECT i.user_id FROM login_identities i JOIN users u ON u.id=i.user_id WHERE i.network='solana:mainnet' AND i.address=$1 AND u.deleted_at IS NULL
       UNION SELECT l.user_id FROM economy_wallet_links l JOIN users u ON u.id=l.user_id WHERE l.network='solana:mainnet' AND l.address=$1 AND l.ownership_released_at IS NULL AND u.deleted_at IS NULL`,
        [row.address],
      );
      if (owners.rows.some((o) => o.user_id !== actor.sub))
        return authWalletError(
          'AUTH_IDENTITY_CONFLICT',
          'This Solana wallet belongs to another player. Accounts cannot be merged.',
          409,
        );
      if (current.wallet === null) {
        if (
          sgtMint !== null &&
          (
            await client.query('SELECT id FROM users WHERE sgt_mint=$1 AND id<>$2', [
              sgtMint,
              actor.sub,
            ])
          ).rowCount
        )
          throw new SGTAlreadyLinkedError({});
        await client.query(
          'UPDATE users SET wallet=$2,is_seeker=$3,sgt_mint=$4 WHERE id=$1 AND wallet IS NULL',
          [actor.sub, row.address, sgtMint !== null, sgtMint],
        );
      }
      const identity = (
        await client.query<{
          id: string;
          network: 'solana:mainnet';
          address: string;
          created_at: Date;
          revoked_at: Date | null;
        }>(
          `INSERT INTO login_identities(id,user_id,network,address) VALUES($1,$2,'solana:mainnet',$3)
       ON CONFLICT(network,address) DO UPDATE SET address=EXCLUDED.address WHERE login_identities.user_id=EXCLUDED.user_id AND login_identities.revoked_at IS NULL RETURNING *`,
          [uuidv7(), actor.sub, row.address],
        )
      ).rows[0];
      if (!identity)
        throw authWalletError(
          'AUTH_IDENTITY_CONFLICT',
          'This Solana identity cannot be attached.',
          409,
        );
      if (current.wallet === null)
        await recordAccountAccessEvent(
          client,
          actor.sub,
          identity.id,
          'primary_solana_enrolled',
          'solana:mainnet',
        );
      return {
        userId: actor.sub,
        challengeId: row.id,
        wallet: row.address,
        identity: {
          id: identity.id,
          network: identity.network,
          address: identity.address,
          createdAt: identity.created_at.toISOString(),
        },
      };
    },
    { isolation: 'read committed' },
    ctx.db,
  ).catch((error: unknown) => {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'users_sgt_mint_unique')
      throw new SGTAlreadyLinkedError({});
    throw error;
  });
  if (result instanceof WalletLinkError) throw result;
  return result;
}
