import { recordEvent } from './analytics.js';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { uuidv7 } from '../shared/domain/uuid.js';
import { runInTransaction } from '../shared/db/uow.js';
import { matchWebOrigin, siwsBindingForOrigin } from '../shared/domain/web-origins.js';
import { assertNotBannedDb } from './moderation.js';
import { lockWalletOwnership } from './wallet-ownership.js';
import {
  assertRecentAuthentication,
  resolveLoginCredentialOn,
  credentialRevoked,
  type CredentialClaims,
} from './login-credentials.js';
import type { AppContext } from './context.js';
type WalletAuthContext = Pick<AppContext, 'db' | 'config'>;
import {
  createNearFullAccessVerifier,
  normalizeWalletLinkAddress,
  verifyWalletLinkProof,
  walletLinkProofScheme,
  WalletLinkError,
  type NearFullAccessVerifier,
  type WalletLinkNetwork,
  type WalletLinkProof,
} from './wallet-links-proofs.js';

export const LOGIN_NETWORKS = ['eip155:4663', 'near:mainnet'] as const;
export type LoginNetwork = (typeof LOGIN_NETWORKS)[number];
export type LoginPurpose = 'login' | 'enrolment';
export interface LoginIdentity {
  id: string;
  network: WalletLinkNetwork;
  address: string;
  createdAt: string;
}
interface IdentityRow {
  id: string;
  user_id: string;
  network: WalletLinkNetwork;
  address: string;
  created_at: Date;
  revoked_at: Date | null;
  session_version: number;
}
export interface LoginChallenge {
  id: string;
  purpose: LoginPurpose;
  userId: string | null;
  network: LoginNetwork;
  address: string;
  proofScheme: 'eip4361-eoa' | 'nep413-ed25519';
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  issuedAt: string;
  expiresAt: string;
  nearSignMessage?: {
    message: string;
    nonceBase64: string;
    recipient: string;
    callbackUrl: null;
    state: string;
  };
}
interface ChallengeRow {
  id: string;
  purpose: LoginPurpose;
  user_id: string | null;
  network: LoginNetwork;
  address: string;
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  origin: string | null;
  issued_at: Date;
  expires_at: Date;
  account_hint: string | null;
  initiator_identity_id: string | null;
  initiator_session_version: number | null;
}
/** Typed authentication failure, mapped by the shared HTTP error handler. */
export function authWalletError(code: string, message: string, status = 401): WalletLinkError {
  return new WalletLinkError(code, message, status);
}
function invalid(): WalletLinkError {
  return authWalletError(
    'AUTH_CHALLENGE_INVALID',
    'Sign-in challenge is missing, expired, used or has the wrong purpose or owner.',
  );
}
/** Bind the current native/browser origin to the configured signing authority. */
export function walletAuthBinding(
  ctx: WalletAuthContext,
  origin?: string,
): { domain: string; uri: string; origin: string | null } {
  if (origin === undefined || origin === '') return { ...ctx.config.siws, origin: null };
  const allowed = matchWebOrigin(origin, ctx.config.web.origins);
  if (!allowed)
    throw authWalletError('AUTH_ORIGIN_INVALID', 'This sign-in origin is not allowed.', 403);
  return { ...siwsBindingForOrigin(allowed), origin: allowed };
}
/** Human-readable authorization scope, distinct from payment-wallet linking. */
export function loginStatement(purpose: LoginPurpose, userId: string | null): string {
  return purpose === 'login'
    ? 'Sign in to CT Life. This proves account access only; it does not authorize payments or transactions.'
    : `Add this wallet as a sign-in identity for CT Life player ${userId}. This grants access to that player account; it does not authorize payments or transactions.`;
}
/** The exact server bytes are signed; no message supplied at verify is accepted. */
export function createLoginMessage(c: Omit<LoginChallenge, 'message' | 'nearSignMessage'>): string {
  const statement = loginStatement(c.purpose, c.userId);
  if (c.network === 'eip155:4663')
    return createSiweMessage({
      address: getAddress(c.address),
      chainId: 4663,
      domain: c.domain,
      uri: c.uri,
      version: '1',
      nonce: c.nonce,
      issuedAt: new Date(c.issuedAt),
      expirationTime: new Date(c.expiresAt),
      requestId: c.id,
      statement,
      resources:
        c.purpose === 'login'
          ? ['urn:ctlife:purpose:login']
          : [`urn:ctlife:player:${c.userId}`, 'urn:ctlife:purpose:enrolment'],
    });
  return [
    `${c.domain} wants you to ${c.purpose === 'login' ? 'sign in to CT Life' : 'add a CT Life sign-in identity'}:`,
    c.address,
    '',
    statement,
    '',
    `Network: ${c.network}`,
    `Purpose: ${c.purpose}`,
    `Player: ${c.userId ?? 'new-or-existing'}`,
    `URI: ${c.uri}`,
    `Request ID: ${c.id}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expiresAt}`,
  ].join('\n');
}
function identity(r: IdentityRow): LoginIdentity {
  return {
    id: r.id,
    network: r.network,
    address: r.address,
    createdAt: r.created_at.toISOString(),
  };
}
/** Lock active account state after its address lock and enforce the durable ban. */
export async function lockActiveAuthUser(client: PoolClient, userId: string): Promise<void> {
  const r = await client.query(
    'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [userId],
  );
  if (!r.rowCount)
    throw authWalletError('AUTH_ACCOUNT_UNAVAILABLE', 'This player account is unavailable.', 403);
  await assertNotBannedDb(client, userId);
}
/** Issue exact five-minute bytes and bind any current owner for deletion invalidation. */
export async function issueLoginChallenge(
  ctx: WalletAuthContext,
  purpose: LoginPurpose,
  userId: string | null,
  input: { network: LoginNetwork; address: string },
  origin?: string,
  initiator?: CredentialClaims,
): Promise<LoginChallenge> {
  if ((purpose === 'login') !== (userId === null)) throw invalid();
  const b = walletAuthBinding(ctx, origin);
  const now = new Date();
  const fields = {
    id: uuidv7(),
    purpose,
    userId,
    network: input.network,
    address: normalizeWalletLinkAddress(input.network, input.address),
    proofScheme: walletLinkProofScheme(input.network) as LoginChallenge['proofScheme'],
    nonce: randomBytes(32).toString('hex'),
    domain: b.domain,
    uri: b.uri,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
  };
  const c: LoginChallenge = { ...fields, message: createLoginMessage(fields) };
  await runInTransaction(
    async (client) => {
      await lockWalletOwnership(client, c.network, c.address);
      const known = (
        await client.query<{ user_id: string }>(
          `SELECT user_id FROM login_identities WHERE network=$1 AND address=$2
 UNION SELECT l.user_id FROM economy_wallet_links l JOIN users u ON u.id=l.user_id WHERE l.network=$1 AND l.address=$2 AND l.ownership_released_at IS NULL AND u.deleted_at IS NULL LIMIT 1`,
          [c.network, c.address],
        )
      ).rows[0];
      const hint = userId ?? known?.user_id ?? null;
      if (hint !== null) await lockActiveAuthUser(client, hint);
      // Anonymous addresses are public: unsigned requests must not lock out their holder.
      // Authenticated enrolment can limit only the caller's own outstanding requests.
      const credential =
        userId !== null ? await assertAuthInitiator(client, ctx, userId, initiator) : null;
      if (userId !== null) {
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM login_identity_challenges WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
          [userId],
        );
        if (Number(count.rows[0]?.count) >= 10)
          throw authWalletError(
            'AUTH_CHALLENGE_LIMIT',
            'Too many pending enrolment requests. Wait for them to expire.',
            429,
          );
      }
      // Bounded expiry maintenance; SKIP LOCKED never waits on a verifier's row.
      await client.query(`DELETE FROM login_identity_challenges WHERE id IN (
        SELECT id FROM login_identity_challenges WHERE expires_at<=clock_timestamp()
        ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(
        `INSERT INTO login_identity_challenges(id,purpose,user_id,network,address,nonce,message,domain,uri,origin,issued_at,expires_at,account_hint,initiator_identity_id,initiator_session_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          c.id,
          c.purpose,
          c.userId,
          c.network,
          c.address,
          c.nonce,
          c.message,
          c.domain,
          c.uri,
          b.origin,
          c.issuedAt,
          c.expiresAt,
          hint,
          credential?.identityId ?? null,
          credential?.version ?? null,
        ],
      );
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  if (c.network === 'near:mainnet')
    c.nearSignMessage = {
      message: c.message,
      nonceBase64: Buffer.from(c.nonce, 'hex').toString('base64'),
      recipient: c.domain,
      callbackUrl: null,
      state: c.id,
    };
  return c;
}

/** A valid signature can claim login ownership only through this purpose-bound route. */
export async function completeLoginChallenge(
  ctx: WalletAuthContext,
  purpose: LoginPurpose,
  userId: string | null,
  challengeId: string,
  proof: WalletLinkProof,
  origin?: string,
  nearFullAccess?: NearFullAccessVerifier,
  initiator?: CredentialClaims,
): Promise<{ userId: string; identity: LoginIdentity; identityVersion: number }> {
  const row = await ctx.db.withConnection(
    async (c) =>
      (
        await c.query<ChallengeRow>(
          `SELECT * FROM login_identity_challenges WHERE id=$1 AND purpose=$2 AND user_id IS NOT DISTINCT FROM $3::uuid AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [challengeId, purpose, userId],
        )
      ).rows[0],
  );
  if (!row) throw invalid();
  const b = walletAuthBinding(ctx, origin);
  if (row.origin !== b.origin || row.domain !== b.domain || row.uri !== b.uri)
    throw authWalletError(
      'AUTH_ORIGIN_INVALID',
      'Sign-in origin does not match this challenge.',
      403,
    );
  const challenge = {
    id: row.id,
    userId: row.user_id ?? '',
    network: row.network,
    address: row.address,
    proofScheme: walletLinkProofScheme(row.network),
    nonce: row.nonce,
    message: row.message,
    domain: row.domain,
    uri: row.uri,
    origin: row.origin,
    nearCallbackUrl: null,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
  const verifier =
    nearFullAccess ??
    (row.network === 'near:mainnet'
      ? createNearFullAccessVerifier(ctx.config.economy.rpcUrls['near:mainnet'])
      : async () => false);
  if (!(await verifyWalletLinkProof(challenge, proof, verifier)))
    throw authWalletError('AUTH_PROOF_INVALID', 'The sign-in signature could not be verified.');
  const result = await runInTransaction(
    async (client) => {
      await lockWalletOwnership(client, row.network, row.address);
      const existing = (
        await client.query<IdentityRow>(
          'SELECT * FROM login_identities WHERE network=$1 AND address=$2',
          [row.network, row.address],
        )
      ).rows[0];
      const link = (
        await client.query<{ user_id: string }>(
          'SELECT l.user_id FROM economy_wallet_links l JOIN users u ON u.id=l.user_id WHERE l.network=$1 AND l.address=$2 AND l.ownership_released_at IS NULL AND u.deleted_at IS NULL',
          [row.network, row.address],
        )
      ).rows[0];
      const lockingOwner = userId ?? existing?.user_id ?? row.account_hint;
      if (lockingOwner !== null) await lockActiveAuthUser(client, lockingOwner);
      if (userId !== null) {
        const caller = await assertAuthInitiator(client, ctx, userId, initiator);
        if (
          row.initiator_identity_id !== caller.identityId ||
          row.initiator_session_version !== caller.version
        )
          throw invalid();
      }
      // Address -> user -> challenge lock order also permits account deletion.
      const consumed = await client.query(
        'UPDATE login_identity_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id',
        [row.id],
      );
      if (!consumed.rowCount) throw invalid();
      if (existing && userId !== null && existing.user_id !== userId)
        return authWalletError(
          'AUTH_IDENTITY_CONFLICT',
          'This sign-in identity belongs to another player.',
          409,
        );
      const owner = existing?.user_id ?? userId;
      if (link && (owner === null || link.user_id !== owner))
        return authWalletError(
          'AUTH_IDENTITY_ENROLMENT_REQUIRED',
          'Sign in to the existing player account and explicitly add this wallet as a sign-in identity.',
          409,
        );
      if (owner !== null) await lockActiveAuthUser(client, owner);
      if (existing) {
        if (existing.revoked_at !== null) {
          if (purpose === 'login') return credentialRevoked();
          await client.query('UPDATE login_identities SET revoked_at=NULL WHERE id=$1', [
            existing.id,
          ]);
          await recordAccountAccessEvent(
            client,
            existing.user_id,
            existing.id,
            'identity_reactivated',
            existing.network,
          );
        }
        if (purpose === 'login')
          await recordEvent(client, existing.user_id, {
            name: 'session_start',
            props: { method: 'wallet' },
          });
        return {
          userId: existing.user_id,
          identity: identity(existing),
          identityVersion: existing.session_version,
        };
      }
      const id = owner ?? uuidv7();
      if (owner === null)
        await client.query('INSERT INTO users(id,wallet,is_seeker) VALUES($1,NULL,false)', [id]);
      const added = (
        await client.query<IdentityRow>(
          'INSERT INTO login_identities(id,user_id,network,address) VALUES($1,$2,$3,$4) RETURNING *',
          [uuidv7(), id, row.network, row.address],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE login_identity_challenges SET account_hint=$3 WHERE network=$1 AND address=$2 AND account_hint IS NULL',
        [row.network, row.address, id],
      );
      if (owner === null)
        await recordEvent(client, id, {
          name: 'signup',
          props: { method: 'wallet', seeker: false },
        });
      if (purpose === 'login')
        await recordEvent(client, id, { name: 'session_start', props: { method: 'wallet' } });
      return { userId: id, identity: identity(added), identityVersion: added.session_version };
    },
    { isolation: 'read committed' },
    ctx.db,
  );
  if (result instanceof WalletLinkError) throw result;
  return result;
}

/** List explicit sign-in methods for the authenticated owner only. */
export async function listLoginIdentities(
  ctx: WalletAuthContext,
  userId: string,
): Promise<LoginIdentity[]> {
  return ctx.db.withConnection(async (client) =>
    (
      await client.query<IdentityRow>(
        'SELECT i.* FROM login_identities i JOIN users u ON u.id=i.user_id WHERE i.user_id=$1 AND u.deleted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at,i.id',
        [userId],
      )
    ).rows.map(identity),
  );
}

/** Authenticated mutations recheck the current credential under the player lock. */
export async function assertAuthInitiator(
  client: PoolClient,
  ctx: WalletAuthContext,
  userId: string,
  claims?: CredentialClaims,
) {
  if (!claims || claims.sub !== userId) throw credentialRevoked();
  assertRecentAuthentication(ctx.config, claims);
  return resolveLoginCredentialOn(client, claims);
}

export type AccountAccessEventKind =
  'identity_revoked' | 'identity_reactivated' | 'primary_solana_enrolled';
/** Transactional security history; never stores addresses, signatures, tokens or nonces. */
export async function recordAccountAccessEvent(
  client: PoolClient,
  userId: string,
  identityId: string,
  kind: AccountAccessEventKind,
  network: WalletLinkNetwork,
): Promise<void> {
  await client.query(
    'INSERT INTO account_access_events(id,user_id,identity_id,kind,network) VALUES($1,$2,$3,$4,$5)',
    [uuidv7(), userId, identityId, kind, network],
  );
}
/** Latest owner-scoped events for the existing sign-in-wallet screen. */
export async function listAccountAccessEvents(ctx: WalletAuthContext, userId: string) {
  return ctx.db.withConnection(async (client) =>
    (
      await client.query<{
        id: string;
        identity_id: string;
        kind: AccountAccessEventKind;
        network: WalletLinkNetwork;
        created_at: Date;
      }>(
        'SELECT e.* FROM account_access_events e JOIN users u ON u.id=e.user_id WHERE e.user_id=$1 AND u.deleted_at IS NULL ORDER BY e.created_at DESC,e.id DESC LIMIT 20',
        [userId],
      )
    ).rows.map((r) => ({
      id: r.id,
      identityId: r.identity_id,
      kind: r.kind,
      network: r.network,
      createdAt: r.created_at.toISOString(),
    })),
  );
}
