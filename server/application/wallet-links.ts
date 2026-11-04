import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { matchWebOrigin, siwsBindingForOrigin } from '../shared/domain/web-origins.js';
import {
  createNearFullAccessVerifier,
  createWalletLinkMessage,
  normalizeWalletLinkAddress,
  verifyWalletLinkProof,
  walletLinkProofScheme,
  WalletLinkError,
  type NearFullAccessVerifier,
  type WalletLinkChallenge,
  type WalletLinkNetwork,
  type WalletLinkProof,
  type WalletLinkProofScheme,
} from './wallet-links-proofs.js';

export type WalletContext = Pick<AppContext, 'db'> & {
  config: Pick<AppContext['config'], 'siws' | 'web' | 'economy'>;
};
const TTL_MS = 5 * 60_000;

export interface VerifiedWalletLink {
  id: string;
  userId: string;
  network: WalletLinkNetwork;
  address: string;
  proofScheme: WalletLinkProofScheme;
  verifiedAt: string;
  spendingAuthorized: false;
}

interface LinkRow {
  id: string;
  user_id: string;
  network: WalletLinkNetwork;
  address: string;
  proof_scheme: WalletLinkProofScheme;
  verified_at: Date;
  revoked_at: Date | null;
}
interface ChallengeRow {
  id: string;
  user_id: string;
  network: WalletLinkNetwork;
  address: string;
  proof_scheme: WalletLinkProofScheme;
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  origin: string | null;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}
function linkDto(r: LinkRow): VerifiedWalletLink {
  return {
    id: r.id,
    userId: r.user_id,
    network: r.network,
    address: r.address,
    proofScheme: r.proof_scheme,
    verifiedAt: r.verified_at.toISOString(),
    spendingAuthorized: false,
  };
}
function challengeDto(r: ChallengeRow): WalletLinkChallenge {
  return {
    id: r.id,
    userId: r.user_id,
    network: r.network,
    address: r.address,
    proofScheme: r.proof_scheme,
    nonce: r.nonce,
    message: r.message,
    domain: r.domain,
    uri: r.uri,
    origin: r.origin,
    issuedAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  };
}
function binding(
  ctx: WalletContext,
  origin?: string,
): { domain: string; uri: string; origin: string | null } {
  if (origin === undefined || origin === '') return { ...ctx.config.siws, origin: null };
  const allowed = matchWebOrigin(origin, ctx.config.web.origins);
  if (!allowed) throw new ForbiddenError({ reason: 'origin_not_allowed' });
  return { ...siwsBindingForOrigin(allowed), origin: allowed };
}
async function lockUser(client: PoolClient, userId: string): Promise<string> {
  const result = await client.query<{ wallet: string }>(
    'SELECT wallet FROM users WHERE id=$1 FOR UPDATE',
    [userId],
  );
  if (!result.rows[0]) throw new NotFoundError();
  return result.rows[0].wallet;
}
function checkSolanaPrimary(network: WalletLinkNetwork, address: string, primary: string): void {
  // Existing SIWS resolves users.wallet. Secondary Solana identities need an auth migration first.
  if (network === 'solana:mainnet' && address !== primary) {
    throw new WalletLinkError(
      'WALLET_LINK_PRIMARY_REQUIRED',
      'Only the current player’s primary Solana wallet can be linked.',
      409,
    );
  }
}
function invalidChallenge(): WalletLinkError {
  return new WalletLinkError(
    'WALLET_LINK_CHALLENGE_INVALID',
    'Wallet-link challenge is missing, expired, consumed or belongs to another player.',
    401,
  );
}

/** Persist a short-lived proof challenge for an authenticated existing player. */
export async function issueWalletLinkChallenge(
  ctx: WalletContext,
  userId: string,
  input: { network: WalletLinkNetwork; address: string },
  origin?: string,
): Promise<
  WalletLinkChallenge & {
    nearSignMessage?: {
      message: string;
      nonceBase64: string;
      recipient: string;
      callbackUrl: string;
      state: string;
    };
  }
