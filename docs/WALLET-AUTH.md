# Wallet sign-in and explicit login identities

EVM and NEAR players can create a CT Life player UUID without a Solana wallet. Existing SIWS users keep their UUID, character, inventory and primary Solana wallet. `users.wallet` and access-token `wal` are nullable; null is not an address and grants no Solana-specific entitlement. Payment-wallet links remain a separate identity proof for payment attribution. They never become sign-in credentials implicitly.

## Signing contract

Primary sources checked 2026-11-05: [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) defines the SIWE message, checksum address, chain, nonce and EIP-191 EOA verification; [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) defines the recipient, 32-byte nonce, optional callback, tagged Borsh payload and FullAccess signature. Existing pinned `viem` and Node Ed25519 verification are reused; no new dependency, live signing or funds transfer is involved.

The new routes support `eip155:4663` EOAs and `near:mainnet` accounts with an Ed25519 FullAccess key. EIP-1271/EIP-6492 smart-contract signatures are not supported. NEAR ownership is checked against a configured mainnet RPC at finalized state on each login/enrolment proof; pending, unavailable, FunctionCall and removed keys fail closed. A session records the identity used at login; refreshing it does not perform a continuous NEAR key-state subscription or sign a new proof.

- Anonymous `POST /v1/auth/wallet/challenge` accepts exactly `{network,address}` and returns 201.
- Authenticated `POST /v1/auth/identities/challenge` accepts the same body for explicit enrolment into the current UUID.
- Both return `{id,purpose,userId,network,address,proofScheme,nonce,message,domain,uri,issuedAt,expiresAt}`. `purpose` is `login` or `enrolment`; `userId` is null for login and the authenticated UUID for enrolment. Nonce is 64 lowercase hex characters; timestamps are ISO strings with milliseconds; TTL is five minutes.
- NEAR additionally returns `nearSignMessage:{message,nonceBase64,recipient,callbackUrl:null,state}`. The nonce decodes to the same 32 bytes; recipient is domain and state is challenge ID. Callback is explicitly Borsh `None`, never a client-supplied redirect.
- Corresponding `POST .../verify` accepts exactly `{challengeId,signature,publicKey?}`. EVM signature is 65-byte hex with no publicKey; NEAR uses canonical base64 signature and `ed25519:<base58>` publicKey. The server verifies its persisted message, never a submitted replacement.

The exact generated text lives in `server/application/wallet-auth.ts:createLoginMessage`. SIWE uses checksummed message address, chain 4663, request ID and expiry. Login statement:

> Sign in to CT Life. This proves account access only; it does not authorize payments or transactions.

Login resource is `urn:ctlife:purpose:login`. Enrolment statement:

> Add this wallet as a sign-in identity for CT Life player {userId}. This grants access to that player account; it does not authorize payments or transactions.

Enrolment resources are `urn:ctlife:player:{userId}` followed by `urn:ctlife:purpose:enrolment`. NEAR signs the same statement in explicit domain/account/network/purpose/player/URI/request/nonce/time lines. Browser guards reconstruct and compare the entire message before requesting a signature. Wallet-link proofs retain their different statement and purpose.

## Sessions, ownership and retries

Login returns existing `{accessToken,refreshToken,user}` plus the legacy flat fields. Both flat and nested user fields include nullable `wallet`, `authMethod` (`siws`, `dev`, `wallet`) and `loginIdentity:{id,network,address}`. Refresh returns the same identity and method; JWT `lid` and `am` carry them in both token types. Pre-migration refresh tokens can resolve only their owner's existing primary Solana identity. Refresh remains single-use. Signed `auth_time` records the original verified sign-in and is copied unchanged into both rotated tokens. Legacy tokens without it remain unknown; refresh never upgrades `iat` into authentication evidence. Deleted or banned users cannot sign in or rotate sessions.

