/**
 * Auth service.
 *
 * Handles Sign In With Solana (SIWS) challenge generation, signature
 * verification, and the issuance of access + refresh tokens. Also
 * implements the dev auth bypass for the local/mock environments.
 *
 * Layering: this is application code. It calls the JWT issuer and
 * the Helius client. It does not touch the transport layer.
 */
import { PublicKey } from '@solana/web3.js';
import { createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ForbiddenError,
  NonceInvalidError,
  SignatureInvalidError,
  SGTAlreadyLinkedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { runInTransaction } from '../shared/db/uow.js';
import type { AppContext, NonceRecord } from './context.js';
import { NONCE_TTL_MS } from './context.js';

/** The contract's SIWS challenge shape (contract section 3.1). */
export interface Challenge {
  readonly nonce: string;
  readonly domain: string;
  readonly statement: string;
  readonly uri: string;
  readonly version: '1';
  readonly chainId: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly wallet: string;
  readonly isSeeker: boolean;
  readonly hasCharacter: boolean;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export class AuthService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Issue a SIWS challenge for a wallet. The wallet param is
   * optional; the nonce is not bound to a wallet until verify.
   */
  async issueChallenge(wallet: string | null): Promise<Challenge> {
    if (wallet !== null) {
      // Validate the wallet format early so the client gets a clear
      // 400 rather than a base64 decode error later.
      try {
        new PublicKey(wallet);
      } catch {
        throw new ValidationFailedError({ reason: 'invalid_wallet' });
      }
    }
    // B7 fix: Use alphanumeric nonce (no hyphens) for Seed Vault compatibility
    const nonce = randomUUID().replace(/-/g, '');
    const issuedAt = new Date();
    const expires = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    await this.ctx.nonces.put(nonce, NONCE_TTL_MS, issuedAt, expires);
    const cfg = this.ctx.config;
    return {
      nonce,
      domain: cfg.siws.domain,
      statement: 'Sign in to CT Life.',
      uri: cfg.siws.uri,
      version: '1',
      chainId: cfg.solana.cluster === 'mainnet' ? 'solana:mainnet' : 'solana:devnet',
      issuedAt: issuedAt.toISOString(),
      expirationTime: expires.toISOString(),
    };
  }

  /**
   * Verify the signed challenge. Mints the user if the wallet is
   * unseen, runs the SGT check, and returns the access + refresh
   * tokens.
   */
  async verifyAndAuthenticate(input: VerifyInput): Promise<AuthenticatedUser> {
    const nonceRec = await this.ctx.nonces.get(input.nonce);
    if (!nonceRec) {
      throw new NonceInvalidError({});
    }
    if (nonceRec.used) {
      throw new NonceInvalidError({ reason: 'already_used' });
    }
    // B8 fix: Decode signedMessage from base64
    const signedMessageText = decodeSignedMessage(input.signedMessage);
    const signedMessageBytes = Buffer.from(input.signedMessage, 'base64');

    // B6 fix: Verify the signed message matches the challenge field-for-field
    const cfg = this.ctx.config;
    const chainId = cfg.solana.cluster === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
    const siws = { domain: cfg.siws.domain, uri: cfg.siws.uri, chainId };
    if (!verifySignedMessage(signedMessageText, nonceRec, input.address, siws)) {
      throw new SignatureInvalidError({});
    }
    // Verify the ed25519 signature over the bytes
    const ok = verifySignature(input.address, signedMessageBytes, input.signature);
    if (!ok) {
      throw new SignatureInvalidError({});
    }
    // Mark the nonce used BEFORE we do DB work, to prevent replay.
    const marked = await this.ctx.nonces.markUsed(input.nonce, input.address);
    if (!marked) {
      throw new NonceInvalidError({ reason: 'race' });
    }
    // Upsert the user and check SGT.
    const user = await this.upsertUserWithSgt(input.address);
    const tokens = await this.mintTokens(user);
    // B14 fix: Check if user has a character
    const hasCharacter = await this.checkHasCharacter(user.id);
    return { ...user, ...tokens, hasCharacter };
  }

  /**
   * Dev auth bypass. Only available when `Config.auth.devAuthEnabled`
   * is true. Creates the user if unseen; no signature is required.
   */
  async devAuthenticate(wallet: string): Promise<AuthenticatedUser> {
    if (!this.ctx.config.auth.devAuthEnabled) {
      throw new ForbiddenError({ reason: 'dev_auth_disabled' });
    }
    try {
      new PublicKey(wallet);
    } catch {
      throw new ValidationFailedError({ reason: 'invalid_wallet' });
    }
    const user = await this.upsertUser(wallet, false);
    const tokens = await this.mintTokens(user);
    // B14 fix: Check if user has a character
    const hasCharacter = await this.checkHasCharacter(user.id);
    return { ...user, ...tokens, hasCharacter };
  }

  /** Refresh: re-mint an access token. Revokes the old refresh token (single-use). */
  async refresh(refreshToken: string): Promise<{
    id: string;
    wallet: string;
    isSeeker: boolean;
    accessToken: string;
    refreshToken: string;
  }> {
    const claims = await this.ctx.jwt.verifyRefresh(refreshToken);
    const jti = claims.jti;
    if (jti === undefined) throw new SignatureInvalidError({ reason: 'no_jti' });
    const usedKey = `refresh:used:${jti}`;
    const set = await this.ctx.redis.main.set(usedKey, '1', 'EX', 30 * 24 * 60 * 60, 'NX');
    if (set !== 'OK') {
      throw new SignatureInvalidError({ reason: 'refresh_replay' });
    }
    // Look up the user to get the wallet.
    const user = await this.findUser(claims.sub);
    if (user === null) throw new SignatureInvalidError({ reason: 'no_user' });
    // The contract answers refresh with a user as well, so return the row
    // the rotation already had to load.
    const tokens = await this.mintTokens(user);
    return { ...user, ...tokens };
  }

  /** Logout: mark the refresh token used. Best-effort. */
  async logout(refreshToken: string): Promise<void> {
    try {
      const claims = await this.ctx.jwt.verifyRefresh(refreshToken);
      const jti = claims.jti;
      if (jti !== undefined) {
        await this.ctx.redis.main.set(`refresh:used:${jti}`, '1', 'EX', 30 * 24 * 60 * 60);
      }
    } catch {
      // Best effort.
    }
  }

  // -- private helpers ----------------------------------------------

  private async upsertUserWithSgt(wallet: string): Promise<UserRow> {
    // Look up the SGT mints for this wallet. The Helius call may
    // fail (rate limit, timeout). We default to isSeeker=false on
    // failure and let the user retry.
    let sgtMints: string[] = [];
    try {
      sgtMints = await this.ctx.helius.sgtMintsFor(
        wallet,
        'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te',
      );
    } catch {
      sgtMints = [];
    }
    const sgtMint = sgtMints[0] ?? null;
    const isSeeker = sgtMint !== null;
    return this.upsertUser(wallet, isSeeker, sgtMint);
  }

  private async upsertUser(
    wallet: string,
    isSeeker: boolean,
    sgtMint: string | null = null,
  ): Promise<UserRow> {
    return runInTransaction(async (client) => {
      // Try to fetch the existing user.
      const existing = await client.query<{
        id: string;
        wallet: string;
        is_seeker: boolean;
      }>('SELECT id, wallet, is_seeker FROM users WHERE wallet = $1', [wallet]);
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0]!;
        // If the user is verifying with a new SGT and the SGT is
        // already linked to another account, refuse.
        if (sgtMint !== null) {
          const dupe = await client.query<{ id: string }>(
            'SELECT id FROM users WHERE sgt_mint = $1 AND id != $2',
            [sgtMint, row.id],
          );
          if (dupe.rowCount && dupe.rowCount > 0) {
            throw new SGTAlreadyLinkedError({});
          }
          await client.query('UPDATE users SET sgt_mint = $1, is_seeker = $2 WHERE id = $3', [
            sgtMint,
            isSeeker,
            row.id,
          ]);
        } else if (row.is_seeker !== isSeeker) {
          await client.query('UPDATE users SET is_seeker = $1 WHERE id = $2', [isSeeker, row.id]);
        }
        return { id: row.id, wallet: row.wallet, isSeeker: row.is_seeker || isSeeker };
      }
      // New user.
      const id = uuidv7();
      try {
        await client.query(
          `INSERT INTO users (id, wallet, is_seeker, sgt_mint)
           VALUES ($1, $2, $3, $4)`,
          [id, wallet, isSeeker, sgtMint],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          // Race: another insert won. Re-fetch.
          const racer = await client.query<{ id: string; wallet: string; is_seeker: boolean }>(
            'SELECT id, wallet, is_seeker FROM users WHERE wallet = $1',
            [wallet],
          );
          const row = racer.rows[0]!;
          return { id: row.id, wallet: row.wallet, isSeeker: row.is_seeker };
        }
        throw e;
      }
      return { id, wallet, isSeeker };
    });
  }

  private async findUser(userId: string): Promise<UserRow | null> {
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{ id: string; wallet: string; is_seeker: boolean }>(
        'SELECT id, wallet, is_seeker FROM users WHERE id = $1',
        [userId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return { id: row.id, wallet: row.wallet, isSeeker: row.is_seeker };
    });
  }

  private async mintTokens(user: UserRow): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await this.ctx.jwt.signAccess(user.id, user.wallet, user.isSeeker);
    const refreshToken = await this.ctx.jwt.signRefresh(user.id, randomUUID());
    return { accessToken, refreshToken };
  }

  /**
   * B14 fix: Check if user has a character
   */
  private async checkHasCharacter(userId: string): Promise<boolean> {
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{ id: string }>(
        'SELECT id FROM characters WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      return r.rowCount !== null && r.rowCount > 0;
    });
  }
}