> {
  const address = normalizeWalletLinkAddress(input.network, input.address);
  const now = new Date();
  const fields = {
    id: uuidv7(),
    userId,
    network: input.network,
    address,
    proofScheme: walletLinkProofScheme(input.network),
    nonce: randomBytes(32).toString('hex'),
    ...binding(ctx, origin),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };
  const c: WalletLinkChallenge = { ...fields, message: createWalletLinkMessage(fields) };
  await runInTransaction(
    async (client) => {
      const primary = await lockUser(client, userId);
      checkSolanaPrimary(c.network, c.address, primary);
      // Bound outstanding signatures; expiry is checked again under lock at consumption.
      const active = await client.query<{ count: string }>(
        'SELECT count(*) FROM economy_wallet_link_challenges WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
        [userId],
      );
      if (Number(active.rows[0]?.count) >= 10) {
        throw new WalletLinkError(
          'WALLET_LINK_CHALLENGE_LIMIT',
          'Too many pending wallet-link requests. Wait for them to expire.',
          429,
        );
      }
      await client.query(
        `INSERT INTO economy_wallet_link_challenges
      (id,user_id,network,address,proof_scheme,nonce,message,domain,uri,origin,issued_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
      );
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  return c.network === 'near:mainnet'
    ? {
        ...c,
        nearSignMessage: {
          message: c.message,
          nonceBase64: Buffer.from(c.nonce, 'hex').toString('base64'),
          recipient: c.domain,
          callbackUrl: c.uri,
          state: c.id,
        },
      }
    : c;
}

/** Verify outside the transaction, then atomically consume and claim identity ownership. */
export async function completeWalletLink(
  ctx: WalletContext,
  userId: string,
  challengeId: string,
  proof: WalletLinkProof,
  origin?: string,
  nearFullAccess?: NearFullAccessVerifier,
): Promise<VerifiedWalletLink> {
  const row = await ctx.db.withConnection(
    async (client) =>
      (
        await client.query<ChallengeRow>(
          `SELECT * FROM economy_wallet_link_challenges WHERE id=$1 AND user_id=$2
      AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [challengeId, userId],
        )
      ).rows[0],
  );
  if (!row) throw invalidChallenge();
  const c = challengeDto(row);
  const expected = binding(ctx, origin);
  if (c.origin !== expected.origin || c.domain !== expected.domain || c.uri !== expected.uri) {
    throw new ForbiddenError({ reason: 'wallet_link_origin_mismatch' });
  }
  const nearVerifier =
    nearFullAccess ??
    (c.network === 'near:mainnet'
      ? createNearFullAccessVerifier(ctx.config.economy.rpcUrls['near:mainnet'])
      : async () => false);
  if (!(await verifyWalletLinkProof(c, proof, nearVerifier))) {
    throw new WalletLinkError(
      'WALLET_LINK_PROOF_INVALID',
      'Wallet identity proof could not be verified.',
      401,
    );
  }
  const result = await runInTransaction(
    async (client): Promise<VerifiedWalletLink | null> => {
      const primary = await lockUser(client, userId);
      checkSolanaPrimary(c.network, c.address, primary);
      // Atomically consume after signature validation, even when identity is already owned.
      const consumed = await client.query(
        `UPDATE economy_wallet_link_challenges SET consumed_at=clock_timestamp()
      WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
        [challengeId, userId],
      );
      if (consumed.rowCount !== 1) throw invalidChallenge();
      const digest = createHash('sha256')
        .update(
          JSON.stringify([
            c.message,
            c.nonce,
            c.domain,
            c.uri,
            proof.signature,
            proof.publicKey ?? null,
          ]),
        )
        .digest('hex');
      const linked = await client.query<LinkRow>(
        `INSERT INTO economy_wallet_links
      (id,user_id,network,address,proof_scheme,proof_digest,public_key,verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
      ON CONFLICT (network,address) DO UPDATE SET proof_scheme=EXCLUDED.proof_scheme,
        proof_digest=EXCLUDED.proof_digest,public_key=EXCLUDED.public_key,
        verified_at=EXCLUDED.verified_at,revoked_at=NULL
      WHERE economy_wallet_links.user_id=EXCLUDED.user_id RETURNING *`,
        [uuidv7(), userId, c.network, c.address, c.proofScheme, digest, proof.publicKey ?? null],
      );
      return linked.rows[0] ? linkDto(linked.rows[0]) : null;
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  if (!result)
    throw new WalletLinkError(
      'WALLET_LINK_IDENTITY_CONFLICT',
      'This wallet is already linked to another player.',
      409,
    );
  return result;
}

/** List only this player's active verified identities. */
export async function listWalletLinks(
  ctx: WalletContext,
  userId: string,
): Promise<VerifiedWalletLink[]> {
  return ctx.db.withConnection(async (client) =>
    (
      await client.query<LinkRow>(
        'SELECT * FROM economy_wallet_links WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at,id',
        [userId],
      )
    ).rows.map(linkDto),
  );
}

/** A verified identity is necessary for order attribution; it is never spending authorization. */
export async function getVerifiedWalletLink(
  ctx: WalletContext,
  userId: string,
  linkId: string,
): Promise<VerifiedWalletLink> {
  const row = await ctx.db.withConnection(
    async (client) =>
      (
        await client.query<LinkRow>(
          'SELECT * FROM economy_wallet_links WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
          [linkId, userId],
        )
      ).rows[0],
  );
  if (!row) throw new NotFoundError({ resource: 'verified_wallet_link' });
  return linkDto(row);
}

/** Revoke an owned link and invalidate its outstanding proof challenges. */
export async function revokeWalletLink(
  ctx: WalletContext,
  userId: string,
  linkId: string,
): Promise<void> {
  await runInTransaction(
    async (client) => {
      await lockUser(client, userId);
      const result = await client.query<LinkRow>(
        `UPDATE economy_wallet_links
      SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2 RETURNING *`,
        [linkId, userId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError({ resource: 'wallet_link' });
      await client.query(
        `UPDATE economy_wallet_link_challenges SET consumed_at=clock_timestamp()
      WHERE user_id=$1 AND network=$2 AND address=$3 AND consumed_at IS NULL`,
        [userId, row.network, row.address],
      );
    },
    { isolation: 'read committed' },
    ctx.db,
  );
}

/** Reject malformed route identifiers before issuing a PostgreSQL UUID query. */
export function assertWalletLinkUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationFailedError({ field: 'id' });
  }
}