Both enrolment challenge and verification require a verified sign-in within ten minutes, allowing at most 30 seconds of future clock skew. Missing or stale `auth_time` returns `403 AUTH_REAUTH_REQUIRED`; sign in to the existing player account again before adding a credential. A dev login qualifies only while explicitly enabled in local/mock scope. The ten-minute threshold is CT Life policy, informed by [OWASP’s requirement for re-authentication before sensitive account changes](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features), not a timing requirement imposed by that standard.

Enrolment verification returns `{identity:{id,network,address,createdAt}}`. `GET /v1/auth/identities` lists only the authenticated player's explicitly enrolled identities, including the legacy primary Solana identity. It lists sign-in methods, not payment permissions. There is no revoke endpoint in this slice. There is also no primary-Solana enrolment ceremony for an EVM/NEAR-first account: its primary Solana wallet remains null, and the existing Solana payment-link rule returns `WALLET_LINK_PRIMARY_REQUIRED`. Do not present SOL/ORE payment connectivity as available to that account until a separately verified primary-Solana enrolment flow exists.

A valid payment link belonging to an active player, including a revoked payment link, blocks anonymous creation with `409 AUTH_IDENTITY_ENROLMENT_REQUIRED`. Sign in to that existing player first and enrol explicitly. An identity owned by another player gives `409 AUTH_IDENTITY_CONFLICT`. New login claims and payment-link claims share a PostgreSQL address lock, then user and challenge locks. Database uniqueness is the final same-table constraint. Valid successful/conflicting proofs are consumed; replay/expiry/wrong purpose or owner returns `AUTH_CHALLENGE_INVALID`. Wrong origin gives `AUTH_ORIGIN_INVALID`; invalid signature gives `AUTH_PROOF_INVALID`. All issuance and verification use the existing per-IP login limit; verification also holds the global login semaphore. Anonymous issuance has no victim-address cap: unsigned requests cannot exhaust another wallet’s sign-in slots. Authenticated enrolment limits only the caller’s outstanding requests. Each issuance removes at most 100 expired rows using an expiry index and skip-locked selection.

A response lost after successful verification requires a fresh challenge/signature. The next login resolves the same durable identity and UUID; it cannot create a duplicate account. No anonymous token-response cache is introduced. Login identities authenticate account access only: every payment still requires its own explicit wallet authorization and verified receipt.

## Deletion and migration compatibility

Migration 153 makes the Solana field nullable and backfills existing Solana identities. Apply it before code that queries the new tables. Do not route non-Solana clients to older backend binaries that require a non-null wallet. Old SIWS writers remain address-compatible; a new verifier creates a missing explicit Solana identity for a legacy row. The payment-link unique index changes to a partial current-owner index: old payment writers using `ON CONFLICT(network,address)` without its predicate are incompatible after migration 153. Coordinate the writer cutover; this is not a mixed-version rolling release guarantee. No deployment is performed here.

Account deletion preserves the established fresh-signup policy. It deletes login identities/challenges, invalidates outstanding proofs bound before the first ownership claim, clears the primary wallet and releases/revokes payment links. Original link IDs, order UUIDs and refund/receipt ownership remain attached to the deleted UUID. A fresh signature can create a new UUID and a newly verified payment link with the same address; it cannot access old inventory or transfer historical obligations. Active-owner payment revocation does not release ownership. Authorized REST requests and realtime joins check durable active-account state even if the Redis deletion flag is missing.

Rollback refuses null-wallet accounts, non-Solana enrolled identities or repeated payment-address history. It does not discard an account or retained evidence to fit the old schema. Migration was exercised only on the disposable local economy database; no deployment or external migration is part of this change.

## Validation and limits

Generated-signature PostgreSQL/HTTP regressions cover new/returning login, concurrent claims, payment-link conflicts, explicit enrolment, origin/purpose/expiry/replay rejection, NEAR key permissions, ban/deletion, refresh rotation, legacy SIWS/SGT eligibility, and non-Solana `/me` → birth lottery → character creation. Fixtures call no external chain or real wallet. Browser/API contract fixtures cover both signing formats and purposes. Native APK EVM/NEAR wallet transport and live wallet acceptance are separate, unverified work; this backend does not claim those journeys work.