export interface UserRow {
  readonly id: string;
  readonly wallet: string;
  readonly isSeeker: boolean;
}

export const VerifyInputSchema = z.object({
  address: z.string().min(32).max(64),
  signedMessage: z.string().min(1),
  signature: z.string().min(1),
  nonce: z.string().min(1),
});

export type VerifyInput = z.infer<typeof VerifyInputSchema>;

/**
 * B8 fix: Decode base64 signedMessage to string
 */
function decodeSignedMessage(signedMessageBase64: string): string {
  try {
    return Buffer.from(signedMessageBase64, 'base64').toString('utf8');
  } catch {
    throw new ValidationFailedError({ reason: 'invalid_base64' });
  }
}

/**
 * B6 fix: Parse and verify SIWS message structure
 */
interface ParsedSIWS {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

function parseSIWSMessage(message: string): ParsedSIWS | null {
  const lines = message.split('\n').map((l) => l.trim());
  if (lines.length < 8) return null;

  // Line 0: "<domain> wants you to sign in with your Solana account:"
  const domainMatch = lines[0]?.match(/^(.+?) wants you to sign in with your Solana account:$/);
  if (!domainMatch) return null;
  const domain = domainMatch[1]!;

  // Line 1: <address>
  const address = lines[1] ?? '';
  if (!address) return null;

  // Line 2: blank
  if (lines[2] !== '') return null;

  // Line 3: <statement>
  const statement = lines[3] ?? '';

  // Line 4: blank
  if (lines[4] !== '') return null;

  // Remaining lines: key-value pairs
  const fields: Record<string, string> = {};
  for (let i = 5; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  return {
    domain,
    address,
    statement,
    uri: fields['URI'] ?? '',
    version: fields['Version'] ?? '',
    chainId: fields['Chain ID'] ?? '',
    nonce: fields['Nonce'] ?? '',
    issuedAt: fields['Issued At'] ?? '',
    expirationTime: fields['Expiration Time'] ?? '',
  };
}

function verifySignedMessage(
  signedMessage: string,
  nonce: NonceRecord,
  wallet: string,
  config: { domain: string; uri: string; chainId: string },
): boolean {
  // B6 fix: Parse and verify SIWS message structure
  const parsed = parseSIWSMessage(signedMessage);
  if (!parsed) return false;

  // Verify all fields match the challenge
  if (parsed.domain !== config.domain) return false;
  if (parsed.address !== wallet) return false;
  if (parsed.uri !== config.uri) return false;
  if (parsed.version !== '1') return false;
  if (parsed.chainId !== config.chainId) return false;
  if (parsed.nonce !== nonce.nonce) return false;

  // Verify issued-at and expiration-time match what we issued
  const issuedAt = new Date(nonce.issuedAt).toISOString();
  const expirationTime = new Date(nonce.expiresAt).toISOString();
  if (parsed.issuedAt !== issuedAt) return false;
  if (parsed.expirationTime !== expirationTime) return false;

  // Verify expiration is in the future
  if (nonce.expiresAt <= Date.now()) return false;

  return true;
}

function verifySignature(wallet: string, signedMessage: Buffer, signatureB64: string): boolean {
  try {
    const pubkey = new PublicKey(wallet);
    const sig = Buffer.from(signatureB64, 'base64');
    // B0 fix: node:crypto cannot take a raw 32-byte ed25519 key (ERR_OSSL_UNSUPPORTED); wrap it as SPKI DER.
    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(pubkey.toBytes()),
      ]),
      format: 'der',
      type: 'spki',
    });
    return ed25519Verify(null, signedMessage, pub, sig);
  } catch {
    return false;
  }
}
