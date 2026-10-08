# CT Life backend: fixes handed over to Iyke

- **What this is:** the backend work we found while running the Unity client against your stack. It is written for you (GitHub devIykee) and for your own coding agent. You should not need to ask us anything to act on it. We will not fix the backend ourselves.
- **Tested commit:** `main` @ `9f3e5ef` (= origin/main, 2026-10-06). Every file path and line number below was read from that commit (`git show 9f3e5ef:<path>`). Our checkout has exactly one local change, `server/application/auth.ts` (the B0 patch). Nothing else was edited.
- **How we tested:** your stack run locally (API :4010, realtime :2567, Postgres, Redis and LiveKit in Docker; workers off, see B12), the Unity client in the editor and on a Solana Seeker phone with a real Seed Vault wallet, and curl.
- **Date:** 2026-10-08.
- **Order = priority.** Work the groups P0 to P6 in order. Inside a group, go top to bottom.
- **Contact:** the frontend side (whoever sent you this document).

**Numbering.** `B<n>` is the item number from our prioritized summary (B0 to B30). B31 to B38 are extra items from our longer log that the summary did not carry; they are marked "extra". `#<n>` points to the matching entry in our long log (`companions/backend-feedback-long-log.md` in this bundle). "(source)" means we found it by reading code and did not reproduce it live. Anything without "(source)" was reproduced live.

**Companion files sent with this document** (they are inputs for specific items): `0001-siws-ed25519-spki-key.patch` (B0, also pasted in the appendix), `ids/spots.json` version `1.0.0-rc1+fe.2` (B27), `careers-minigames-20261008.md` (B4, B18), `snow-starter-look.md`, `rain-starter-look.md` and `vincent-starter-look.md` (B13, starter looks), `npc-world-life-20261008.md` (B17), and the `phase4-6/` contract proposal (B26, B30).

---

## 1. How to use this with your coding agent

- Fix the items in order. Open one PR per group: P0 sign-in, P1 security, P2 Phase-1 blockers, P3 money, P4 voice and social, P5 city life, P6 tooling. B6 needs B7 and B8 in the same release (see B6).
- Each item is self-contained. The "Code" field lists every place we know of. The "Done when" field is the acceptance check. Do not close an item until it passes.
- The contract in `contract/` is the source of truth. The Unity client is generated from it. Do not rename or retype any contract field. If you think the contract is wrong, change the contract file in the same PR and tell us, but keep it additive.
- Add one test per security item (P1). The test must fail on `9f3e5ef` and pass after your fix. The pattern to copy is `server/api/authz.test.ts` (it uses `buildServer()` and `app.inject()`).
- Run `pnpm typecheck` and `pnpm test:unit` before every PR. On a clean `.env` about 6 of 316 tests and 3 typecheck errors already fail on `main`. They are tooling problems, not regressions (see B29). Do not mistake them for your changes, and please fix them in the P6 PR.
- Items listed under "Decisions needed" (section 4) need a reply from us or from you, not code. Where an item depends on one, the item says so and gives a default.
- Do not break the endpoints in section 5. The client uses them today.
- The "Done when" checks use these shell helpers. They need `ENABLE_DEV_AUTH=true` and the API on :4010. `A`, `B`, `C` are three valid public keys used as dev wallets.

```sh
API=http://localhost:4010/v1
A=Dgw3c4GbQnZe1FeaCa29vXtoyv6fxmxAVyynQw8mN2gZ
B=So11111111111111111111111111111111111111112
C=Vote111111111111111111111111111111111111111
tok()  { curl -s -X POST $API/auth/dev -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"wallet\":\"$1\"}" | jq -r .accessToken; }
uid()  { curl -s -X POST $API/auth/dev -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"wallet\":\"$1\"}" | jq -r '.user.id // .id'; }
get()  { curl -s -w ' [%{http_code}]\n' "$API$1" -H "authorization: Bearer $2"; }
post() { local b="${3:-}"; [ -n "$b" ] || b='{}'; curl -s -w ' [%{http_code}]\n' -X POST "$API$1" -H "authorization: Bearer $2" -H 'content-type: application/json' -H "Idempotency-Key: ${4:-$(uuidgen)}" -d "$b"; }
j()    { sed 's/ \[[0-9]*\]$//' | jq -r "$1"; }   # pipe get/post output into: j .field
```

A new dev user has $0. To give one cash, call `post /lottery/roll $TOKEN` before creating a character (this is the working order, see B13).

---

## P0. Sign-in

### B0 Real wallets can never sign in (ed25519 key is passed raw)
- **Priority / area:** P0 · auth. Blocks every real sign-in.
- **Endpoint or room:** `POST /v1/auth/verify`
- **Code:** `server/application/auth.ts` → `verifySignature()` (line 290). The raw 32-byte key is built at line 295 (`Buffer.from(pubkey.toBytes())`) and passed to `ed25519Verify` at line 296. The `catch` at line 297 returns `false`. The caller is `AuthService.verifyAndAuthenticate()` (lines 93 to 119; the `SignatureInvalidError` is thrown at lines 106 to 108). The `node:crypto` import is at line 12.
- **Now (observed):** `node:crypto` `verify()` throws `ERR_OSSL_UNSUPPORTED` when given a raw 32-byte Buffer as the key. The `catch` swallows it and the route answers `401 SIGNATURE_INVALID` for every real wallet signature. Seen live on 2026-10-08 on the Seeker: Seed Vault signed correctly, the server rejected it. We also reproduced it in a standalone Node 24.5 script: the raw key throws `ERR_OSSL_UNSUPPORTED`, the SPKI-wrapped key returns `true`. Dev auth (`/auth/dev`) hides the bug because it never verifies a signature.
- **Expected (contract):** `contract/openapi.yaml` `postAuthVerify` (line 96): "Verifies the Ed25519 signature against the nonce". `docs/spec/contract.md` section 3, step 5 (line 161 area): the Ed25519 signature must be valid for the address.
- **Fix:** wrap the raw key as SPKI DER before verifying: `createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), raw32]), format:'der', type:'spki' })`. The exact patch is in the appendix; apply it as is. Export `verifySignature` (or test through `AuthService`) so it can be unit tested. B6 and B8 touch the same function.
- **Done when:** (1) new unit test, which fails before and passes after:
  ```ts
  import { generateKeyPairSync, sign } from 'node:crypto';
  import { PublicKey } from '@solana/web3.js';
  it('verifies an ed25519 signature for a base58 wallet', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const wallet = new PublicKey(raw).toBase58();
    const sig = sign(null, Buffer.from('hello', 'utf8'), privateKey).toString('base64');
    expect(verifySignature(wallet, 'hello', sig)).toBe(true);
    expect(verifySignature(wallet, 'other', sig)).toBe(false);
  });
  ```
  (2) End to end: save the smoke script from the appendix as `tools/scripts/siws-smoke.mjs` and run `node tools/scripts/siws-smoke.mjs` from the repo root. It must print `200` with `accessToken` and `refreshToken`. (With B8 not yet fixed it must run in its default `utf8` mode.)
- **Client impact:** unblocks real SIWS sign-in with Seed Vault (the whole device flow). No client workaround to remove. The editor and bots keep using `/auth/dev`.

---

## P1. Security

### B1 Any player can settle a Beef match and pick the winner
- **Priority / area:** P1 · security · money (source).
- **Endpoint or room:** `POST /v1/beef/:id/settle`
- **Code:** `server/api/routes/ratio-arena.ts` → route registration (lines 70 to 80): preHandler is only `[requireAuth, withIdempotency()]`, body is `{winnerUserId}` (lines 33 to 35). Service: `server/application/ratio-arena.ts` → `settleMatch()` (line 275). It takes no caller, only checks the winner is a participant (line 296), then credits `2 × stake − 5%` to the winner (lines 310 to 325). Admin pattern used elsewhere: `server/api/routes/push-meta-ads.ts` lines 83 to 92 and `server/api/routes/airdrop-farm.ts` lines 39 to 47 (`role !== 'admin'`).
- **Now (observed):** no admin or participant check. Any signed-in user can settle an active match and name either side the winner. (source)
- **Expected (contract):** the route has no operation in `contract/openapi.yaml` (see B30). Rule to enforce: only a trusted server actor may settle.
- **Fix:** (1) Add a `requireAdmin` helper in `server/api/middleware/auth.ts` and use it on this route. (2) Note: the existing admin checks read `req.user.role`, but `signAccess()` never writes a `role` claim (`server/shared/auth/jwt.ts` lines 84 to 95; `AccessClaims` lines 33 to 38 has no `role`). So today every admin route answers 403 to everyone. Pick one source of truth for admin: a config allowlist (for example `ADMIN_WALLETS`, compared with the `wal` claim), or add a `role` claim at sign time from that allowlist. (3) Make all existing `role !== 'admin'` checks use the same helper. (4) Do not let a participant settle their own match. Default if you do not reply on the settlement design: admin only now; votes later.
- **Done when:** vitest in `authz.test.ts`: two users open and accept a match (each needs cash, see helper note). `POST /v1/beef/{id}/settle {winnerUserId}` as a participant returns `403 FORBIDDEN`. As an admin it returns 200. Balances are unchanged after the 403.
- **Client impact:** none today. Needed before Beef ships (Phase 6).

### B2 Cabal invites leak every code, and anyone can accept
- **Priority / area:** P1 · security · access gate (source).
- **Endpoint or room:** `GET /v1/cabal/invites`, `POST /v1/cabal/invites/:id/accept`
- **Code:** `server/api/routes/venues-gating.ts` → list route (lines 61 to 75; `hostId`, `guestId`, `used` are caller-supplied filters), accept route (lines 51 to 59). `server/application/venues-gating.ts` → `listCabalInvites()` (line 165; returns `code` for every row via `rowToInvite()`, line 199), `acceptCabalInvite()` (line 129; looks the invite up by `invite_id`, never checks `code`), `createCabalInvite()` (line 108).
- **Now (observed):** with no filter the list returns every invite in the system with its bearer `code`. Accept needs only the invite id (which the list also returns), so any signed-in user can redeem any invite. The file header says the guest "redeems" the 32-char code, but the code is never compared. (source)
- **Expected (contract):** no operation in `contract/openapi.yaml` (see B30). Rule: a code is a secret shown only to the host; a guest proves they hold it.
- **Fix:** (1) `GET /cabal/invites` returns only invites where `host_user_id = caller` or `guest_user_id = caller`; ignore `hostId`/`guestId` from the query. (2) Return `code` only to the host. (3) `accept` takes `{ code }` in the body, compares it in constant time with the stored code, and returns the invite without the code. (4) Keep the existing checks (not your own invite, not used, not expired).
- **Done when:** vitest: A creates an invite. B lists and sees no row for A and no `code`. B accepts with only the id and gets 400/403. B accepts with a wrong code and gets 403. B accepts with the right code and gets 200 with no `code` in the body. A second accept returns 403.
- **Client impact:** none today. Needed before the Cabal Lounge (Phase 6).

### B3 `POST /video-calls` hands the caller every participant's LiveKit token
- **Priority / area:** P1 · security · voice (verified live, #68).
- **Endpoint or room:** `POST /v1/video-calls`
- **Code:** `server/application/video-calls.ts` → `startVideoCall()` (line 63): tokens are minted for every participant at lines 98 to 116 and returned at line 126. Route: `server/api/routes/video-calls.ts` lines 25 to 36 (returns 201 with `{call, tokens}`). Room name `video:${callId}` at `video-calls.ts` line 81. Kinds: `server/shared/livekit/token.ts` line 18 (`'venue' | 'space' | 'video' | 'paid_call'`).
- **Now (observed):** with two dev users, A posts `{"userIds":["<B id>"]}` and gets `{call, tokens:[{userId:A, token}, {userId:B, token}]}` (2 tokens). A can join the call as B. Invitees get no notification (B16).
- **Expected (contract):** `postVideoCalls` (`contract/openapi.yaml` line 1831): response `{ callId }` only, status 200. `postRtcToken` (line 1623): each participant fetches only their own token with `POST /rtc/token {kind, id}`; kind enum is `venue | space | call`; the room is `{kind}:{id}`.
- **Fix:** (1) `startVideoCall` returns `{ callId }` (and may include the host's own token only). (2) Implement `POST /rtc/token` (B23) and have it mint a token only for `req.user.sub`, only if that user is a participant of the call (a `voice_speakers` row for the room, not ended). (3) Map contract kind `call` to the internal `video` kind and room name (or rename them to match; the contract says `call:{callId}`). (4) Never return another user's token from any endpoint.
- **Done when:** vitest: A starts a call with B. The response contains no token for B. `POST /rtc/token {kind:'call', id}` as C (not a participant) returns 403. As B it returns B's token, and decoding it shows `sub`/identity = B's id.
- **Client impact:** unblocks calls safely. The client already expects `{callId}` plus a per-user token request; it has no workaround to remove.

### B4 Shift pay accepts mini-games that were never assigned
- **Priority / area:** P1 · security · money (verified live, careers proposal section 6).
- **Endpoint or room:** `POST /v1/shifts/:shiftId/complete`
- **Code:** `server/application/shifts.ts` → `complete()` (line 97): loop at lines 113 to 119 uses `games.find(...)`, `cap = g?.maxScore ?? 100` for unknown ids (line 115), and adds every submitted result to both the score and the denominator. `start()` (line 62) stores a single `miniGameId` (`levels[0]`, line 74). Shifts live in an in-memory `Map` (line 40). Route: `server/api/routes/work.ts` lines 68 to 80.
- **Now (observed):** a 0/10 `discord_mod_ban` plus an invented `{miniGameId:"made_up_game", score:100}` paid 3636 cents instead of 0 (4000 × 100/110). Each extra result raises the pay ratio. A second completion with a new key returns `404 NOT_FOUND {kind:'shift_completed'}`.
- **Expected (contract):** `postShiftsShiftIdComplete` (`contract/openapi.yaml` line 761): scores are capped at `maxScore` from `mini_games.json`; pay and XP derive from the scores. `Shift.miniGameIds` (the assigned set) is returned by `postShifts` (line 733).
- **Fix:** (1) Store the assigned `miniGameIds` on the shift. (2) In `complete`, reject any `miniGameId` not in the assigned set with `400 VALIDATION_FAILED`; ignore duplicate ids (count the first once); treat assigned ids that were not submitted as score 0; compute `maxPossible` only from the assigned set. (3) Remove the `?? 100` fallback. (4) Move shifts out of the process-local Map (DB or Redis with TTL) so a restart or a second replica cannot lose or double-complete a shift. (5) For a repeat completion return `409` with the original receipt instead of `404` (our proposal; the client currently treats the 404 as "already paid").
- **Done when:** vitest: start a shift; complete it after `endsAt` with `[{assigned, 0},{made_up_game,100}]` → 400 and no ledger row. Complete with only the assigned game at 8/10 → `payCents` = 80% of level pay. Completing twice never creates two ledger rows.
- **Client impact:** the client already sends exactly the assigned games once each, capped. After the fix, the "404 = already paid" workaround can become a normal 409 receipt.

### B5 Realtime rooms do not authenticate: every player is `unverified-eyJhbGci`
- **Priority / area:** P1 · security · realtime (#38).
- **Endpoint or room:** `venue` (join), also `space` and `video_call` joins.
- **Code:** `server/realtime/rooms/venue.ts` → `static onAuth()` (lines 106 to 108; returns the options unchanged), `onJoin()` (line 151), `verifyToken()` (line 444). `verifyToken('')` returns a random `dev-…` sub (lines 449 to 454) and any other string returns `unverified-` + the first 8 chars (line 460). Profile fields are copied from join options at lines 154 to 159. `server/realtime/rooms/space.ts` `onJoin()` (line 29) and `server/realtime/rooms/video-call.ts` `onJoin()` (line 30) trust `options.userId`; `video-call.ts` `onCreate()` (lines 20 to 21) and `space.ts` line 35 trust `options.hostUserId`. The API verifier: `server/shared/auth/jwt.ts` `verifyAccess()` (line 109). `server/realtime/rooms/city.ts` does not authenticate at all (`onJoin()` line 37).
- **Now (observed):** every RS256 JWT starts with `eyJhbGci`, so all players in all venues have `userId = "unverified-eyJhbGci"`. The client cannot tell itself from others; block, report and profile cards target nobody. An empty or garbage token is accepted. `name`, `skrName`, `isSeeker`, `tribeId`, `minerTier` come from the join options, so a client can claim any name, tribe or Seeker badge. In `space`/`video_call` rooms a client can claim any `userId` and be host.
- **Expected (contract):** the room's own header comment (`venue.ts` lines 7 to 9): "the JWT is verified in onAuth against the same RS256 key the REST API uses". `contract/realtime/states.ts` `PlayerState`: `userId`, `name`, `skrName`, `tribeId`, `isSeeker`, `minerTier` are server-owned. `docs/REALTIME.md` lines 25 to 35.
- **Fix:** (1) Add an instance `onAuth(client, options)` to `VenueRoom`, `CityRoom`, `MarketRoom`, `SpaceRoom` and `VideoCallRoom`. Read `options.token` (this is what the Unity client sends today), verify it with `createJwtIssuer().verifyAccess()`, and on failure `throw new ServerError(401, 'SIGNATURE_INVALID')` (`ServerError` is exported by `colyseus` 0.18.18; Colyseus then puts the returned claims on `client.auth`). Delete `verifyToken()` and the static `onAuth()`. (2) In `onJoin`, take `userId = client.auth.sub` and load `name` (alias), `skrName`, `isSeeker`, `tribeId`, `minerTier` and `look` from the DB (`users`, `characters`). Ignore the same fields in join options. (3) Keep the empty-token dev bypass only when `config.auth.devAuthEnabled` is true, and make the bots join with a real dev-auth token. (4) For `space` and `video_call`, derive `userId` from `client.auth` and take the host from the database, not from options. (5) Keep a `userId → client` map in the city room; B16 needs it.
- **Done when:** vitest or a script with `@colyseus/sdk` 0.18.5 (already in your deps): join `venue` with `token: 'garbage'` → rejected. Join with two real dev tokens → the two `players` entries have two different `userId`s equal to each token's `sub`. A client that passes `name:'x', isSeeker:true` in options still shows its DB alias and badge. Join a `space` room claiming another user's id → rejected or ignored.
- **Client impact:** unblocks self-identification, block/report/profile on other players, and trusted badges. Removes the client workaround that identifies players by session id instead of `userId`.

### B6 SIWS never ties the signed message to the nonce, domain or time
- **Priority / area:** P1 · security · auth (#43).
- **Endpoint or room:** `GET /v1/auth/challenge`, `POST /v1/auth/verify`
- **Code:** `server/application/auth.ts` → `issueChallenge()` (line 61): `domain: cfg.jwt.issuer` (line 78) and `uri: cfg.jwt.audience` (line 80), both default `"ct-life"` (`server/shared/config/config.ts` lines 218 to 219). `verifySignedMessage()` (lines 280 to 288) accepts any non-empty message while the nonce is unexpired (the comment at lines 282 to 286 says the real check is a follow-up). The nonce store is a process-local `Map`: `server/application/context.ts` `InMemoryNonceStore` (line 103), wired at line 73.
- **Now (observed):** the challenge `domain` and `uri` are `"ct-life"`, which is not a domain and not an RFC 3986 URI. The server never compares the signed text with the challenge, so an old signed message from the same wallet verifies against a fresh nonce. The nonce is also not bound to the wallet until verify.
- **Expected (contract):** `getAuthChallenge` (`contract/openapi.yaml` line 67) and `AuthChallenge` (line 2717): `domain` string, `uri` `format: uri`. Example uses `ctlife.dev` / `https://ctlife.dev`. `docs/spec/contract.md` section 3 step 5: "The signed message matches the challenge field for field." Open question in your own spec: `docs/spec/build-spec.md` line 2539 (which domain; none bought yet).
- **Fix:** (1) Add `SIWS_DOMAIN` and `SIWS_URI` to config (`config.ts`) and use them in `issueChallenge()`. Default and value: see Decision D4. (2) In `verifyAndAuthenticate()`, decode `signedMessage` (B8), parse the SIWS text, and compare these against the stored challenge for that nonce: domain, address (must equal `input.address`), statement, URI, version, chain id, nonce, issued-at, expiration (must be in the future). Reject on any mismatch with `SIGNATURE_INVALID`. Parse by line prefixes and ignore unknown optional lines. [Inference] The standard Solana SIWS text is: `<domain> wants you to sign in with your Solana account:`, `<address>`, blank, `<statement>`, blank, then `URI: `, `Version: `, `Chain ID: `, `Nonce: `, `Issued At: `, `Expiration Time: ` lines. Seed Vault builds the text, so before you write the parser, log one real `signedMessage` from a Seeker sign-in (after B0) and write the parser against that. (3) Store `issuedAt`/`expirationTime` with the nonce so you compare to the values you issued, not to the client's text. (4) Move the nonce store to Redis with a TTL so it works with more than one API replica (`context.ts` comment already says "M3+ moves to Redis").
- **Done when:** vitest: (a) a message signed for nonce N1 posted with nonce N2 → 401. (b) The same signed message posted twice → second is 401 (`NONCE_INVALID`). (c) A message with a different domain, address or expired time → 401. (d) The smoke script in the appendix in `MODE=base64` returns 200. (e) `GET /auth/challenge` returns `domain` as a bare host and `uri` as an absolute https URI.
- **Client impact:** removes the client's reliance on the server not checking the message (item B7 workaround). **Release B6 together with B7 and B8.** Reason: today the client signs a hyphen-free nonce but posts the server's hyphenated one; a strict compare would break every sign-in until B7 is live.

### B31 (extra) An in-flight Idempotency-Key falls through to the handler: possible double debit
- **Priority / area:** P1 · money integrity (source; not reproduced; #26, #27).
- **Endpoint or room:** every route that uses `withIdempotency()`, notably `POST /v1/perps`, `POST /v1/market/trades`, `POST /v1/payments/intents`.
- **Code:** `server/shared/infra/idempotency.ts` → `reserve()` (line 116): when the lock is held it returns `{acquired:false, waitMs:200, bodyHashMismatch:false}` (line 140). `server/api/middleware/idempotency.ts` → `idempotencyPreHandler()` (line 30): it handles `acquired` (47 to 55), `bodyHashMismatch` (56 to 58) and `replay` (59 to 66), then returns with no reply and no throw for the waiting case, so the route handler runs. `idempotencyOnSend()` (line 73) returns early for non-2xx (line 82) and `abort()` (`idempotency.ts` line 168) has no caller. `complete()` (line 147) silently returns if the 30 s lock (line 38) expired. Ledger refs for money writes are random per call, for example `perp-margin:${uuidv7()}` (`perp-pit.ts` line 134) and `trade-buy:${uuidv7()}` (`terminal-cafe.ts` line 347), so the database cannot deduplicate them.
- **Now (observed):** by reading the code: if a request with key K is still running (or its lock was never released after an error) and a second request with K arrives, the second one executes the money handler too. The Unity client retries keyed requests after its 15 s timeout (`RestClient.cs` lines 89 to 100), and the lock lasts 30 s, so this window is reachable. [Inference] A slow open can run twice. Not reproduced as a double debit.
- **Expected (contract):** `docs/spec/contract.md` and the header of `idempotency.ts` (lines 1 to 27): one execution per key per user within 24 h; a different body with the same key is `VALIDATION_FAILED`.
- **Fix:** (1) In `idempotencyPreHandler`, when `reserve()` returns the waiting decision, poll `peek()` every `waitMs` for up to about 5 s; if a cached response appears, replay it; otherwise reply `409 CONFLICT {reason:'request_in_flight'}` (or `503 SERVER_BUSY` with `Retry-After`) and return. Never fall through. (2) Call `abort()` when the handler ends non-2xx, so a failed request releases its lock. (3) Make `complete()` failure loud and extend the lock (or heartbeat it) so it outlives the longest request. (4) Give each money write a deterministic ledger `idempotency_ref` derived from the request key (for example `perp-margin:${userId}:${idempotencyKey}`) so the unique index on `ledger_entries.idempotency_ref` is a second line of defense.
- **Done when:** vitest with `app.inject()`: fire two concurrent `POST /v1/perps` with the same key and body (`Promise.all`). Exactly one perp row and one `perp_margin` ledger row exist; the second response is the same body or a 409, never a second perp. A later third call replays the cached 200. A key reused with a different body returns 400. Repeat for `POST /v1/market/trades` once B20 works.
- **Client impact:** lets the client keep its retry-on-timeout. Until this is fixed the client keeps Perps order submission off by default and never auto-retries an order. Staged client mitigation (single request, no auto-retry, durable retained key) can stay as defense in depth.

### B32 (extra) Top-up credit does not check the paid mint, recipient or unit
- **Priority / area:** P1 · security · money (source; not reproduced).
- **Endpoint or room:** `POST /v1/webhooks/helius` (credits a top-up intent).
- **Code:** `server/application/helius-webhook.ts` → `creditIntentByMemo()` (line 130) and `computeReceivedCents()` (line 195). The query (lines 146 to 148) loads `cash_cents`, `bonus_bps`, `amount`, `currency` but not `mint`, `recipient` or `kind`. `computeReceivedCents()` returns the first `tokenBalanceChanges` entry it finds in any account (lines 196 to 204), without checking its `mint` or `userAccount`; for `SKR`/`ORE` it returns the raw token units as if they were cents (line 203) and for `SOL` a fixed `/ 10_000_000n` (line 207, "dev approximation"). The comparison at line 160 is `receivedCents < intent.cash_cents`, where `cash_cents` is in-game Cash (for example 50000 for the `ramen` pack) but `receivedCents` is USDC cents. Credit does not look at the intent `kind`.
- **Now (observed):** by reading the code: (a) a payment of any token to any watched account whose memo equals an intent's memo can satisfy the check; the mint is never compared with the intent's mint; (b) because the two sides of the comparison are in different units, an honest payer of the quoted amount can be marked underpaid (see B19), and an attacker paying a self-made 6-decimal mint can pass; (c) `cosmetic`, `ad` and `season_pass` intents credit Cash like a top-up. [Inference] This is a free-Cash path. Not reproduced.
- **Expected (contract):** `postPaymentsIntents` (`contract/openapi.yaml` line 2053): "the on-chain transfer is verified" before `payment_confirmed`. `docs/spec/contract.md` line 740 area: payments "go through the same intent checks".
- **Fix:** (1) Select `recipient`, `mint`, `amount`, `kind`, `currency` in the intent query. (2) Find the balance change whose `mint` equals `intent.mint` and whose owner (`userAccount`) equals `intent.recipient`; for `SOL` use the native change of the recipient account. Compare in base units against `intent.amount` (parsed with the currency decimals), not in cents. (3) Credit only `kind === 'topup'`; reject other kinds in `createTopupIntent()` until their fulfilment exists. (4) Drop the dev approximations for `SKR`/`ORE`/`SOL`, or gate them behind a price feed (`degraded: price_feed`).
- **Done when:** vitest in `helius-webhook.test.ts`: a payload with the right memo but a different mint does not credit; right mint to a different recipient does not credit; a payment smaller than `intent.amount` marks the intent `failed`; the exact quoted payment credits `cashCents + bonus` once; a `cosmetic` intent never credits Cash.
- **Client impact:** none visible. Prevents a free-Cash exploit before real money is live.

---

## P2. Phase 1 blockers (city and identity)

### B7 Seed Vault rejects the SIWS nonce
- **Priority / area:** P2 · auth · blocks real sign-in (#59). Needed together with B0.
- **Endpoint or room:** `GET /v1/auth/challenge`
- **Code:** `server/application/auth.ts` → `issueChallenge()` line 71: `const nonce = randomUUID();`.
- **Now (observed):** the nonce is a hyphenated UUID. The Seeker's Seed Vault wallet throws `IllegalArgumentException: nonce must be at least 8 alphanumeric characters` inside `authorize` (wallet log 2026-10-08 00:14) and never answers, so SIWS cannot finish.
- **Expected (contract):** `AuthChallenge.nonce` is `type: string` (`contract/openapi.yaml` line 2721); any value is allowed. The examples at lines 82 and 115 are hyphenated UUIDs and should change too.
- **Fix:** generate an alphanumeric nonce of at least 16 characters, for example `randomBytes(16).toString('hex')` or `randomUUID().replace(/-/g, '')`. Update the contract examples at `openapi.yaml` lines 82 and 115 (and `contract/openapi/generated/*` if you commit it).
- **Done when:** `curl -s $API/auth/challenge | jq -r .nonce` matches `^[A-Za-z0-9]{8,}$`. A real Seed Vault sign-in reaches the fingerprint prompt without our hyphen-strip.
- **Client impact:** removes the client workaround that strips hyphens for the wallet while sending the server's own nonce to `/auth/verify`.

### B8 `signedMessage` is read as UTF-8; the contract says base64
- **Priority / area:** P2 · auth (#46).
- **Endpoint or room:** `POST /v1/auth/verify`
- **Code:** `server/application/auth.ts` → `verifySignature()` line 293: `Buffer.from(signedMessage, 'utf8')`. Input schema `VerifyInputSchema` (line 271). Callers: lines 102 and 106.
- **Now (observed):** a base64 `signedMessage` never verifies (`SIGNATURE_INVALID`). The client retries once with the decoded UTF-8 SIWS text (same nonce; the nonce is consumed only on success, `auth.ts` line 111).
- **Expected (contract):** `docs/spec/contract.md` section 3 step 4 (line 160): "Both byte fields are base64." `AuthVerifyRequest.signature` says base64 (`contract/openapi.yaml` line 2735); `signedMessage` (line 2734) has no description, so please add "base64" there.
- **Fix:** decode `signedMessage` from base64 once, in `verifyAndAuthenticate()`, and pass the bytes to both `verifySignedMessage()` (B6) and `verifySignature()`. Reject input that is not valid base64 with `400 VALIDATION_FAILED`. Add "base64" to the `signedMessage` description in the contract.
- **Done when:** `MODE=base64 node tools/scripts/siws-smoke.mjs` (appendix) returns 200. The same request with the text form returns 401/400.
- **Client impact:** removes the client's one-time retry with the UTF-8 text.

### B9 Rooms serve `server/realtime/schemas.ts`, not `contract/realtime/states.ts`
- **Priority / area:** P2 · realtime · blocks typed clients (#47).
- **Endpoint or room:** `venue`, `city`, `market`
- **Code:** `server/realtime/schemas.ts` (the whole file, lines 13 to 63: `PlayerState`, `NpcState`, `CityState`, `VenueState`, `MarketState`). Imports: `server/realtime/rooms/venue.ts` line 44, `city.ts` line 15, `market.ts` line 9. Already correct: `space.ts` line 12 and `video-call.ts` line 10 import from `contract/realtime/states.js`.
- **Now (observed):** `PlayerState` has no `look` and a different field order; `NpcState` has `npcId` and `archetype` (contract: `archetypeId`) and no `lineParams`; numbers are `number` (contract: `float32`/`int32`/`int64`); `MarketState` is `{ts, placeholder}` with no `coins`. A generated C# client binds a type only if every name, index and type matches, so typed decoding silently fails.
- **Expected (contract):** `contract/realtime/states.ts` lines 13 to 85 (`PlayerState` with `look: string[]` of 7, `NpcState.archetypeId`/`lineParams`, `CoinState`, `MarketState.coins`, `CityState` int32). `docs/REALTIME.md` lines 20 to 55.
- **Fix:** delete `schemas.ts` and import the states from `../../../contract/realtime/states.js` in all three rooms. Adapt the rooms: drop `npcId` (the map key is the id), rename `archetype` to `archetypeId`, fill `look` from `characters.look` in this order: `[skinTone, headId, hairId, topId, bottomId, shoesId, accId]`, fill `MarketState.coins` from the `coins` table with `BigInt` values, and keep `lineParams` for NPC lines (B17). Needs B11 (tsconfig) to work.
- **Done when:** vitest: a joined `VenueRoom.state` is `instanceof` the class imported from `contract/realtime/states`; its `PlayerState` has a 7-entry `look`. The FE check: `schema-codegen contract/realtime/*.ts --csharp` output decodes the live state without our name-based fallback.
- **Client impact:** removes the client's `DynamicSchema` name-based decoding and mapping layer.

### B10 `venue` has no `filterBy(['venueId'])`; every venue joins the same room
- **Priority / area:** P2 · realtime · blocks all venues except Timeline Square (#39).
- **Endpoint or room:** `venue` (`joinOrCreate('venue', {venueId})`)
- **Code:** `server/realtime/main.ts` lines 45 to 48 (`gameServer.define('venue', VenueRoom, {maxClients: 50, patchRate: 100})`). `server/realtime/rooms/venue.ts` lines 101 to 102 (`static maxClients`, `static patchRate = PATCH_HZ * 1000`) and `onCreate()` lines 125 to 130 (`venueId` taken from options, default `'unknown'`). `server/realtime/rooms/city.ts` has the same statics pattern; `space.ts` lines 22 to 23 do it correctly.
- **Now (observed):** `joinOrCreate('venue', {venueId:'terminal_cafe'})` joins the existing `timeline_square` room (same `roomId`, `state.venueId === 'timeline_square'`). The third argument of `define()` is passed to `onCreate` as options, not applied as room settings. `maxClients` and `patchRate` are instance properties in Colyseus (installed `@colyseus/core` 0.18.18, `build/Room.d.ts` lines 175 and 187); only the static `onAuth` is read from the class (`build/Room.mjs` line 1102), so the static `maxClients`/`patchRate` are ignored. Also, `static patchRate = PATCH_HZ * 1000` is 10000 ms, not 100 ms. An unknown `venueId` creates a room whose `walkable` list is empty, so every move is `OUT_OF_BOUNDS`. All players spawn at (0, 0) (`schemas.ts` lines 24 to 25; `onJoin` sets no position).
- **Expected (contract):** `docs/REALTIME.md` line 11: "Venue instance (filterBy venueId)", 50 clients, 10 Hz; line 111: a full venue overflows into a parallel instance of the same venue.
- **Fix:** (1) `gameServer.define('venue', VenueRoom).filterBy(['venueId'])` (the call returns a `RegisteredHandler`). (2) In `onCreate`, set `this.maxClients = 50` and `this.patchRate = 100`; delete the statics. (3) In `onAuth`/`onCreate`, reject a `venueId` that is not a key of `spots.venues` or not a venue in `contract/ids/venues.json` (see B27). (4) On join, place the player at the venue's `entrance` spot (for example `terminal_cafe.entrance`, x=0 z=-8) instead of (0, 0).
- **Done when:** a script joins `venue` with `{venueId:'terminal_cafe'}` and `{venueId:'perp_pit'}` and gets two different `roomId`s whose `state.venueId` match. A 51st client joining one venue lands in a second instance. A join with `{venueId:'nope'}` is rejected. A new player's first position equals the entrance spot.
- **Client impact:** unblocks every venue other than Timeline Square. The client currently refuses the wrong room and enters offline mode. That guard can stay; the offline fallback stops firing.

### B11 Realtime cannot start, and never syncs state once it does
- **Priority / area:** P2 · realtime · tooling (#32, #33).
- **Endpoint or room:** all rooms (process start).
- **Code:** `tsconfig.json` (`include` lines 6 to 16 has no `contract/`; `exclude` line 24 has `"contract"`). `tsconfig.base.json` line 3 (`"target": "ES2022"`, which implies `useDefineForClassFields: true`), lines 13 to 14 (`experimentalDecorators`). `Dockerfile.realtime` line 26 (`CMD ["node", "--import", "tsx", "server/realtime/main.ts"]`). `server/realtime/schemas.ts` (decorated classes).
- **Now (observed):** `node --import tsx server/realtime/main.ts` throws `Cannot read properties of undefined (reading 'constructor')` at import: tsx does not apply the tsconfig to `contract/realtime/states.ts`, so its decorators compile as TC39 decorators. With that bypassed, `useDefineForClassFields` replaces the `@type` accessors, and the first patch throws `reading 'Symbol(Symbol.metadata)'` in `encodeMapEntry`; the room stops patching, so players and NPCs stay empty on the client. `venue.test.ts` never encodes a patch, so tests stay green.
- **Expected (contract):** `contract/realtime/README.md`: the state classes are the live state. `docs/REALTIME.md` line 11.
- **Fix:** (1) set `"useDefineForClassFields": false` in `tsconfig.base.json`. (2) Make `contract/realtime` part of the tsconfig that tsx uses: add `"contract/realtime/**/*.ts"` to `include` in `tsconfig.json` and remove `"contract"` from `exclude` (or narrow it to `contract/openapi`). Confirm `pnpm typecheck` still passes. (3) Add a test that creates a room, sets a state field, and encodes a full state and a patch with `@colyseus/schema` `Encoder`.
- **Done when:** with no `TSX_TSCONFIG_PATH` set, `node --import tsx server/realtime/main.ts` prints `[realtime] listening`, and a client that joins `venue` sees `room.state.players.size === 1` within one second. The new encode test passes.
- **Client impact:** none beyond B9. Today we run with our own tsconfig override (appendix).

### B12 Workers crash at startup, and five background jobs are not started at all
- **Priority / area:** P2 · workers · no events, rollovers, liquidations or rent (#34).
- **Endpoint or room:** `server/workers/main.ts` (Dockerfile.workers entrypoint).
- **Code:** `server/workers/main.ts` → `redisConnection()` (lines 43 to 53) and `newClient()` (lines 55 to 62): `new URL(redis.main.options.host ?? 'redis://localhost:6379')`. Queue names (lines 74 to 79): `events:publish`, `jobs:daily-board`, `jobs:sunday-unlock`, `jobs:weekly-meta`, `jobs:district-rollover`, `jobs:season-rollover`; the same names are repeated in the `Worker` constructors (lines 83 to 126). `Dockerfile.workers` line 26 starts only `server/workers/main.ts`. Not started by it: `server/workers/liquidation.ts` (`startLiquidationWorker`, line 24), `payment-poller.ts` (`startPaymentPoller`, line 22), `alpha.ts` (`startAlphaWorker`, line 19), `predictions.ts` (`startPredictionWorker`, line 19) and `rent.ts` (`runWeeklyRent`, line 16, called only from `homes.test.ts`). `town-crier.ts` `handleTownCrier()` (line 15) only logs.
- **Now (observed):** ioredis stores a bare host (`localhost`), so `new URL('localhost')` throws `ERR_INVALID_URL`. Even with that bypassed, BullMQ 6.3.11 rejects the queue names with `Queue name cannot contain :` (`bullmq/dist/cjs/classes/queue-base.js` line 27). No worker job runs. Separately (source): even after that is fixed, liquidations, the payment poller, alpha and prediction resolution, and weekly rent are never started by the shipped entrypoint, and nothing schedules `runWeeklyRent`.
- **Expected (contract):** `docs/REALTIME.md` lines 79 to 85 (events, `liquidated`, `payment_confirmed`), `contract/config/economy.json` (`sundayUnlockCron`, `mondayResetCron`), `homes.ts` header (rent every Monday 00:00 UTC).
- **Fix:** (1) Build the BullMQ connection from the Redis URL (`cfg.redisUrl`): pass it to `new IORedis(url, {maxRetriesPerRequest: null})`, or take host, port, password and db from `redis.main.options`. (2) Rename the six queues without `:` (for example `events-publish`, `jobs-daily-board`, ...) in both the `Queue` and `Worker` constructors. (3) Start `startLiquidationWorker()`, `startPaymentPoller()`, `startAlphaWorker()` and `startPredictionWorker()` from `buildWorkers()` and stop them in `shutdown()`. (4) Add a repeatable job for `runWeeklyRent` (Monday 00:00 UTC) and set `tz: 'UTC'` on the cron schedulers so schedules do not follow the host timezone [Inference: BullMQ scheduler `tz` option]. (5) Make `handleTownCrier` publish the event to the city room (B16).
- **Done when:** `node --import tsx server/workers/main.ts` with a normal `.env` stays up for 60 s with no error. `redis-cli keys 'bull:jobs-daily-board*'` shows keys. A vitest starts `buildWorkers()` and shuts it down cleanly. A perp whose price crosses `liq_micros` becomes `liquidated` within the poll interval.
- **Client impact:** unblocks city events (Town Crier), Sunday Unlock, rollovers, liquidations and rent. We run with workers off today.

### B13 Onboarding: a roll after the character is always 409; a second roll is a 500
- **Priority / area:** P2 · onboarding (#41, #42).
- **Endpoint or room:** `POST /v1/lottery/roll`, `POST /v1/characters`, `GET /v1/me`
- **Code:** `server/application/lottery.ts` → `roll()` (line 56): "has the user rolled" is `SELECT … FROM characters` (lines 76 to 82); balance upsert (lines 91 to 95); ledger `idempotency_ref = lottery:${userId}` (lines 97 to 102). `server/application/character.ts` → `create()` (line 34): the INSERT hardcodes `home_id = 'parents_basement'` (line 63, and line 89). `server/api/routes/core.ts` → `CharacterBody` (lines 21 to 36; `tribeId`/`dreamId`/`traitIds` and look ids are plain strings), `/characters` route (lines 85 to 96, status 201), `loadMe()` `flags: {}` (line 216).
- **Now (observed):** (a) A roll after `POST /characters` always returns `409 ALREADY_ROLLED`, so the player keeps $0. Your bots create the character first and count 409 as success, which hides this. (b) A second roll before the character returns `500 INTERNAL_ERROR`: the second ledger insert hits the unique `idempotency_ref` (`db/migrations/1700000004000_ledger_entries.sql` line 41), also seen with the same Idempotency-Key. The `ON CONFLICT DO UPDATE` on `balances` would also overwrite cash. (c) `Me.flags` is `{}`, so the client cannot tell whether the roll happened. (d) The rolled `homeId` (for example `studio`) is returned by the roll but never stored; `/me` always reports `parents_basement` (source). (e) `POST /characters` validates only shapes: `tribeId:"y"` returns 201. `items.json` has no free `head` item and no `skin` item (12 items, one `head`: `head_skull_visor`, rare, phase 2), so no contract-valid look exists for a new player. It returns 201; the contract says 200.
- **Expected (contract):** `postLotteryRoll` (`contract/openapi.yaml` line 445): once per account; `409 ALREADY_ROLLED`. `postCharacter` (line 385): "The lottery roll is forced before the character is created"; 200; `ALIAS_TAKEN`. `Me.flags` is `additionalProperties: true` (line 2765).
- **Fix:** (1) In `roll()`, decide "already rolled" by the existence of the ledger entry `lottery:${userId}` (or a `users.lottery_rolled_at` column), inside the transaction, before any write; throw `AlreadyRolledError` (409) for every second roll. Remove the characters check, so a roll is still allowed for a user who has a character but never rolled. (2) Persist the rolled `homeId` and use it when the character is created and in `/me`. (3) Add `flags.lotteryRolled: boolean` (and optionally `lotteryOutcome`) to `/me`. Document the known `flags` keys in the contract. (4) Update `tools/bots/bot.ts` to roll first. (5) Validate `POST /characters`: `tribeId` in `tribes.json`, `dreamId` in `dreams.json`, `traitIds` two distinct ids in `traits.json`, every look id in `items.json` for its slot, plus the `skinTone` set. (6) Add starter items for every slot (see the starter-look proposals `snow-starter-look.md`, `rain-starter-look.md`, `vincent-starter-look.md` in companions/: `skin_tone1..6`, `head_male`/`head_female`, `acc_none`; [Unverified] that your server will accept these ids until you add them). (7) Pick 200 or 201 for creates (Decision D9). Optional later: reject `POST /characters` until the roll exists.
- **Done when:** curl: new user `T`: `post /lottery/roll $T` → 200 with cash; again → 409 (not 500); `get /me $T | j .flags.lotteryRolled` → `true`; `post /characters $T` with `tribeId:"y"` → 400; with a valid body → success; `get /me $T | j .homeId` equals the rolled `homeId`. Vitest covers the same.
- **Client impact:** the client rolls before the creator and treats 409 as done; it infers "rolled" from `/me` cash and debt. After this it reads `flags.lotteryRolled` and the inference can go.

### B14 Auth and `/me` response shapes differ from the contract
- **Priority / area:** P2 · contract shape (#45, #48, #49).
- **Endpoint or room:** `POST /v1/auth/verify`, `POST /v1/auth/dev`, `POST /v1/auth/refresh`, `GET /v1/me`, `POST /v1/careers/{careerId}/apply`
- **Code:** `server/api/routes/auth.ts` verify reply (line 110: `{...user, hasCharacter}`), dev reply (line 170), refresh reply (lines 128 to 129: tokens only). `server/application/auth.ts` `AuthenticatedUser` (line 39), `refresh()` (line 140). `server/api/routes/core.ts` `loadMe()` user object (lines 192 to 199). `server/application/careers.ts` `apply()` returns `{id, level}` (lines 83 and 100).
- **Now (observed):** auth responses are flat (`id`, `wallet`, `isSeeker`, `hasCharacter` at the top level). Refresh returns only the two tokens. `GET /me` `user` has `id, wallet, isSeeker, skrName, isSybilJailed, sybilJailedAt` and no `hasCharacter`. `/careers/{id}/apply` returns `{id, level}`. A contract-generated client gets `user = null` or throws on decode.
- **Expected (contract):** `AuthVerifyResponse` `{accessToken, refreshToken, user}` (`contract/openapi.yaml` line 2737), used by verify, refresh and dev. `User` requires `id, wallet, isSeeker, hasCharacter` (line 2744). `Job` `{careerId, level, xp}` (line 2822).
- **Fix:** return `{accessToken, refreshToken, user:{id, wallet, isSeeker, hasCharacter, skrName}}` from verify, dev and refresh (refresh already loads the user in `refresh()`, line 150). Add `hasCharacter` to the `/me` `user` object. Return `{careerId, level, xp}` from apply. Keep the extra `isSybilJailed` fields only if you add them to the contract (the Phase 4-6 proposal does). Also `verifyAndAuthenticate()` returns `hasCharacter:false` at line 118; the route overwrites it, so remove the dead value.
- **Done when:** `post /auth/dev …` and a verify and a refresh all return `.user.hasCharacter` as a boolean; `get /me` returns `.user.hasCharacter`; apply returns `.careerId`. The generated C# models decode them with no custom code.
- **Client impact:** removes the client code that reads both auth shapes, falls back to JWT claims, derives `hasCharacter` from `character`, and tolerates the apply shape.

### B15 A POST without a JSON body returns 500
- **Priority / area:** P2 · API robustness (#50).
- **Endpoint or room:** every POST (for example `POST /v1/lottery/roll`).
- **Code:** `server/api/main.ts` → content-type parser for `application/json` only (lines 88 to 96) and `setErrorHandler` (lines 102 to 118), which sends everything that is not a `DomainError` through `toErrorEnvelope()` (`server/shared/infra/error-envelope.ts` lines 74 to 83, `INTERNAL_ERROR` 500).
- **Now (observed):** `curl -X POST $API/lottery/roll -H 'authorization: …' -H 'content-type: application/x-www-form-urlencoded'` returns `500 INTERNAL_ERROR`. Fastify raises 415 "Unsupported Media Type"; the handler maps it to 500. Unity's bodiless POST carries a form content type.
- **Expected (contract):** `docs/spec/contract.md` error rules: 4xx for client faults. No operation documents a 500 for a bodiless POST.
- **Fix:** (1) In the error handler, if `err.statusCode` is a 4xx, answer with that status and a contract code (`415`/`400` → `VALIDATION_FAILED` with `details.reason`). Only unknown 5xx errors become `INTERNAL_ERROR`. (2) Register a catch-all parser (`addContentTypeParser('*', …)`) that treats an empty body as `{}` for any content type, so bodiless POSTs just work.
- **Done when:** the curl above returns `200` (or the route's real status), not 500. A POST with `content-type: text/plain` and a non-empty body returns `400/415` with the error envelope.
- **Client impact:** removes the client rule "always send `{}`".

### B16 City room is a stub: no events, toasts, DMs, call invites, payment or liquidation messages
- **Priority / area:** P2 · realtime · blocks Phase 1 and 3 push (#54, #64, #17).
- **Endpoint or room:** `city` (server to client messages `event`, `toast`, `dm`, `call_invite`, `space_update`, `payment_confirmed`, `liquidated`, `kicked`); `market` (`tape`).
- **Code:** `server/realtime/rooms/city.ts` (51 lines): `tick()` sets `mood = floor(sin(Date.now()/60000) * 200)` (line 49); there are no sends. `server/realtime/rooms/market.ts` (29 lines): placeholder state only. `server/workers/town-crier.ts` `handleTownCrier()` (line 15) only logs. The `liquidated` event is published to Redis channel `city:events` at `server/application/perp-pit.ts` lines 304 to 313; nothing subscribes to it. `venue.ts` line 359 sends `toast` with a `to` field to the whole room (see B17).
- **Now (observed):** the city room never broadcasts `event`. `mood` is a synthetic sine (sampled −171, −169, −167 bps). No `toast`, `dm`, `call_invite`, `space_update`, `payment_confirmed` or `liquidated` is ever sent, so calls never ring and DMs and Spaces only poll. The market room has no `coins` and never sends `tape`.
- **Expected (contract):** `contract/realtime/messages.ts`: `EventMessage` (line 104), `LiquidatedMessage` (118), `PaymentConfirmedMessage` (126), `SpaceUpdateMessage` (132), `DmMessage` (135), `CallInviteMessage` (143), `KickedMessage` (150), `TapeMessage` (157). Recipients per `docs/REALTIME.md` lines 77 to 85 (`toast` in the venue room goes to one player). Client expectation: `toast` also on `city` for players not in a venue (#17).
- **Fix:** (1) Authenticate the city room (B5) and keep `userId → client`. (2) Subscribe the city room (and the market room) to a Redis pub/sub channel. Have the workers, the REST services and the liquidation worker publish to it. Targeted messages carry a `userId`; the room sends only to that user's client. (3) Publish: `event` from the Town Crier worker and the market engine; `mood` from the real SOL 24h change in bps (`contract` says -10000..10000); `payment_confirmed` from `creditIntentByMemo()`; `liquidated` from `perp-pit.ts` (add `lossCents`, see B38); `dm` from `sendDm()`; `call_invite` from `startVideoCall()` and `startPaidCall()`; `space_update` from `spaces.ts`; `tape` from `executeTrade()`. (4) Fix the `toast` shape to `{textId, params?}` and stop putting `to` in a broadcast. (5) Add the `toast` message to `city`. (6) Grow `EventMessage.eventId` additively when new events ship (Decision D12).
- **Done when:** a script joins `city` as user A. Then: B sends A a DM → A receives `dm`; A tops up (B19/B32) → A receives `payment_confirmed {intentId, cashCents}`; a liquidation fires → A receives `liquidated`; `mood` over three samples is not a sine; a Town Crier event arrives as `event`.
- **Client impact:** unblocks ringing calls, live DMs, Spaces updates, instant payment confirmation, REKT cards and the event ticker. The client already listens on `city`; the polling fallbacks can go.

### B17 NPC state: wrong semantics, ids that do not resolve, brains see no world
- **Priority / area:** P2 · world life (#61 to #63, #65, #67).
- **Endpoint or room:** `venue` NPC state.
- **Code:** `server/realtime/rooms/venue.ts` → `tickNpcs()` (lines 400 to 433): `startedAt = ctx.nowMs` every tick (line 431), `lineId = out.lineId ?? ''` (line 427), `animId = out.animId ?? 'loco_idle'` (line 428), `moodBps: 0` (line 403), `recentEvents: []` (line 404), `richestPlayers()` with `netWorthCents: 0` (lines 435 to 440), `walkableSpots` built as `"x0,z0"` strings (lines 408 to 410). `handleNpcTap()` (lines 343 to 364). `npcArchetypesFor()` (lines 383 to 398: only 5 venues). Brain: `packages/npc-brain/src/index.ts` (spot ids `square_center` lines 300 and 313, `venue_exit` line 735, `spaces_studio` line 808, `perp_terminal` line 446, `rekt_clinic` line 492, `cafe_terminal` line 675, `builder_hq_1/2` line 1024; `emote_moon` line 478). Registries: `contract/ids/archetypes.json`, `contract/ids/spots.json`, `contract/ids/anims.json`, `contract/config/npc_lines.json`.
- **Now (observed):** `startedAt` is rewritten every second (sampled 75124 → 76121 → 77122 ms), and later ticks of a state send `animId: loco_idle` and `lineId: ''` (Giveaway Guy in `goto`; Town Crier and Spaces Host one tick after a line), so clients restart walks and one-shots each second and lose the line. Spot ids sent that are not spots: `square_center`, `venue_exit`, `spaces_studio` (a venue), `perp_terminal`, `cafe_terminal`, `builder_hq_1/2`, and `"x0,z0"` rect strings. Line ids (`crier_air_thin`, `spaces_gm`, `giveaway_pitch`, `reply_gm`, `perp_max_long`, …) are not ids in `npc_lines.json`, whose lines are unnamed arrays; `lineParams` is never set; `emote_moon` is not in `anims.json`. The brains never see the world (mood 0, no events, no real net worth), so the Town Crier never reacts, Doomposter is always `leave`, Reply Guy follows the first joiner. Giveaway Guy's `npc_tap` broadcasts `toast {to, textId:"toast_drained"}` to the whole room and debits nothing. Registry gaps: `archetypes.json` lists `spaces_host` twice, `normie.venueId` is `market_room` (not a venue), `vc_npc`/`builder_npc` brains are not archetype ids, NPCs spawn in only 5 venues.
- **Expected (contract):** `docs/REALTIME.md` lines 37 to 46 (`startedAt` = epoch ms when the state began; `lineId` + `lineParams`; `spotId` is a spot id). `contract/realtime/states.ts` `NpcState` (lines 34 to 45).
- **Fix:** (1) Set `startedAt` only when `state`, `spotId`, `animId` or `lineId` actually changes; keep the line fields for `dwellMs` instead of clearing them next tick. (2) Make the brain output only ids that exist: spot ids from `spots.json` (global form `venue.spot`), anim and emote ids from `anims.json`, line ids from `npc_lines.json`. We proposed `{id, text}` line entries in `npc_lines.json` and the missing ids in `npc-world-life-20261008.md`; adopt or replace them, but ids must resolve. (3) Feed the brain real data: SOL-based mood, the recent city events (B16), real net worth for `richest`. (4) Make `npc_tap` on Giveaway Guy debit the $50 in the ledger and send the toast to the tapper only, with `textId` from `toasts.json`. (5) Fix the registry gaps listed above; spawn NPCs in the venues of `archetypes.json`.
- **Done when:** a script samples a venue's NPC state for 5 s: `startedAt` is constant while `state` is unchanged; every `spotId`, `animId`, `emoteId`, `lineId` exists in its registry; after a Town Crier event, the crier's `lineId` and `lineParams` show it. `npc_tap` on Giveaway Guy reduces the tapper's cash by $50 and no other client receives the toast.
- **Client impact:** removes the client's workaround that picks a stable line from the archetype's list by hashing the id, and its spot-id fallbacks.

### B18 Careers: skill gates never block, level and XP are fixed, shifts need no job
- **Priority / area:** P2 · careers (careers proposal section 6; #49 for the apply shape, see B14).
- **Endpoint or room:** `GET /v1/careers`, `POST /v1/careers/{careerId}/apply`, `POST /v1/shifts`, `POST /v1/shifts/{shiftId}/complete`
- **Code:** `server/application/careers.ts` → `list()` (line 41; `level = 1`, `xp: 0`, lines 62 and 69; filters `active` at line 57), `apply()` (line 83; gate loop lines 89 to 99; persists nothing), `getUserSkill()` returns `10` (lines 107 to 109), `getUserSkills()` returns constants (103 to 105). `server/application/shifts.ts` → `start()` (line 62; always `levels[0]`, no job or `active` check), `complete()` returns `xp` and `promoted: false` without storing (line 137). Config: `contract/config/careers.json` (gates are `{ "skill": "coding", "level": 1 }`; `discord_mod` has `{}`). The `skills` table exists (`db/migrations/1700000006000_skills.sql`); there is no jobs table.
- **Now (observed):** `GET /careers` returns only the 3 active careers, each with `level: 1, xp: 0, active: true` after any number of shifts. The gate loop treats `{skill:'coding', level:1}` as a `{skill: level}` map, so it compares 10 with `'coding'` and with `1`, and never blocks. `POST /shifts {careerId:"copywriter"}` (an inactive career) still returns a shift. `POST /shifts` does not check that the player applied. Every shift uses level 1 pay and the single `miniGameId` of level 1.
- **Expected (contract):** `getCareers` (`contract/openapi.yaml` line 689: id, name, level 0 to 5, xp, active), `postCareersCareerIdApply` (line 712: `Job`, 403 on gate), `postShifts` (line 733), `Job` (line 2822). `contract/config/skills.json` (`xpPerShiftLevel`), `contract/config/careers.json` (`levels[].xp`).
- **Fix:** (1) Add a table for the player's job (`user_id`, `career_id`, `level`, `xp`, `active`) and write it in `apply()`; one active career at a time. (2) Read real skills from the `skills` table in `getUserSkill()`; read gates as `{skill, level}` and return `403 FORBIDDEN {reason:'skill_gate', skill, required, actual}` when short. (3) `start()` requires an active job for that career and uses the player's current level for pay, `shiftSec` and `miniGameIds` (we also proposed returning one or two games per level, see `careers-minigames-20261008.md` sections 2 and 4). (4) `complete()` writes XP, raises the level by your XP model (Decision D3), sets `promoted`, and raises the matching skill. (5) `GET /careers` returns the player's real `level` and `xp`; `active` = "this is my current job".
- **Done when:** curl with a new user: `apply junior_analyst` with coding 1 → 200; `apply smart_contract_auditor` (security gate 3) → 403; `POST /shifts` for a career not applied to → 403; after N completed shifts `GET /careers` shows `xp` > 0 and eventually a higher `level`, and `complete` returns `promoted:true` once.
- **Client impact:** the client reads gates from config and treats a server `VALIDATION_FAILED reason: skill_gate` as the authority; it remembers the last confirmed apply because `active` is ambiguous. After the fix those compensations can be removed.

### B33 (extra) `sit` ignores the spot's own `anim`
- **Priority / area:** P2 · realtime · avatar pose (#13).
- **Endpoint or room:** `venue` message `sit {spotId}`
- **Code:** `server/realtime/rooms/venue.ts` → `handleSit()` line 260: `player.anim = spot.kind === 'stage' ? 'act_type' : 'act_sit'`. The spot type `VenueSpots` (lines 85 to 93) has no `anim` field.
- **Now (observed):** `contract/ids/spots.json` (version 1.1.0 at `9f3e5ef`) already carries positions and an `anim` per spot (for example `terminal_cafe.terminal_1` has `anim: act_type`; `terminal_cafe.table_1` has `act_sit`; `spaces_studio.stage_host` has `loco_idle`, `stage_1..10` have `act_sit`). The handler ignores it. Every `kind: terminal` gets `act_sit`, and all eleven `kind: stage` spots get `act_type`, so café terminals and Spaces stage seats show the wrong pose.
- **Expected (contract):** `contract/ids/spots.json` per-spot `anim` field.
- **Fix:** add `anim?: string` to the spot type; in `handleSit`, use `spot.anim` when it is present and listed in `anims.json`; keep the kind-based fallback for spots without a valid `anim`.
- **Done when:** a room test: sit at `terminal_cafe.terminal_1` → `player.anim === 'act_type'`; sit at `terminal_cafe.table_1` → `act_sit`; sit at `spaces_studio.stage_host` → `loco_idle`; sit at a spot with no `anim` keeps the old fallback.
- **Client impact:** the client requires a confirmed `act_type` at an authored terminal and does not reinterpret the server's action, so this unblocks correct terminal and stage poses.

### B34 (extra) `GET /config` lacks `degraded`, ETag/304 and the version gate
- **Priority / area:** P2 · config (source; #51, #9).
- **Endpoint or room:** `GET /v1/config`
- **Code:** `server/api/routes/core.ts` → `/v1/config` handler (lines 47 to 75): hardcodes `version: '1.0.0-rc1'` and `minClientVersion: '1.0.0'` (lines 52 to 53), returns no `degraded`, sets no ETag or Cache-Control, does not read `X-Client-Version`. `CLIENT_OUTDATED` exists as an error class (`server/shared/domain/errors.ts` line 230) but nothing throws it.
- **Now (observed):** `minClientVersion` is `1.0.0` while no client is released; the client moved to 1.0.0 to pass its own gate. By reading the code, the response never contains `degraded`, never returns 304, and never answers 426 to an old client.
- **Expected (contract):** `getConfig` (`contract/openapi.yaml` line 293) and `ConfigResponse` (line 2845: `degraded` is required): strong `ETag`, `Cache-Control`, `304` on `If-None-Match`, `426 CLIENT_OUTDATED` when `X-Client-Version` is below `minClientVersion`, `degraded` list re-read on every response.
- **Fix:** add `degraded` (from your kill-switch flags; an empty array is fine to start), compute an ETag over the payload and honor `If-None-Match`, enforce `X-Client-Version` with `ClientOutdatedError`, and read `version`/`minClientVersion` from `contract/config` or env, not literals. Confirm the versioning you intend (Decision D10).
- **Done when:** `curl -i $API/config` returns `ETag`, `Cache-Control` and `"degraded":[]`; repeating with `If-None-Match` returns 304; `X-Client-Version: 0.0.1` returns 426 `CLIENT_OUTDATED`.
- **Client impact:** the client polls `/config` every 2 minutes with `If-None-Match` and treats `degraded` as kill switches. Today it always gets a full 200 and no kill switches.

### B35 (extra) Move speed check trips on normal network jitter
- **Priority / area:** P2 · realtime (#60).
- **Endpoint or room:** `venue` message `move`
- **Code:** `server/realtime/rooms/venue.ts` → `handleMove()` (line 186): `lastMoveAt` is set at line 195 before the speed check; `dt = Math.max(1, now - last)` (line 204); `lastX`/`lastZ` are updated only on accepted moves (lines 232 to 233).
- **Now (observed):** two moves that arrive close together after normal running (about 4 m/s, client sends at most 10 per second) trip `SPEED_EXCEEDED` (seen on the Seeker at 00:50:29). The check divides distance by the gap between arrival times, and a rejected move still resets the time base while the position base stays old, so the next move is measured over a shorter gap from an older position.
- **Expected (contract):** `docs/REALTIME.md` line 63: "server rejects speeds > 6 m/s". `contract/realtime/messages.ts` `RATE_LIMITS.move` 10 per second.
- **Fix:** measure speed against the time of the last accepted position (store `lastAcceptedAt`), and allow a short burst budget (for example accumulate allowed distance = 6 m/s × elapsed + a small constant, capped). Do not update `lastMoveAt` for a rejected move.
- **Done when:** a test sends moves at 4 m/s with 20 to 180 ms random inter-arrival jitter for 30 s: zero rejections. A move that teleports 20 m in 100 ms is still rejected.
- **Client impact:** stops rubber-banding on a real phone.

### B36 (extra) Seat rejections cannot be matched to a request
- **Priority / area:** P2 · realtime protocol (source; #31).
- **Endpoint or room:** `venue` messages `sit`, `stand`, `rejected`
- **Code:** `server/realtime/rooms/venue.ts` → `handleSit()` (lines 236 to 262) sends `rejected {type:'sit', code}` (lines 239, 244, 249, 253). Contract `RejectedMessage` (`contract/realtime/messages.ts` lines 70 to 97) has `{type, code}` only.
- **Now (observed):** by reading both sides: the sequence request A, cancel A, request B, then a delayed rejection of A cannot be told apart from a rejection of B once B has been sent. The client may clear the newer intent. Not reproduced against a deployed server.
- **Expected (contract):** none defined. `docs/REALTIME.md` line 64: `sit` fails with `SPOT_TAKEN`.
- **Fix:** add an optional `spotId` (the spot that was refused) and an optional client `requestId` echoed back to `rejected`, additively in `messages.ts`. Define ordering on reconnect (a rejoin starts unseated) and what `stand` does to an unanswered `sit`.
- **Done when:** a room test: `sit(taken)` returns `rejected {type:'sit', code:'SPOT_TAKEN', spotId}` and, if sent, the same `requestId`.
- **Client impact:** lets the client keep only the right seat intent. Until then it keeps a defensive rule for dispatched requests.

---

## P3. Money

### B19 Payment intents: no `tx`, wrong amount units, no status endpoint
- **Priority / area:** P3 · money · blocks top-up (#52, #53, #20, #24, #25).
- **Endpoint or room:** `POST /v1/payments/intents`, `GET /v1/payments/intents/{id}` (missing)
- **Code:** `server/api/routes/payments.ts` → body schema (lines 23 to 28; `sku` enum includes `custom`, `amountCents`) and create route (lines 39 to 54). `server/application/topup.ts` → `createTopupIntent()` (line 103): `cashCents` from the pack (line 112); `usdcAmount = cashCents / 100` (line 144) and `formatBaseUnits(BigInt(usdcAmount), decimals)` (line 145); returns only `{intentId, recipient, mint, amount, reference, memo, solanaPayUrl, expiresAt}` (`IntentResult`, lines 83 to 92, return at 181 to 190). `markSubmitted()` (line 198). Packs: `contract/config/economy.json` (`priceUsdc`, `cashCents`).
- **Now (observed):** `POST /payments/intents {"kind":"topup","sku":"ramen","currency":"USDC"}` returns `{intentId, recipient, mint, amount:"0.000500", reference, memo, solanaPayUrl, expiresAt}`: no `tx` (required), no `currency`, no `cashCents`, no `bonusBps`. The `amount` is derived from the pack's in-game Cash, not from `priceUsdc`: the ramen pack costs 1 USDC but the quote asks 0.0005 USDC, and it is formatted as a decimal string, not base units. `GET /payments/intents/{id}` is `404 No route`, so the client cannot poll. `ORE` and `SKR` quotes are not converted from any price. The response does not say which Solana cluster the transaction is for (the client signs on the environment cluster; the contract config requires ORE on mainnet even in staging).
- **Expected (contract):** `postPaymentsIntents` (`contract/openapi.yaml` line 2053) and `PaymentIntent` (line 3077: `tx` required; `currency`, `cashCents`, `bonusBps` present; `amount` is base units, example `'10000000'` for 10 USDC). `getPaymentsIntentsId` (line 2129): `{status: pending|confirmed|expired|failed, signature}`, `410 PAYMENT_EXPIRED`.
- **Fix:** (1) Compute `amount` from `pack.priceUsdc × 10^decimals` in base units, as an integer string. For `SOL`, `SKR`, `ORE` convert through a price source, and answer `503 SERVER_BUSY` (degraded `price_feed`) when there is none; do not quote from Cash cents. (2) Return the full `PaymentIntent`: add `currency`, `cashCents`, `bonusBps`, and `tx`: an unsigned base64 v0 transaction (SPL `TransferChecked` or SOL transfer from the user's wallet to the treasury, with a memo instruction carrying `memo` and `reference` as a read-only key, a fresh blockhash and the user as fee payer) for the client's MWA `sign_and_send`. (3) Add a `cluster` field (`devnet | mainnet`) to the response, additively (Decision D8). (4) Implement `GET /payments/intents/{id}` for the owner only. (5) Reject `custom` until a price rule exists. (6) Credit correctness is B32. (7) The `bestValue` label on `whale` (economy.json) is questioned in Decision D7.
- **Done when:** `post /payments/intents $T '{"kind":"topup","sku":"ramen","currency":"USDC"}'` returns `amount:"1000000"`, `cashCents:50000`, `bonusBps:0`, `currency:"USDC"` and a `tx` that decodes to a v0 message with one transfer of 1,000,000 base units to the treasury plus the memo. `get /payments/intents/<id> $T` returns `{"status":"pending"}`; another user gets 404. After expiry it returns 410 `PAYMENT_EXPIRED`.
- **Client impact:** unblocks real top-ups with MWA. The client then uses your quote and does not compute any amount itself.

### B20 Every spot buy fails with `SLIPPAGE_EXCEEDED`
- **Priority / area:** P3 · money · blocks all spot trading (#76).
- **Endpoint or room:** `POST /v1/market/trades`
- **Code:** `server/application/terminal-cafe.ts` → `executeTrade()` (line 262): fixed `reserves = { x: 1_000_000n, y: 30_000_000n }` (line 290, comment "production reads them from the coin row"); buy converts cents to base units `× 10_000` (line 298); the price after the trade is `newY × 1_000_000 / newX` (line 314); the slippage test compares that post-trade marginal price with the coin's stored price in both directions (lines 316 to 328); the fee is never applied. `server/application/amm.ts` → `ammQuote()` (line 25; the doc comment says `y` is cents, the caller passes base units). Route: `server/api/routes/markets.ts` (lines 72 to 88; `maxSlippageBps` required, line 36).
- **Now (observed):** fresh dev user, coin `TRUST…` listed at `priceMicros 1000000` (mcap $1M): `POST /v1/market/trades {coinId, side:"buy", cashCents:500, maxSlippageBps:10000}` returns `SLIPPAGE_EXCEEDED {expected:"1000000", actual:"40833374"}` (also at 500 and 2000 bps). The execution price for a $5 buy is 40.8 times the quoted price, because the fixed reserves imply a price of 30,000,000 micros regardless of the coin. No spot trade can execute.
- **Expected (contract):** `postMarketTrades` (`contract/openapi.yaml` line 989): constant-product curve plus the buy/sell fee; `SLIPPAGE_EXCEEDED` only if the executed price is worse than `maxSlippageBps` from the quote price; `Trade` `{tradeId, units, priceMicros, feeCents, cashCents}` (line 2926); `maxSlippageBps` optional; `402 INSUFFICIENT_CASH` (line 1045).
- **Fix:** (1) Store virtual reserves per coin (or derive them from the coin's price and liquidity) so the curve's spot price equals `coins.price_micros` before the trade. (2) Compute slippage as `(executionPrice − quotePrice) / quotePrice` where `executionPrice = cashIn / unitsOut` for a buy (and the mirror for a sell), one-sided (only worse prices fail), not the post-trade marginal price. (3) Apply the buy/sell fee from `contract/config/market.json` `feesBps` (100 bps each side) and return `feeCents`. (4) Make `maxSlippageBps` optional (default from config). (5) Return `priceMicros` as the execution price and `cashCents` as in the contract (not `cashDeltaCents`/`tradeId = positionId`). (6) Use `InsufficientCashError` (402) which it already does at line 337. Do this together with the amount-unit comment in `amm.ts`.
- **Done when:** with the coin above: a $5 buy with `maxSlippageBps:200` returns 200 with `units` > 0 and an execution price within 2% of 1,000,000 micros; a sell of those units returns cash; a buy with `maxSlippageBps:0` on a thin curve fails with `SLIPPAGE_EXCEEDED`; ledger totals match `feeCents`.
- **Client impact:** unblocks the whole Terminal Café trading screen. The client already sends contract bodies.

### B21 ORE staking: the stake endpoint returns 500 and the data are fixtures
- **Priority / area:** P3 · money · ORE (#55, #20, #21, #23).
- **Endpoint or room:** `POST /v1/ore/stake/tx`, `GET /v1/ore/board`, `GET /v1/ore/me`, `POST /v1/ore/stake/submitted`
- **Code:** `server/api/routes/ore.ts` → stake route (lines 55 to 90; reply `{txBase64, action, stakeProgram, oreMint, stOreMint, stakePda}` at lines 81 to 88). `server/shared/solana/ore-stake.ts` → `buildOreStakeTx()` (line 119: `new Transaction().add(ix)` with no fee payer or blockhash) and `encodeTxBase64()` (line 212: `tx.serializeMessage()`). `server/application/refinery.ts` → `fixtureBoard()` (line 74, `roundId:'dev-fixture'`, `priceUsd: 0` at 82), `readBoard()` (line 94), `readOreMe()` (line 162, balance/staked `'0'`), `markStakeSubmitted()` (line 242). Tier config: `contract/config/ore.json`.
- **Now (observed):** `POST /ore/stake/tx {"action":"deposit","amount":"1000000000"}` returns `500 INTERNAL_ERROR` on the local stack. [Inference] The cause is `serializeMessage()` on a transaction with no `recentBlockhash` and no fee payer, which throws in `@solana/web3.js`; we did not read the server log. Per source the shape is `{txBase64}` (contract `{tx}`), a legacy message (contract: v0), and the bytes are the message, not a transaction the wallet can sign. `GET /ore/board` returns a fixture (`roundId:"dev-fixture"`, 5 numeric squares, `priceUsd:0`); `GET /ore/me` is all zeros. There is no confirmation or expiry contract: no last-valid block height, no status endpoint, no stORE decimals, no claimable rewards, and withdraw amount units are not stated.
- **Expected (contract):** `postOreStakeTx` (`contract/openapi.yaml` line 2367): `{tx}` = "base64 v0 transaction", `amount` base units for deposit and withdraw. `getOreBoard` (line 2328) and `getOreMe` (line 2349). Spec: `docs/spec/contract.md` lines 738 to 740 (stake PDA seeds, `TransferChecked` with 11 decimals).
- **Fix:** (1) Build a `VersionedTransaction` (v0) with the user's wallet as fee payer and a recent blockhash from the RPC, and return it unsigned as `{ tx }` (additive extras are fine: `lastValidBlockHeight`, `cluster`, `expiresAt`). (2) Return the cluster (Decision D8) and document amount units for deposit and withdraw (base units of ORE, 11 decimals) and the stORE decimals. (3) Replace the fixtures: read the real board and the user's ORE balance, staked amount, stORE and claimable amount; keep a fixture only behind a dev flag and mark it `degraded: ore_reader`. (4) Add a status read (or let `/ore/me` reflect a confirmed submission) and say when `/ore/me` reflects a confirmed action. (5) The tier thresholds and board example need your answer (Decision D6).
- **Done when:** `post /ore/stake/tx $T '{"action":"deposit","amount":"1000000000"}'` returns 200 with `tx` that parses as a v0 message with a fee payer and blockhash; `GET /ore/me` shows non-fixture numbers for a funded devnet/mainnet test wallet; the board has 25 squares.
- **Client impact:** unblocks staking. The client never declares staking complete from a signature alone; it shows "pending" until your status says confirmed.

### B22 Predictions and alpha calls differ from the contract; top-up cap unit is off by 100x
- **Priority / area:** P3 · money · needs Decisions D2 and D5 (#56, #57, #58, #22).
- **Endpoint or room:** `GET /v1/predictions`, `POST /v1/predictions` (contract: `POST /predictions/{id}/bets`), `POST /v1/alpha-calls`, `POST /v1/payments/intents` (cap)
- **Code:** `server/api/routes/predictions.ts` (body `{outcomeId, stakeCents, horizon}` lines 19 to 23; `GET` returns `{predictions}` line 58). `server/application/predictions.ts` → `placePrediction()` (line 61; free-text `outcomeId`, no market lookup; the header says markets are seeded from `contract/config/predictions.json`, which does not exist). `server/api/routes/alpha.ts` (strings for `entryMicros`, `targetMicros`, `stopMicros`, lines 21 to 26). `server/application/topup.ts` line 138 (cap check). `contract/config/economy.json` (`topUpCapCentsPerDay: 1000000`, `topUpCapCurrency: "USDC"`).
- **Now (observed):** `GET /predictions` returns `{"predictions":[]}` (the player's own bets), not open markets, so the Pit is empty. Bets are `POST /predictions {outcomeId, stakeCents, horizon}`, not `POST /predictions/{id}/bets` (404). `POST /alpha-calls` with integer micros (the contract form) returns `VALIDATION_FAILED expected string`. The cap value is compared with credited Cash cents (`topup.ts` line 138), that is $10,000 of Cash per day, so the Cabal pack (1,600,000 Cash cents) can never be bought; the spec says "100 USDC per wallet per day" (a paid-value cap).
- **Expected (contract):** `getPredictions` (`contract/openapi.yaml` line 1167: `PredictionMarket[]`, open markets, line 2958), `postPredictionsIdBets` (line 1187: `Bet`, `402`), `postAlphaCalls` (line 1244: integers), `TOPUP_CAP_REACHED` example "100 USDC of top-ups per wallet per day" (line 2106).
- **Fix:** after Decisions D2, D5: (1) add a market source (a table or Redis set with `id`, `question`, `outcomes`, `closesAt`, `status`), return it from `GET /predictions` as an array, and add `POST /predictions/{id}/bets` that validates the market and outcome and debits cash with `402 INSUFFICIENT_CASH`. Keep the old route as an alias until the client ships if you want. (2) Accept integer micros (and numeric strings) in `POST /alpha-calls`; return the contract `AlphaCall` (`callId`, `at`). (3) Fix the cap: compare the paid value (USDC cents of the intent price, not Cash cents) with the cap, and set the cap value, unit and error copy together after D5.
- **Done when:** `get /predictions $T` returns an array of markets with `id`; `post /predictions/<id>/bets` with a valid outcome returns a `Bet`; `post /alpha-calls` with integer micros returns 200; with the cap set to the decided value, buying the `cabal` pack succeeds once and a second purchase over the cap returns 429 `TOPUP_CAP_REACHED`.
- **Client impact:** unblocks the Prediction Pit and alpha calls; the client reads wrappers and strings today and keeps doing so until the shapes are final.

### B38 (extra) Perps: payload shapes, settlement semantics and dead-coin check
- **Priority / area:** P3 · money · perps (source for code, #28, #29, #30, #27).
- **Endpoint or room:** `POST /v1/perps`, `GET /v1/perps`, `POST /v1/perps/{perpId}/close`, realtime `liquidated`
- **Code:** `server/api/routes/perps.ts` (leverage `max(25)` line 24; open returns 201 line 47; list returns `{perps}` line 68). `server/application/perp-pit.ts` → `MAX_LEVERAGE = 25` (line 68), `LeverageNotAllowedError` with `allowed` (lines 100 to 107), coin select without stage or price check (lines 109 to 115), `ForbiddenError('insufficient_margin')` (line 125), `closePerp` settlement (lines 205 to 241: payout floored at zero, `realized` stored as the unfloored value), `liquidatePerp` (lines 284 to 315: sets `status` and `closed_at` but not `realized_cents`; the Redis event omits `lossCents`). `server/application/terminal-cafe.ts` → `getCoin` candles `{at, priceMicros}` and `riskHint` object (`CoinDetail`, lines 56 to 61, built around lines 186 to 194); spot trade rejects `dead` coins at line 284.
- **Now (observed):** `GET /perps` returns `{perps}`; money fields are decimal integer strings; `POST /perps` returns 201; leverage up to 25 is accepted; `LEVERAGE_NOT_ALLOWED` details use `allowed`; insufficient margin is `FORBIDDEN {reason:'insufficient_margin'}`; coin history is sampled `{at, priceMicros}`, not OHLC candles; `riskHint` is an object. Open does not reject a dead or zero-price coin. Close returns the raw `realizedCents` while the credited amount is floored at zero. Liquidation stores no realized loss and its event has no `lossCents`.
- **Expected (contract):** `getPerps` (`contract/openapi.yaml` line 1074: array), `postPerps` (line 1092: leverage 1 to 20, `LEVERAGE_NOT_ALLOWED` details `{requested, max}`, `402 INSUFFICIENT_CASH`), `Perp` (line 2944), `getMarketCoin` (line 955: `Candle` objects, `riskHint` string), `LiquidatedMessage.lossCents` (`messages.ts` line 118).
- **Fix:** (1) Set the leverage ceiling to 20 (route and `MAX_LEVERAGE`). (2) Return arrays and contract numbers (see Decision D9 for 200 vs 201 and the string-money policy). (3) Details key `max`, and `402 INSUFFICIENT_CASH` for short margin (B28). (4) In open, reject coins that are `dead` or have a non-positive price, like spot does (`terminal-cafe.ts` line 284). (5) Define the realized-loss semantics (Decision D11): store the realized result on liquidation and add `lossCents` to the `liquidated` message. (6) Provide a read-only receipt lookup by idempotency key for ambiguous opens (Decision D11). (7) Serve OHLC `Candle` objects, or change the contract.
- **Done when:** `post /perps … leverage 21` → 400 `LEVERAGE_NOT_ALLOWED` with `details.max`; open on a dead coin → 400; short margin → 402; `get /perps` returns an array; after a liquidation `realized_cents` is set and the city room receives `liquidated` with `lossCents`.
- **Client impact:** the client reads both observed shapes today, caps order leverage at 20 itself, and keeps normal Perps submissions disabled until B31 and this are verified.

---

## P4. Voice and social

### B23 No `POST /rtc/token`: no proximity voice, Space audio or invitee call media
- **Priority / area:** P4 · voice (#40, #69, #74).
- **Endpoint or room:** `POST /v1/rtc/token`; Spaces routes.
- **Code:** no route. Token minting exists: `server/application/livekit.ts` → `mintRtcToken()` (line 109), `roomName()` (line 77); `server/shared/livekit/token.ts` (`RtcKind` line 18, TTL 1 h line 36). Callers: `video-calls.ts` line 100 and `paid-calls.ts` line 144 only. `server/api/routes/spaces.ts` (lines 53 to 138) has no audio token path, so a created Space has no way to get audio. The LiveKit webhook logic `server/application/livekit-webhook.ts` (`applyLiveKitEvent`, line 73) has no route. Space ids are `space:{uuidv7}` (see below).
- **Now (observed):** `POST /v1/rtc/token` is `404 No route`. Proximity voice, Space audio and call media for invitees cannot get a token. Spaces: `GET /spaces` returns `{spaces:[…]}` (verified), ids are `space:{uuidv7}` while the contract id is `format: uuid`; fields are `speakerUserIds`/`handUserIds` (contract `speakerIds`/`handIds`, `hostId`); promotion is `POST /spaces/{id}/speakers/{userId}` (contract: `POST /spaces/{id}/speakers` with body `{userId}`); the stage cap is 8 including the host (spec: host + 10); several creates answer 201. For local testing the client uses a dev-only LiveKit token from the local dev keys.
- **Expected (contract):** `postRtcToken` (`contract/openapi.yaml` line 1623): body `{kind: venue|space|call, id}`; response `{url, token, expiresAt (date-time), canPublish}`; room `{kind}:{id}`; "canPublish is true only for hosts and promoted speakers". `Space` (line 3051: `spaceId` uuid, `title`, `hostId`, `speakerIds`, `handIds`, `listenerCount`), `getSpaces` (line 1658: array), `postSpacesIdSpeakers` (line 1758, `NOT_SPACE_HOST`), `postWebhooksLivekit` (line 2580).
- **Fix:** (1) Add `POST /v1/rtc/token` with `requireAuth` and idempotency. `venue`: the caller must be in that venue (or at least signed in, and the venue must exist); `space`: caller must be in the space, `canPublish` true only for host and promoted speakers (read `voice_speakers`); `call`: caller must be a participant (B3). Map `call` to the internal kind. Return `expiresAt` as an ISO date-time. (2) Make Space create and read use uuid ids and the contract field names (additive aliases are fine). (3) Add `POST /spaces/{id}/speakers {userId}` (the old path may stay). (4) Add the LiveKit webhook route that calls `verifyLiveKitSignature` and `applyLiveKitEvent`. (5) Send `space_update` on the city room (B16).
- **Done when:** curl: A creates a Space; B `POST /rtc/token {kind:'space', id}` returns `canPublish:false`; A promotes B; a new token for B returns `canPublish:true`; C who is not in the space gets 403; a token for another user's call gets 403. `GET /spaces` returns an array of contract `Space` objects with uuid ids. A signed LiveKit webhook returns 200.
- **Client impact:** unblocks proximity voice, Space audio and call media. Removes the dev-only token path.

### B24 Paid calls: different API, no transaction to sign, fee model unclear, no refund job
- **Priority / area:** P4 · money · needs Decision D1 (#70, #71; source review).
- **Endpoint or room:** `POST /v1/paid-calls` and the five sub-routes; `PUT /v1/creator` (missing).
- **Code:** `server/api/routes/paid-calls.ts` (start body `{payeeUserId, pricePerMinuteCents, maxMinutes}` lines 25 to 29; end body `{secondsUsed}` lines 35 to 37). `server/application/paid-calls.ts` → `PLATFORM_FEE_BPS = 500` (line 56), `startPaidCall()` returns `{call, livekit}` with status `awaiting_payment` (lines 138 to 170 area), `endPaidCall()` (line 301; seconds are client-reported, lines 305 and 333 to 335), `submitOnChainSettle()` does `new PublicKey(args.payerUserId)` (line 458) with a user UUID, `onchain_session_id` is read (line 315) but never written. `server/api/routes/creator.ts` (POST line 33, GET line 40, PATCH line 46; no rate or max minutes). Spec and docs on the fee: `docs/spec/contract.md` lines 746 to 773 (fee_bps 1000; deposit = rate × max × (1 + fee_bps/10000); the creator gets rate × minutes; the treasury gets the fee on top), `docs/ONCHAIN.md` line 19, versus `contract/idl/ct_escrow.json` lines 325 to 345 (docs inside the IDL: fee is deducted from gross; `creator_payout = gross − fee`).
- **Now (observed):** the fan sets the price and minutes (`POST /paid-calls {payeeUserId, pricePerMinuteCents, maxMinutes}`) instead of `{creatorId, minutes}`. The response is `{call, livekit}` with no `tx` or `sessionPda`, so there is nothing to sign. Status is never `ringing`. Amounts are cent numbers (contract: base-unit strings). The fee is 5% taken from the creator's gross; the spec and IDL say 10% (`fee_bps` 1000), and your own docs disagree about whether it is deducted or added on top. `/end` trusts a `secondsUsed` reported by either side, so the payer can report 0 or the payee can report the maximum. No accept-window refund job exists. `submitOnChainSettle` would throw on a UUID. There is no `PUT /creator`: `POST`/`PATCH /creator` take `{handle, bio, categories}` and no rate or max minutes.
- **Expected (contract):** `postPaidCalls` (`contract/openapi.yaml` line 1910): `{creatorId, minutes}` → `{callId, sessionPda, tx}`; `PaidCall` (line 3068: statuses `awaiting_payment | ringing | live | settled | refunded`, `minutesUsed`, `creatorAmount`/`refundAmount` as base-unit strings); `postPaidCallsIdSubmitted` (line 1944), accept (1972), decline (1991), end (2010), `getPaidCall`; `putCreator` (line 1863: `{enabled, ratePerMinUsdc (string, 250000 to 50000000), maxMinutes 1 to 60}` → `CreatorProfile`). `docs/spec/contract.md` lines 738 to 782 (escrow program; `refund()` when the creator does not answer within the accept window of 120 s).
- **Fix:** after Decision D1: (1) `PUT /creator` storing `enabled`, `ratePerMinUsdc`, `maxMinutes` with the contract ranges. (2) `POST /paid-calls {creatorId, minutes}` reads the rate from the creator profile, creates the session id, builds the unsigned v0 `open_session` transaction (`server/shared/solana/ct-escrow.ts`), stores `onchain_session_id`, and returns `{callId, sessionPda, tx}`. (3) After `submitted` the call is `ringing`; accept moves it to `live`; send `call_invite` (B16). (4) Compute the seconds used on the server (from the LiveKit participant join and leave events or from `started_at`), not from the request body. (5) Add the job that calls the program's `refund()` after the accept window and sets `refunded`. (6) Resolve the program keys properly: pass the wallets (`users.wallet`) to `new PublicKey`, not user ids. (7) Amounts as base-unit strings per `PaidCall`.
- **Done when:** `PUT /creator` with a rate outside 250000 to 50000000 → 400; `POST /paid-calls {creatorId, minutes}` returns `{callId, sessionPda, tx}` where `tx` is a v0 transaction; after `submitted` the status is `ringing`; the creator declines or lets the window pass and the status becomes `refunded`; a payer who posts `secondsUsed: 0` cannot reduce the creator's pay.
- **Client impact:** unblocks paid calls. The client cannot show a sign step until `tx` exists.

### B25 DMs, tips and feed ignore blocks and differ from the contract
- **Priority / area:** P4 · social · safety (#72, #73, #66).
- **Endpoint or room:** `GET /v1/dms`, `POST /v1/dms/{userId}`, `GET /v1/feed`, `POST /v1/tips`, `POST /v1/tips/onchain`
- **Code:** `server/api/routes/social-graph.ts` (`GET /dms` requires `peerUserId`, lines 43 to 50; `GET /dms/:userId` lines 53 to 63; `POST /dms/:userId` lines 66 to 76 returns 201; feed lines 79 to 96 returns `{posts}`). `server/application/social-graph.ts` → `listDms()` (line 40; filters only messages whose sender the requester blocked, lines 52 to 55), `sendDm()` (line 86: no block check, no receiver check), `listFeed()` (line 125: no block filter; `COALESCE(ch.alias, u.wallet) AS alias` at line 149). `server/api/routes/tips.ts` (body `{toUserId, amountCents}` lines 15 to 19). `server/application/tips.ts` → `sendCashTip()` (line 72; insufficient cash is `ValidationFailedError` at line 102 to 107; no daily cap, response is a tip row not the new balance), `recordOnchainTip()` (line 159: inserts a `pending` row and nothing credits or verifies it; `helius-webhook.ts` only handles payment intents).
- **Now (observed):** `GET /dms` with no `peerUserId` returns `VALIDATION_FAILED {"reason":"peerUserId required"}` (verified), so there is no thread list. `POST /dms` ignores the receiver's block. `GET /feed` does not hide blocked authors. `POST /tips {toUserId, cashCents}` (the contract body) returns `VALIDATION_FAILED expected amountCents` (verified); the response has no new balance; insufficient Cash is `VALIDATION_FAILED`; there is no daily cap. `POST /tips/onchain` requires `amountLamports` and records a pending in-game tip (spec: wallet-to-wallet). `GET /feed` returns `{posts}` (contract: `FeedPost[]`). When a feed author has no character the feed shows their wallet address as the alias (source).
- **Expected (contract):** `getDms` (`contract/openapi.yaml` line 1490: threads, `DmThread[]`), `getDmsUserId` (1505), `postDmsUserId` (1527: `403 BLOCKED` if the receiver blocked the sender), `getFeed` (1420), `postFeedPosts` (1439), `postTips` (1564: body `{toUserId, cashCents}`, response `{cashCents}` = the sender's new balance, `402`, daily cap from `economy.json`), `postTipsOnchain` (1602).
- **Fix:** (1) `GET /dms` with no `peerUserId` returns the caller's threads (one row per peer: last message, unread count) per `DmThread`. (2) `sendDm` checks both block directions and answers `403 BLOCKED`. (3) `listFeed` and `listDms` hide authors the caller blocked and, if you want symmetry, authors who blocked the caller. (4) Never use `users.wallet` as an alias fallback; use the `skrName` or a neutral label. (5) Accept `cashCents` for tips (keep `amountCents` as an alias if you like), return `{cashCents: newBalance}`, throw `InsufficientCashError` (B28), and add the daily cap key to `economy.json` (Decision: value). (6) Decide what `/tips/onchain` does (verify the transfer on-chain, then record); today it records unverified claims.
- **Done when:** B blocks A: `post /dms/<B> $TA '{"text":"hi"}'` → 403 `BLOCKED`; B's `get /feed` has no posts from A; `get /dms $TB` returns thread rows; `post /tips $T '{"toUserId":"<id>","cashCents":100}'` → 200 `{"cashCents":<balance>}`; with no cash → 402 `INSUFFICIENT_CASH`.
- **Client impact:** unblocks the DM inbox and keeps blocked users out of the feed and chat. The client currently polls one thread at a time and tolerates the wrappers.

---

## P5. City life

### B26 Homes do not match the contract; there is no `home` room
- **Priority / area:** P5 · homes (#75).
- **Endpoint or room:** `GET /v1/homes` (missing), `POST /v1/homes/{homeId}/rent`, `POST /v1/homes/{ownerId}/visit`, room `home`.
- **Code:** `server/api/routes/homes.ts` (lines 31 to 62: `POST /homes`, `POST /homes/:homeId/rent`, `POST /homes/:ownerId/visit` returns 201, `GET /homes/:id`). `server/application/homes.ts` → `createHome()` (line 84; ids are `home:<uuidv7>`), `payRent()` (line 157; the owner check at lines 174 to 176 throws `ValidationFailedError`), `recordVisit()` (line 235: looks up `homes.home_id = <ownerId>`, inserts a visit row, returns it). `server/realtime/main.ts` lines 43 to 56 define only `city`, `market`, `venue`, `space`, `video_call`. `contract/ids/homes.json`, `contract/realtime/states.ts` `HomeState` (line 81), `contract/ids/spots.json` venue `home`.
- **Now (observed):** `GET /v1/homes` is `404 No route`. `POST /v1/homes/studio/rent` → `404 NOT_FOUND {resource: home}`: the route treats `:homeId` as a home instance id and only pays rent on an owned instance (contract: a home type id; signs a lease). `POST /v1/homes/<ownerUserId>/visit` → `404 NOT_FOUND`; when a visit works it returns a visit-log row and no `roomId`. No `home` room is defined, so 3D visits and moving home cannot work end to end. The rent worker also does not run (B12).
- **Expected (contract):** `getHomes` (`contract/openapi.yaml` line 572: `Home[]` with `id`, `name`, `rentCents`, `nextDueAt`), `postHomesHomeIdRent` (line 600: type id; `{homeId, rentCents, nextDueAt}`; `402 INSUFFICIENT_CASH`), `postHomesOwnerIdVisit` (line 639: `{roomId}` for `client.joinById`, example `home:0192a1c2-…`). `docs/REALTIME.md` line 14 (`home` room: created on visit, 12 clients, 10 Hz, venue schema).
- **Fix:** (1) `GET /homes` lists the home types from `homes.json` with rent and the caller's next due date. (2) `POST /homes/{homeType}/rent` signs a lease for the type (moves the player's home, debits the deposit, sets `characters.home_id`) and returns the contract shape; paying weekly rent on an instance moves to a separate route (we proposed `POST /me/home/rent-payments` in `phase4-6/`). (3) `POST /homes/{ownerId}/visit` takes the owner's user id, finds that user's home, creates or finds the `home` room and returns `{ roomId: 'home:<ownerId>' }`. (4) Define a `home` room (`HomeState`) in `server/realtime/main.ts` with `filterBy(['ownerId'])`, max 12, authenticated (B5), and a visit rule (owner present? friends only?). (5) Return `INSUFFICIENT_CASH` (B28) and `FORBIDDEN` for the owner check.
- **Done when:** `get /homes $T` returns the five types; `post /homes/studio/rent $T` with enough cash → 200 `{homeId:'studio', rentCents, nextDueAt}`, with none → 402; `post /homes/<ownerId>/visit $T2` returns `{roomId}` and `joinById(roomId)` succeeds.
- **Client impact:** unblocks home selection, moving, and 3D home visits (the visit hook is not wired in the client until a `home` room exists).

### B27 Venue registry: three built venues are not in `spots.json`, and `venues.json` lags
- **Priority / area:** P5 · registries (our summary line said 8; re-checked at `9f3e5ef`).
- **Endpoint or room:** `venue` rooms for `checker_kiosk`, `yacht_club`, `penthouse_row` and the venues missing from `GET /config`.
- **Code:** `contract/ids/spots.json` (version `1.1.0`; 22 venues). `contract/ids/venues.json` (version `1.0.0-rc1`; 16 venues, includes `builder_hills` and `airdrop_farm`, which are not in `spots.json`). `venue.ts` `loadVenueConfig()` (lines 465 to 474) reads `spots.json`. `GET /v1/config` returns `venues` from `venues.json` (`core.ts` line 55).
- **Now (observed):** at `9f3e5ef`, `spots.json` already has `conference_hall`, `ct_jail`, `hackathon_house`, `airdrop_fields` and `sybil_barn`, but `checker_kiosk`, `yacht_club` and `penthouse_row` are missing from both files. `venues.json` (what the client reads from `/config`) lacks `the_trenches`, `club_liquidity`, `hackathon_house`, `conference_hall`, `airdrop_fields`, `sybil_barn`, `ct_jail` and `home`, and lists `builder_hills` and `airdrop_farm` that have no spots. For 10 venues (`discord_heights`, `audit_row`, `vc_row`, `hackathon_house`, `conference_hall`, `ratio_arena`, `airdrop_fields`, `sybil_barn`, `cabal_lounge`, `ct_jail`) our file has extra spot ids that yours does not; the walkable rectangles are identical in all 22 shared venues. A room for a venue with no entry gets an empty walkable list.
- **Expected (contract):** `docs/spec/contract.md` section 2: FE owns anims, sfx and spots; BE may only reference ids that exist. `contract/ids/ids.schema.json`.
- **Fix:** adopt our `ids/spots.json` (version `1.0.0-rc1+fe.2`; it keeps every id and kind you have and adds the three venues and the extra spots), and update `venues.json` so its ids match `spots.json` (add the 11 venues it lacks: the 8 listed above that `spots.json` already has, plus `checker_kiosk`, `yacht_club`, `penthouse_row`, and either add spots for `builder_hills`/`airdrop_farm` or remove or rename them). Run `pnpm contract:check`.
- **Done when:** every id in `venues.json` exists in `spots.json` and the reverse, checked by a new test; `joinOrCreate('venue', {venueId})` works for every venue id.
- **Client impact:** the client has built scenes for these venues. Today it works only because it bundles its own copy of the registries.

### B28 Insufficient Cash is reported as `VALIDATION_FAILED` or `FORBIDDEN`
- **Priority / area:** P5 · errors (city-life #2, Phase 4-6 #6).
- **Endpoint or room:** every route that spends Cash.
- **Code:** correct usage: `server/application/terminal-cafe.ts` line 337 (`InsufficientCashError`, 402). Wrong, by the line of the `reason:` string: `cosmetics.ts` `purchase()` line 248; `season-pass.ts` `buy()` line 87; `tips.ts` `sendCashTip()` line 103; `homes.ts` `createHome()` line 115 and `payRent()` line 190; `projects.ts` `foundProject()` line 128 and `hirePlayer()` line 193; `businesses.ts` `createBusiness()` line 196; `ratio-arena.ts` `openMatch()` line 129 and `acceptMatch()` line 191 (`ForbiddenError`); `perp-pit.ts` `openPerp()` line 125 (`ForbiddenError('insufficient_margin')`). Error class: `server/shared/domain/errors.ts` line 111 (`code 'INSUFFICIENT_CASH'`, status 402).
- **Now (observed):** short Cash gives `VALIDATION_FAILED {reason:"insufficient cash", have, need}` or `FORBIDDEN`, not `402 INSUFFICIENT_CASH`.
- **Expected (contract):** `INSUFFICIENT_CASH` 402 with `details: { shortfallCents }` (for example `postMarketTrades` line 1045, `postHomesHomeIdRent` line 621, `postPerps` line 1138).
- **Fix:** replace each of the throws above with `InsufficientCashError({ shortfallCents: need − have })` (keep `have`/`need` too if you like). Keep `FORBIDDEN` for the owner or permission checks.
- **Done when:** a vitest table drives each route with a $0 user and expects `402` and `error.code === 'INSUFFICIENT_CASH'` with `details.shortfallCents`.
- **Client impact:** the client shows one "not enough Cash" message driven by the code. Today it matches on `reason` strings.

---

## P6. Tooling and hygiene

### B29 Local setup and test suite problems
- **Priority / area:** P6 · tooling (#35 to #37).
- **Endpoint or room:** `docker-compose.yml`, migrations, tests, scripts.
- **Code:** `docker-compose.yml` line 55 (`livekit/livekit:v1.13.7`), lines 67 and 86 (`minio/minio:RELEASE.2026-01-01T00-00-00Z`, `minio/mc:RELEASE.2026-01-01T00-00-00Z`), lines 113, 134, 155 (`env_file: .env`). `db/migrations/1700000060000_webhook_events_helius_program.sql` (no `-- Up Migration` marker). `.env.example` line 123 (`LLM_MODEL=`) and `server/shared/config/config.ts` line 291 (`process.env.LLM_MODEL ?? '<default model id>'`). `server/application/program-webhook.test.ts` line 88. `tools/scripts/inspect-ore.ts` lines 1 to 2. `package.json` line 26 (`db:status`). `tools/bots/world.ts` (reads `--bots`/`--venue`, line 8 and lines 15 to 22), `tools/bots/bot.ts` line 194.
- **Now (observed):** the compose images do not exist: `livekit/livekit:v1.13.7` (the image is `livekit/livekit-server`) and the two MinIO tags. `env_file: .env` with `localhost` URLs cannot reach `postgres`/`redis` from inside the api, realtime and workers containers. Migration 060 has no Up marker, so `pnpm db:migrate` runs its up and its down section, leaving `webhook_events_source_check` without `helius_program`; `program-webhook.test.ts` then fails. With `LLM_MODEL=` empty the `??` does not fall back, the model is `''`, and it violates `llm_npc_interactions_model_check` (5 failing tests in `llm-npcs.test.ts`). Result on a clean `.env`: 6 of 316 tests fail. `pnpm typecheck` has 3 errors: `program-webhook.test.ts:88` uses `expected`, which is declared in another test (line 74); `tools/scripts/inspect-ore.ts` lines 1 to 2 import with `.ts` extensions and an unused `Transaction`. `pnpm db:status` is not a `node-pg-migrate` command. `tools/bots/world.ts` ignores `BOT_COUNT`/`BOT_VENUE`, and bots leave the room after 200 ms, so the `mock` profile has no standing population.
- **Expected (contract):** `README.md` Quick start (line 74), `docs/HANDOVER.md`.
- **Fix:** (1) Use real image names/tags (`livekit/livekit-server`, and a MinIO tag that exists), and give the app services a `.env` override with service hostnames (`postgres`, `redis`, `livekit`). (2) Add `-- Up Migration` at the top of migration 060 (do not edit an applied migration in a shared database; add a fix-up migration 061 that re-adds the constraint with `helius_program` if 060 already ran anywhere). (3) Treat an empty `LLM_MODEL` as unset in `config.ts` (`|| '<default model id>'`) or remove the empty line from `.env.example`. (4) Fix the two typecheck sources. (5) Replace `db:status` with a real command or delete it. (6) Read `BOT_COUNT`/`BOT_VENUE` in `world.ts` and keep bots in the room.
- **Done when:** on a clean clone with `.env.example` copied: `docker compose --profile mock up -d` starts every service; `pnpm db:migrate && pnpm db:verify` pass; `pnpm test:unit` is green; `pnpm typecheck` has 0 errors; 20 bots stay in Timeline Square for a minute.
- **Client impact:** none functional. Everyone else can reproduce your stack without our two workarounds.

### B30 61 of 135 routes have no contract operation; 16 contract operations have no route
- **Priority / area:** P6 · contract hygiene (Phase 4-6 README #7).
- **Endpoint or room:** `server/api/routes/*.ts` vs `contract/openapi.yaml`.
- **Code:** all route files under `server/api/routes/`; `docs/PROGRESS.md` (M8 says "No contract changes since rc1"); `tools/contract-check/` (has no route-versus-operation check).
- **Now (observed):** we compared `app.<method>('<path>')` in `server/api/routes/*.ts` and `server/api/main.ts` with the 90 operations. 61 `/v1` routes have no operation (plus `/docs`, `/healthz`, `/metrics`, `/readyz`). Examples: `POST /feed/posts`, `POST /predictions`, `POST /market/launchpad`, `POST /market/launchpad/{}/buy`, `POST /payments/intents/{}/submitted`, `POST /ore/stake/submitted`, `POST /video-calls/{}/end`, `POST /spaces/{}/speakers/{}`, `POST /webhooks/helius-program`, the beef, cabal, tribe, league, district, project, business, season-pass, nft, x-link, llm, tips (GET), airdrop and admin routes. 16 contract operations have no route: `GET /admin/moderation/queue`, `POST /admin/ads/approve`, `POST /admin/bans`, `POST /admin/market/force-price`, `POST /admin/users/{id}/skills`, `GET /events/active`, `GET /homes`, `GET /payments/intents/{id}`, `PATCH /characters/me/look`, `PATCH /characters/me/tribe`, `POST /feed`, `POST /predictions/{id}/bets`, `POST /rtc/token`, `POST /spaces/{id}/speakers`, `POST /webhooks/livekit`, `PUT /creator`. (An earlier live probe counted 15; the list here comes from a script over the source.)
- **Expected (contract):** `contract/CHANGELOG.md` rule: additive changes only; every route has an operation.
- **Fix:** (1) Add a `contract:check` step that fails when a registered route has no operation or an operation has no route (normalise `:id` and `{id}`). (2) Either add operations for the 61 routes (our `phase4-6/openapi-additions.yaml` covers 88 operations and merges with 0 collisions via `phase4-6/merge.mjs`) or mark them `x-internal`. (3) Implement or consciously defer the 16 missing operations; B3, B16, B19, B23, B24, B26 cover most of them. (4) Update the docs that claim no contract changes.
- **Done when:** `pnpm contract:check` passes with the new check enabled and lists no unmatched route or operation (except an allowlist with reasons).
- **Client impact:** the client generates its models from the contract. Anything outside the contract has to be hand-written and can drift.

### B37 (extra) First-round contract and codegen asks (still open at `9f3e5ef`)
- **Priority / area:** P6 · contract/codegen (#1 to #19 of the first review; re-checked at `9f3e5ef`).
- **Endpoint or room:** `contract/openapi.yaml`, `contract/realtime/*`, `contract/ids/*`, `docs/HANDOVER.md`.
- **Code:** `contract/openapi.yaml` line 2792 (`ageConfirmed: { type: boolean, const: true }`); money fields typed `{ type: integer }` with no `format: int64` (for example lines 464, 515, 2761; `format: int64` appears 0 times); inline response schemas (`getCareers` line 697, `postRtcToken` line 1645, `getLeaderboard`, `postNeedsAction` line 509, `getMarketCoins`, `getDailyClue`); `ConfigResponse` sections untyped (lines 2859 to 2868); `ServerError` referenced at lines 91, 181 and 338 and by the payments `503`; `contract/realtime/messages.ts` (Zod only; codegen emits only the 7 state classes); `RejectedMessage` enum (lines 70 to 97); `EventMessage.eventId` (lines 105 to 112); `contract/ids/spots.json`; `docs/HANDOVER.md` lines 19 to 26 (`pnpm contract:codegen`, `contract/README.md`); `package.json` line 29 (`contract:codegen` → `tools/contract-check/codegen.ts`, which does not exist).
- **Now (observed):** the generator (openapi-generator 7.25.0, `csharp`) works, and our client builds, but only because a local patch script fixes: (1) `type: boolean` + `const: true` generates `enum AgeConfirmedEnum { True = true }`, which is invalid C#; (2) every `integer` money field becomes a 32-bit `int`, so a value above 2,147,483,647 cents makes decoding throw (rich players, `BoardEntry.value`); (3) anonymous inline schemas get generated names that change when a path changes. Also: `ConfigResponse` sections are untyped; `GET /config` at `9f3e5ef` returns venues, archetypes, traits, tribes, dreams, homes, toasts, anims, sfx, items, economy, needs, skills, lottery, careers, events and boards (`core.ts` lines 55 to 72) but still not `mini_games`, `report_reasons`, `errors`, `npc_lines`, `spots`, `market`, `ore`, `ads` or `meta`, and `venues` use `maxClients` where the spec used `maxPlayers`; `GET /careers` has no per-level title, pay, shift length or games; `Me.flags` keys are undocumented (B13); the server sends `rejected` codes not in the enum (`SPOT_NOT_FOUND`, `UNKNOWN_EMOTE`, `OUT_OF_BOUNDS`, `SPEED_EXCEEDED`, `NPC_NOT_FOUND`); no C# is generated for any realtime message; `docs/HANDOVER.md` points to files and a command that do not exist; `EventMessage.eventId` has 6 events while the spec lists more; `GET /ads/live` returns `{ads:[{slotId, bookingId, link, imageKey, mimeType}]}` (an S3 key, no `imageUrl`/`sponsored`) instead of the contract slot map.
- **Expected (contract):** the client's rule: any codegen failure is a contract bug. `contract/realtime/README.md`, `docs/spec/contract.md` section 7 (the client never hardcodes config).
- **Fix:** (1) `ageConfirmed`: plain `type: boolean`, with "must be true, else VALIDATION_FAILED" in the description. (2) Add `format: int64` to every `*Cents` field and `BoardEntry.value`. (3) Promote the inline schemas to `components/schemas` (suggested names: `LotteryResult`, `CareerSummary`, `ShiftResult`, `RtcToken`, `Leaderboard`, `NeedsActionResult`, `CoinPage`, `CoinDetail`, `DailyClue`). (4) Type the `ConfigResponse` sections (at least `venues`, `archetypes`, `tribes`, `npc_lines`, `careers`) and add the missing registries (`mini_games`, `report_reasons`, `errors`, `npc_lines`) or tell us to bundle them. (5) Reference `ServerError` (503) on every operation that can shed load and say whether `Retry-After` is always delta-seconds. (6) Add the five realtime reject codes and the other new codes to `RejectedMessage` and `errors.json`. (7) Export the message payloads as plain TS interfaces or publish JSON Schema (`zod-to-json-schema`) so a C# client can be generated. (8) Fix `HANDOVER.md` and remove or implement `contract:codegen`. (9) Make `/ads/live` return `imageUrl`.
- **Done when:** the client's codegen (`openapi-generator-cli` 7.25.0, `generator csharp`, models only) produces models that compile unpatched; a 3-billion-cent value round-trips through `Me.cashCents`; `pnpm contract:check` passes.
- **Client impact:** removes the client's `patch_rest_codegen.py` and the hand-written message mirrors.

---

## 4. Decisions needed (reply, not code)

Please answer by replying to the person who sent this document. Where we have a view it is marked "Our recommendation". Where the log has none, we say so.

- **D1 Paid-call fee and escrow flow (B24).** The code takes 5% (`PLATFORM_FEE_BPS = 500`, `paid-calls.ts` line 56). The spec and IDL config say `fee_bps` 1000 (10%). Your docs also disagree on the model: `docs/spec/contract.md` lines 746 to 773 and `docs/ONCHAIN.md` line 19 say the fee is added on top (deposit = rate × max × (1 + fee), the creator gets the full rate × minutes), while the IDL docs (`contract/idl/ct_escrow.json` lines 325 to 345) say it is deducted from the creator's gross. Options: (a) 10% on top, as the spec; (b) 5% deducted, as the code; (c) another number. Also confirm the refund flow: accept window 120 s, then the backend calls `refund()`; who reports seconds (we say the server, from LiveKit). We have no product preference; the client shows whatever `PaidCall` returns. Default if you do not reply: follow the written spec (a).
- **D2 Prediction shapes (B22).** The client is built on the contract: `GET /predictions` → open `PredictionMarket[]` and `POST /predictions/{id}/bets`. Your code has a per-horizon bet route with no market list. Options: (a) implement the contract; (b) keep yours and send us a revised contract section with market listing. Our recommendation: (a), because the Pit screen needs a market list.
- **D3 Careers XP and level model (B18).** Not defined in the contract (`skills.json xpPerShiftLevel` and `careers.json levels[].xp` are ambiguous). Our proposal: add `xpToNext` (null at level 5) to each `GET /careers` row; `active` = "my current job" (plus an `offered` flag for the config flag); the client only shows `promoted` from the shift receipt and never computes promotion. Options for the curve are yours to choose and tell us. Also decide whether a level can have several mini-games (`miniGameIds`, we proposed 1 to 2 rotating).
- **D4 SIWS domain and URI (B6).** No domain is bought (your `build-spec.md` line 2539 asks the same question). Config-driven values `SIWS_DOMAIN` / `SIWS_URI`. Options: `ctlife.dev` / `https://ctlife.dev` (the contract example and the client's REST hosts `staging-api.ctlife.dev` and `api.ctlife.dev` use this), or `ctlife.app` / `https://ctlife.app` (the example in our first note). Our recommendation: `ctlife.dev` until a real domain exists, because it matches the contract. We will set the client's wallet identity URI to the same value (it is a placeholder `https://ctlife.invalid/` today). [Unverified] whether Seed Vault enforces the domain against the dApp identity; send the same value on both sides to be safe.
- **D5 Top-up cap value and unit (B22).** `economy.json` has `topUpCapCentsPerDay = 1000000` with `topUpCapCurrency: USDC`; as USDC cents that is 10,000 USDC, but the spec and error copy say 100 USDC (a 100× gap). Confirm the cap, the unit (paid USDC value, not credited Cash) and the error copy together. We hard-code neither number; the client uses your quote.
- **D6 ORE tiers, board example and units (B21).** Config requires 1 ORE for Prospector while the spec says any ORE; the board example has 2 squares while the schema requires 25; the example motherlode 55,000,000,000 at 11 decimals is 0.55 ORE while the spec example says 55. Confirm the thresholds, publish a valid 25-square example, and state raw versus display units for every ORE amount.
- **D7 Pack labels (B19).** `economy.json` tags `whale` as `bestValue`, but `cabal` has a higher base Cash per USDC. Define how `bestValue` is computed and fix the label or the pack values. The client will not advertise a value comparison it cannot verify.
- **D8 Transaction cluster and confirmation contract (B19, B21).** `PaymentIntent` and the stake response do not say which cluster to sign on, and there is no expiry or status for stake. Options: add `cluster` (and a last-valid block height or expiry) to the transaction responses, or give us a per-operation config mapping. The client must reconnect the wallet to the right cluster before signing and will not silently use the staging devnet signer for ORE.
- **D9 Status code and money-format rule for creates (B13, B38).** The contract says 200 for creates; `main` returns 201 (`POST /characters`, `/perps`, most new routes). Money and ids: the code returns bigint fields as decimal strings and wraps lists as `{coins|positions|perps|tombstones|trades}`, the contract uses numbers and arrays. Pick one rule and apply it to either the code or the contract; the client reads both for now.
- **D10 `minClientVersion` and `/config` versioning (B34).** It is `1.0.0` while no client is released. Confirm the version scheme you intend (we send `X-Client-Version`).
- **D11 Perps receipts and settlement (B31, B38).** Define a read-only way to look up the result of an open by idempotency key (including behaviour at the 24 h replay boundary) or a durable replay policy; and define the realized-loss semantics (what a close returns when margin plus result is negative, what a liquidation stores and sends). The client labels the returned result and refreshes `/me` for available Cash.
- **D12 Growth of `EventMessage.eventId` and `degraded` delivery (B16, B34).** Confirm the enum will grow additively (graduation, big win, Sunday Unlock, Weekly Meta are in the spec), and whether `degraded` changes should also be pushed on the `city` room or only polled (the client polls every 2 minutes).
- **D13 Registries in `GET /config` (B37).** `/config` now returns most registries. Still missing: `mini_games` (maxScore, durationSec), `report_reasons`, `errors`, `npc_lines`. Add them, or confirm the client should bundle them (it bundles a snapshot and merges `/config` over it today). Same question for `GET /careers`: should each level's title, pay, shift length and games come from config `careers` or from the endpoint?
- **D14 Beef settlement authority (B1).** Only a trusted actor may settle. Default now: admin only. If you plan settlement by votes later, tell us the design (voter eligibility, timing, draw rule).

---

## 5. Already fine / don't change

These work against `9f3e5ef` and the client depends on them. Please keep the behavior and shapes.

- **Health and config:** `GET /healthz`, `GET /v1/config` (body and registries; add to it, do not remove), `GET /v1/auth/jwks`.
- **Auth plumbing:** `POST /v1/auth/dev` (with `ENABLE_DEV_AUTH=true`, body `{wallet}` only), `GET /v1/auth/challenge`, `POST /v1/auth/refresh` and the single-use refresh rotation, token expiry (the client refreshes from the JWT `exp` and calls `EnsureFresh` before every room join), logout. The nonce is consumed only after a successful verify (`auth.ts` line 111); the client's retry relies on that.
- **Player:** `GET /v1/me`, `POST /v1/characters`, `POST /v1/lottery/roll` (first roll), `POST /v1/needs/actions` (eat passes), `GET /v1/careers`, `POST /v1/shifts` and `POST /v1/shifts/{id}/complete` for a normal assigned shift (pays Cash: 30000 to 34000 in our run), `GET /v1/leaderboards/net_worth` (Rich List), gigs (`GET /gigs`, `POST /gigs/{id}/run`: the client reads both id sets), shop list and purchase, `POST /v1/blocks/{id}` / `DELETE` / `POST /v1/reports` (block, report, unblock all pass).
- **Social:** DM send and thread read (`POST /v1/dms/{userId}`, `GET /v1/dms/{userId}`), feed post and read, Space create, `GET /v1/ads/live` (empty list is fine).
- **Perps (1x, Trading level 1):** open and close work and settle Cash.
- **Idempotency replay:** re-sending the same `Idempotency-Key` with the same body replays the cached 2xx (works for gigs and shift completion). Keep that; B31 only changes the in-flight case.
- **Error envelope:** `{error:{code, message, details}}` for domain errors and for 404 (`NOT_FOUND` with `path`/`method`), `Retry-After` on `RATE_LIMITED` and `SERVER_BUSY`, `x-request-id` on every response.
- **Realtime that works:** the `city` and `market` rooms join and rejoin on drop (market rejoin took 0.1 s); `venue` welcome (`welcome {serverNow, instanceId}`), `move`, `emote`, `say` (chat reaches other clients), `talking`, 5 server NPCs in Timeline Square, `rejected {type, code}`. The client handles unknown reject codes without crashing.
- **Registries that are now correct:** `anims.json` (50 ids; it now contains `emote_send_it_slam`, `emote_max_long`, `emote_ring_light_pose`, `emote_frantic_typing`), `spots.json` positions and `anim` fields, `terminal_cafe.table_1..4`, and the 34 positioned `spaces_studio` anchors (they match the client snapshot exactly). `SERVER_BUSY` is now referenced on more than one operation. Please keep all ids append-only.
- **Local LiveKit** with the dev keys works for the client (mic track published to a local LiveKit); `video-calls.ts` token minting and `livekit.ts` helpers are fine, only who receives tokens changes (B3).
- **DM block filter on read** (`social-graph.ts` lines 52 to 55) is right; extend it, do not remove it.

---

## 6. Appendix

### A. B0 patch, verbatim (`0001-siws-ed25519-spki-key.patch`)

Apply from the backend repo root: `git apply 0001-siws-ed25519-spki-key.patch`. The `index` line below is from our checkout. If it does not apply cleanly, make the same three edits by hand.

```diff
diff --git a/server/application/auth.ts b/server/application/auth.ts
index 99c2d58..ec4210e 100644
--- a/server/application/auth.ts
+++ b/server/application/auth.ts
@@ -9,7 +9,7 @@
  * the Helius client. It does not touch the transport layer.
  */
 import { PublicKey } from '@solana/web3.js';
-import { verify as ed25519Verify } from 'node:crypto';
+import { createPublicKey, verify as ed25519Verify } from 'node:crypto';
 import { randomUUID } from 'node:crypto';
 import { z } from 'zod';
 import {
@@ -292,7 +292,12 @@ function verifySignature(wallet: string, signedMessage: string, signatureB64: st
     const pubkey = new PublicKey(wallet);
     const msg = Buffer.from(signedMessage, 'utf8');
     const sig = Buffer.from(signatureB64, 'base64');
-    const pub = Buffer.from(pubkey.toBytes());
+    // node:crypto cannot take a raw 32-byte ed25519 key (ERR_OSSL_UNSUPPORTED); wrap it as SPKI DER.
+    const pub = createPublicKey({
+      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkey.toBytes())]),
+      format: 'der',
+      type: 'spki',
+    });
     return ed25519Verify(null, msg, pub, sig);
   } catch {
     return false;
```

### B. SIWS smoke script (`tools/scripts/siws-smoke.mjs`)

Run from the backend repo root with the API up. `MODE=utf8` (default) matches the server before B8. `MODE=base64` matches the contract (after B8). The message layout follows the standard SIWS text [Inference]; once B6 is done, replace it with the layout you captured from a real Seed Vault message.

```js
import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const API = process.env.API ?? 'http://localhost:4010/v1';
const MODE = process.env.MODE ?? 'utf8';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const wallet = new PublicKey(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).toBase58();

const ch = await (await fetch(`${API}/auth/challenge?wallet=${wallet}`)).json();
const text = [
  `${ch.domain} wants you to sign in with your Solana account:`,
  wallet,
  '',
  ch.statement,
  '',
  `URI: ${ch.uri}`,
  `Version: ${ch.version}`,
  `Chain ID: ${ch.chainId}`,
  `Nonce: ${ch.nonce}`,
  `Issued At: ${ch.issuedAt}`,
  `Expiration Time: ${ch.expirationTime}`,
].join('\n');
const bytes = Buffer.from(text, 'utf8');
const signature = sign(null, bytes, privateKey).toString('base64');
const signedMessage = MODE === 'base64' ? bytes.toString('base64') : text;

const res = await fetch(`${API}/auth/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
  body: JSON.stringify({ address: wallet, signedMessage, signature, nonce: ch.nonce }),
});
console.log(res.status, await res.text());
process.exit(res.status === 200 ? 0 : 1);
```

### C. How we ran your stack locally

Use your own `README.md` Quick start (line 74), `docker-compose.yml` and `.env.example` as the base. We changed nothing in your repo except the B0 patch. We needed these local workarounds, all of which disappear when B11, B12 and B29 are done:

1. **Infra from your compose file:** `docker compose up -d postgres redis livekit` (we skip MinIO; only ad uploads need it). Ports: Postgres 5434, Redis 6381, LiveKit 7880 (ws), 7881 (ICE/TCP), 7882/udp. We used a compose override that replaces the LiveKit image with `livekit/livekit-server:v1.13.7` and runs `--dev --bind 0.0.0.0 --node-ip 127.0.0.1` (B29).
2. **Migrations and env:** `pnpm install --frozen-lockfile`, copy `.env.example` to `.env`, set `DATABASE_URL`, `REDIS_URL`, `JWT_PRIVATE_KEY` (a local PEM), `ENABLE_DEV_AUTH=true`, the devnet treasury/settle/admin keypair variables (local throwaway keys), `HELIUS_API_KEY` (any placeholder), and random `HELIUS_WEBHOOK_SECRET` and `LIVEKIT_WEBHOOK_SECRET`. Then `pnpm db:migrate`. (Set `LLM_MODEL=stub-model` to get the LLM tests green until B29.)
3. **API and realtime on the host** (not in Docker, because the backend uses one `LIVEKIT_URL` both for server calls and for the URL it hands to clients):
   ```sh
   PORT_API=4010      node --import tsx server/api/main.ts
   PORT_REALTIME=2567 TSX_TSCONFIG_PATH=<path>/tsconfig.backend.json node --import tsx server/realtime/main.ts
   ```
4. **Workaround 1, tsconfig override (B11).** `tsconfig.backend.json`, passed through `TSX_TSCONFIG_PATH` for the realtime process:
   ```json
   {
     "extends": "<path-to-backend>/tsconfig.base.json",
     "compilerOptions": { "noEmit": true, "useDefineForClassFields": false, "experimentalDecorators": true },
     "include": ["<path-to-backend>/**/*.ts"],
     "exclude": ["<path-to-backend>/node_modules"]
   }
   ```
   Without it realtime either throws `reading 'constructor'` at import or starts and never syncs state.
5. **Workaround 2, workers disabled (B12).** We do not start `server/workers/main.ts`; it crashes at startup. Opt in with `CTLIFE_WORKERS=1` in our `up.sh` once fixed.
6. **Phone over USB:** `adb reverse tcp:4010 tcp:4010; adb reverse tcp:2567 tcp:2567; adb reverse tcp:7880 tcp:7880; adb reverse tcp:7881 tcp:7881` (adb reverse is TCP only, so LiveKit media on the phone uses ICE/TCP 7881).
7. **Logs we read:** the API and realtime stdout, and the wallet's logcat for the Seed Vault errors (B7).

Our helper scripts, if you want to copy them: `tools/backend-local/up.sh`, `down.sh`, `compose.override.yml` and `tsconfig.backend.json` in the frontend repo. We can send them with this document.
