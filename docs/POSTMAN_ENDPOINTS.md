# CT Life Backend - API Endpoints for Testing

Every path, body and status code below was verified against the running
service. Where this file previously disagreed with the code, the code won.

## Base URLs

| Environment | REST API | Realtime (Colyseus) |
| --- | --- | --- |
| Local | `http://localhost:4010` | `ws://localhost:2567` |
| Staging (Railway, devnet) | `https://ctlife-api-production.up.railway.app` | `wss://ctlife-realtime-production.up.railway.app` |

The local API port comes from `PORT` or `PORT_API` (default 4010 when
`APP_ENV=local`). Realtime reads `PORT_REALTIME` (default 2567).

**Start locally**
```bash
pnpm dev:up                        # postgres, redis, livekit, minio
npx tsx server/api/main.ts         # REST API
npx tsx server/realtime/main.ts    # realtime
npx tsx server/workers/main.ts     # workers
```

## Health

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | liveness, always `200` |
| GET | `/readyz` | checks postgres, redis and helius |
| GET | `/metrics` | Prometheus text |
| GET | `/docs` | rendered OpenAPI |

`/readyz` returns `{"ok":true,"checks":{"postgres":{"ok":true},"redis":{"ok":true},"helius":{"ok":true}}}`.

---

## Authentication (SIWS)

There is no `/v1/auth/nonce`. The flow is `GET /v1/auth/challenge` then
`POST /v1/auth/verify`, and the signed message must reproduce the
challenge **exactly** or verification fails.

`POST /v1/auth/dev` only works when `APP_ENV=local`; on staging it is
disabled and answers `400`.

### 1. Get a challenge

```
GET /v1/auth/challenge?wallet=<BASE58_PUBKEY>

200 {
  "nonce": "<32 hex chars, no hyphens>",
  "domain": "ctlife.fun",
  "statement": "Sign in to CT Life.",
  "uri": "https://ctlife.fun/",
  "version": "1",
  "chainId": "solana:devnet",
  "issuedAt": "2026-10-08T19:00:00.000Z",
  "expirationTime": "2026-10-08T19:05:00.000Z"
}
```

The nonce is valid for 5 minutes and is single use.

### 2. Build the message

Join these lines with `\n`, substituting the challenge values. Lines 3
and 5 are blank and are required:

```
<domain> wants you to sign in with your Solana account:
<wallet>

<statement>

URI: <uri>
Version: <version>
Chain ID: <chainId>
Nonce: <nonce>
Issued At: <issuedAt>
Expiration Time: <expirationTime>
```

The server re-parses this and rejects a mismatch on any of domain,
address, URI, version, chain id, nonce, issued-at or expiration-time.

### 3. Verify

```
POST /v1/auth/verify
Content-Type: application/json

{
  "address":       "<BASE58_PUBKEY>",
  "signedMessage": "<base64 of the UTF-8 message above>",
  "signature":     "<base64 of the raw ed25519 signature>",
  "nonce":         "<nonce from step 1>"
}

200 { "id": "<uuid>", "wallet": "...", "accessToken": "...", "refreshToken": "...", "hasCharacter": false }
```

Field names matter: it is `address`, not `wallet`, and `signature` is
separate from `signedMessage`.

### Working example

```js
const { Keypair } = require('@solana/web3.js');
const { createPrivateKey, sign } = require('node:crypto');

const API = 'http://localhost:4010';
const kp = Keypair.generate();
const address = kp.publicKey.toBase58();

const ch = await (await fetch(`${API}/v1/auth/challenge?wallet=${address}`)).json();
const message = [
  `${ch.domain} wants you to sign in with your Solana account:`,
  address, '', ch.statement, '',
  `URI: ${ch.uri}`,
  `Version: ${ch.version}`,
  `Chain ID: ${ch.chainId}`,
  `Nonce: ${ch.nonce}`,
  `Issued At: ${ch.issuedAt}`,
  `Expiration Time: ${ch.expirationTime}`,
].join('\n');

// Solana secret keys are seed(32) || pubkey(32); node needs the seed as PKCS8.
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(kp.secretKey.slice(0, 32)),
  ]),
  format: 'der', type: 'pkcs8',
});

const res = await fetch(`${API}/v1/auth/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    address,
    signedMessage: Buffer.from(message, 'utf8').toString('base64'),
    signature: sign(null, Buffer.from(message, 'utf8'), key).toString('base64'),
    nonce: ch.nonce,
  }),
});
const { accessToken } = await res.json();
```

### Refresh and logout

```
POST /v1/auth/refresh   { "refreshToken": "..." }          -> 200
POST /v1/auth/logout    { "refreshToken": "..." }          -> 200/204
GET  /v1/auth/jwks                                          -> 200 (RS256 public keys)
```

A malformed or expired refresh token answers `401`, not `500`.

All authenticated requests need `Authorization: Bearer <accessToken>`.

---

## Core

### Config

```
GET /v1/config
```

Public, no auth. Returns `version`, `minClientVersion`, `degraded` (always
present, empty when no kill switch is set) and every registry and game
config file. `emotes` is derived from the `emote_` prefixed ids in
`contract/ids/anims.json`; there is no `emotes.json`.

The `ETag` is a hash of the payload, so it changes when any registry or
config file changes. Send `If-None-Match: "<etag>"` to get `304`. Sending an
`X-Client-Version` below `minClientVersion` answers `426 UPGRADE_REQUIRED`.

### Me, lottery, character

```
GET  /v1/me                  -> 200  profile, character, needs, skills, balance
POST /v1/lottery/roll        -> 200  { outcome, cashCents, debtCents, homeId }
GET  /v1/users/:id           -> 200  public profile
```

```
POST /v1/characters
Authorization: Bearer <token>
Idempotency-Key: <uuid>

{
  "alias": "YourName",                      // 3-24 chars
  "look": {
    "skinTone": "...", "headId": "...", "hairId": "...", "topId": "...",
    "bottomId": "...", "shoesId": "...", "accId": "..."
  },
  "traitIds": ["trait_a", "trait_b"],       // exactly 2
  "dreamId": "...",
  "tribeId": "...",
  "ageConfirmed": true                      // must be literally true
}

201 Created
```

All ids are validated against `/v1/config`.

### Needs

```
POST /v1/needs/actions   { "actionId": "eat" }   -> 200
```

`actionId` is one of `eat`, `sleep`, `shower`, `touch_grass`, `party`.

---

## Work

```
POST /v1/shifts                        { "careerId": "..." }   -> 200
POST /v1/shifts/:shiftId/complete      -> 200
GET  /v1/careers                                               -> 200
POST /v1/careers/:careerId/apply                               -> 200
```

Start takes `careerId`, not `venueId`. Complete takes `results`, not `scores`:

```json
{ "results": [ { "miniGameId": "...", "score": 85 } ] }
```

Only assigned mini-games may be scored, and a shift cannot be completed twice (`409`).

---

## Social

```
POST   /v1/dms/:userId        { "text": "..." }   -> 201   (max 500 chars)
GET    /v1/dms/:userId?before=<cursor>            -> 200
GET    /v1/dms                                    -> 200
POST   /v1/blocks/:userId                         -> 204
DELETE /v1/blocks/:userId                         -> 204
POST   /v1/follows/:userId                        -> 204
DELETE /v1/follows/:userId                        -> 204
POST   /v1/feed/posts         { "text": "..." }   -> 201   (max 280 chars)
GET    /v1/feed?scope=global|following            -> 200
POST   /v1/reports                                -> 204
POST   /v1/tips                                   -> 201
```

The recipient is a path parameter on DMs; there is no `toUserId` body
field and no `POST /v1/dms`. There are no `/v1/friends/*` routes - use
follows.

A DM to a user either party has blocked answers `400 VALIDATION_FAILED`.

```json
// POST /v1/reports
{ "targetType": "user", "targetId": "<id>", "reasonId": "spam", "note": "optional" }

// POST /v1/tips
{ "toUserId": "<uuid>", "amountCents": 100, "message": "optional" }
```

---

## Payments

```
POST /v1/payments/intents                   -> 200
GET  /v1/payments/intents/:id               -> 200
POST /v1/payments/intents/:id/submitted     -> 200
```

```json
{
  "kind": "topup",        // topup | cosmetic | ad | season_pass
  "currency": "USDC",     // USDC | SOL | SKR | ORE
  "sku": "ramen",         // ramen | bag | whale | cabal | custom
  "amountCents": 10000    // only for sku "custom"
}
```

There is no `POST /v1/payments/verify`; report the signature to
`POST /v1/payments/intents/:id/submitted` with `{ "signature": "..." }`.
Non-USDC currencies need a price feed and currently answer `400`.

---

## Voice and video

```
POST   /v1/spaces              { "title": "..." }   -> 201   (title max 80)
GET    /v1/spaces                                   -> 200
GET    /v1/spaces/:id                                -> 200
POST   /v1/spaces/:id/end                            -> 200
POST   /v1/spaces/:id/hand | DELETE                  -> raise / lower hand
POST   /v1/spaces/:id/speakers/:userId | DELETE      -> promote / demote (host only)
POST   /v1/video-calls         { "userIds": ["<uuid>"] }  -> 200 { "callId": "..." }
GET    /v1/video-calls                               -> 200
POST   /v1/video-calls/:id/end                       -> 204
POST   /v1/rtc/token                                 -> 200
```

`POST /v1/video-calls` answers **200**, not 201, and returns only
`callId`. It deliberately does not return tokens for other participants:
each participant mints their own.

```json
// POST /v1/rtc/token
{ "kind": "video", "id": "<callId>", "canPublish": true, "canSubscribe": true }
```

The room is `id` (the contract field). `roomId` is still accepted as a
deprecated alias. `expiresAt` comes back as an ISO date-time string.

`kind` is one of `proximity`, `space`, `call`, `venue`, `video`,
`paid_call` - a superset of the contract's `[venue, space, call]`,
because the call flow uses `video` and `paid_call`. For `call`, `video`
and `paid_call` the server checks the caller is an active speaker in that
room and answers `403 not_participant` otherwise.

> **Staging note:** `LIVEKIT_*` on Railway are placeholders, so tokens are
> minted locally but no real LiveKit will accept them. These endpoints
> still return 2xx, so they will not surface the misconfiguration.

---

## Admin

Requires the caller's wallet in `config.auth.adminWallets`; everyone else
gets `403`.

```
POST   /v1/admin/meta
POST   /v1/admin/users/:id/sybil_jail
DELETE /v1/admin/users/:id/sybil_jail
POST   /v1/admin/ads/bookings/:id/approve
POST   /v1/admin/ads/bookings/:id/reject
```

There is no `/v1/admin/ratio-arena/stats` or `/v1/admin/airdrop/trigger`.

---

## Full route index

- **admin** - `POST /v1/admin/ads/bookings/:id/approve`, `POST /v1/admin/ads/bookings/:id/reject`, `POST /v1/admin/meta`, `POST DELETE /v1/admin/users/:id/sybil_jail`
- **ads** - `GET POST /v1/ads/bookings`, `GET /v1/ads/live`, `GET /v1/ads/slots`
- **airdrop** - `POST /v1/airdrop/claim`, `GET /v1/airdrop/claims`, `GET /v1/airdrop/farm`
- **alpha-calls** - `GET POST /v1/alpha-calls`
- **auth** - `GET /v1/auth/challenge`, `POST /v1/auth/dev`, `GET /v1/auth/jwks`, `POST /v1/auth/logout`, `POST /v1/auth/refresh`, `POST /v1/auth/verify`
- **beef** - `GET POST /v1/beef`, `POST /v1/beef/:id/accept`, `POST /v1/beef/:id/decline`, `POST /v1/beef/:id/settle`, `GET /v1/beef/elo`
- **blocks** - `POST DELETE /v1/blocks/:userId`
- **businesses** - `POST /v1/businesses`, `GET /v1/businesses/:id`, `POST /v1/businesses/:id/run`
- **cabal** - `GET POST /v1/cabal/invites`, `POST /v1/cabal/invites/:id/accept`
- **careers** - `GET /v1/careers`, `POST /v1/careers/:careerId/apply`
- **characters** - `POST /v1/characters`
- **config** - `GET /v1/config`
- **creator** - `POST PATCH /v1/creator`, `GET /v1/creator/:handle`
- **daily-clue** - `GET /v1/daily-clue`, `POST /v1/daily-clue/answer`
- **districts** - `GET /v1/districts`, `GET /v1/districts/:id`, `GET /v1/districts/:id/owner`
- **dms** - `GET /v1/dms`, `GET POST /v1/dms/:userId`
- **feed** - `GET /v1/feed`, `POST /v1/feed/posts`
- **follows** - `POST DELETE /v1/follows/:userId`
- **gigs** - `GET /v1/gigs`, `POST /v1/gigs/:gigId/run`
- **homes** - `GET POST /v1/homes`, `POST /v1/homes/:homeId/rent`, `GET /v1/homes/:id`, `POST /v1/homes/:id/marina/visit`, `POST /v1/homes/:ownerId/visit`
- **inventory** - `GET /v1/inventory`
- **leaderboards** - `GET /v1/leaderboards/:boardId`
- **leagues** - `GET /v1/leagues`, `GET /v1/leagues/:slug`
- **llm** - `POST /v1/llm/chat`, `GET /v1/llm/quota`
- **lottery** - `POST /v1/lottery/roll`
- **market** - `GET /v1/market/coins`, `GET /v1/market/coins/:coinId`, `POST /v1/market/launchpad`, `POST /v1/market/launchpad/:coinId/buy`, `GET /v1/market/positions`, `POST /v1/market/trades`
- **me** - `GET /v1/me`, `GET /v1/me/cabal`, `GET /v1/me/league`, `GET /v1/me/project-offers`, `POST /v1/me/smart-money`, `GET /v1/me/sybil-status`, `POST /v1/me/tribe`
- **meta** - `GET /v1/meta/current`
- **needs** - `POST /v1/needs/actions`
- **nft** - `GET /v1/nft/inventory`, `POST /v1/nft/mint`
- **ops** - `GET /docs`, `GET /healthz`, `GET /metrics`, `GET /readyz`
- **ore** - `GET /v1/ore/board`, `GET /v1/ore/me`, `POST /v1/ore/stake/submitted`, `POST /v1/ore/stake/tx`
- **paid-calls** - `POST /v1/paid-calls`, `GET /v1/paid-calls/:id`, `POST /v1/paid-calls/:id/accept`, `POST /v1/paid-calls/:id/decline`, `POST /v1/paid-calls/:id/end`, `POST /v1/paid-calls/:id/submitted`
- **payments** - `POST /v1/payments/intents`, `GET /v1/payments/intents/:id`, `POST /v1/payments/intents/:id/submitted`
- **perps** - `GET POST /v1/perps`, `POST /v1/perps/:perpId/close`
- **predictions** - `GET POST /v1/predictions`
- **projects** - `GET POST /v1/projects`, `GET /v1/projects/:id`, `POST /v1/projects/:id/hire`, `POST /v1/projects/:id/launch`
- **push** - `POST /v1/push/register`
- **rekt** - `GET /v1/rekt/tombstones`
- **reports** - `POST /v1/reports`
- **rtc** - `POST /v1/rtc/token`
- **season-pass** - `POST /v1/season-pass/buy`, `POST /v1/season-pass/claim`, `GET /v1/season-pass/me`
- **shifts** - `POST /v1/shifts`, `POST /v1/shifts/:shiftId/complete`
- **shop** - `GET /v1/shop`, `POST /v1/shop/purchase`
- **smart-money** - `GET /v1/smart-money`
- **spaces** - `GET POST /v1/spaces`, `GET /v1/spaces/:id`, `POST /v1/spaces/:id/end`, `POST DELETE /v1/spaces/:id/hand`, `GET /v1/spaces/:id/speakers`, `POST DELETE /v1/spaces/:id/speakers/:userId`
- **tips** - `GET POST /v1/tips`, `POST /v1/tips/onchain`
- **tribes** - `GET /v1/tribes`, `GET /v1/tribes/:id`, `GET /v1/tribes/:id/districts`
- **uploads** - `POST /v1/uploads`
- **users** - `GET /v1/users/:id`
- **vc-row** - `GET /v1/vc-row/deals`
- **venues** - `GET /v1/venues/:venueId/access`
- **video-calls** - `GET POST /v1/video-calls`, `POST /v1/video-calls/:id/end`
- **webhooks** - `POST /v1/webhooks/helius`, `POST /v1/webhooks/helius-program`
- **x** - `GET /v1/x/link`, `GET /v1/x/link/callback`, `GET /v1/x/link/start`

_133 distinct paths._

---

## Conventions

**Headers**

```
Authorization: Bearer <accessToken>     # every authenticated route
Idempotency-Key: <uuid>                 # every mutating route
Content-Type: application/json          # when sending a body
```

Replaying an `Idempotency-Key` returns the cached response; reusing one
while the first request is still running returns `409 IN_FLIGHT`.

**Error shape**

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message", "details": {} } }
```

| Code | Status |
| --- | --- |
| `VALIDATION_FAILED` | 400 |
| `UNAUTHORIZED`, `SIGNATURE_INVALID` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT`, `IN_FLIGHT` | 409 |
| `UPGRADE_REQUIRED` | 426 |
| `RATE_LIMITED` | 429 |

**Rate limits**

- Writes: 20 per second per user.
- Login: capped per IP per minute plus a global concurrency semaphore.
- `429` responses carry `Retry-After` in seconds.

---

## Quick start

1. `GET /v1/config`
2. `GET /v1/auth/challenge?wallet=...`
3. Build and ed25519-sign the SIWS message
4. `POST /v1/auth/verify` -> `accessToken`
5. `GET /v1/me` -> check `hasCharacter`
6. `POST /v1/lottery/roll`
7. `POST /v1/characters`
8. `POST /v1/shifts` with `careerId`
9. `POST /v1/needs/actions`
10. `POST /v1/shifts/:shiftId/complete` with `results`

## Things to verify

- Nonce is alphanumeric, single use, 5 minute expiry.
- A SIWS message that differs from the challenge in any field is rejected.
- Concurrent writes sharing an `Idempotency-Key` give `409 IN_FLIGHT`.
- `/v1/rtc/token` gives `403` to a non-participant and a token to a participant.
- A shift cannot be completed twice, and only assigned mini-games score.
- A blocked pair cannot DM in either direction.
- Admin routes reject non-admin callers with `403`.
- 25 rapid writes should start returning `429`.

---

**Related**: `contract/openapi.yaml` is the source of truth; `GET /docs` renders it.

---

## Realtime rooms

`joinOrCreate(<room>, {token, ...})`. The token is verified on join and the
player profile is read from the database, never from the join options.

| Room | Filter | Notes |
| --- | --- | --- |
| `city` | none | one per server; also the delivery point for targeted messages |
| `market` | none | `coins` syncs from the coins table every 2s |
| `venue` | `venueId` | players + NPCs; NPCs spawn on their own venue's spots |
| `home` | `homeId` | one per home, host and guests |
| `space` | per instance | audio Space state |
| `video_call` | per instance | call participants |

### Targeted messages

The api and realtime are separate processes, so handlers publish to a Redis
channel and the city room forwards to that user's sessions. A `userId` of
`*` is a city-wide broadcast. Nothing is queued: an offline player misses
the message and refetches on join.

Currently produced: `call_invite` when a video call starts, and `event`
(`evt_coin_launch`, `evt_mood_change`) from the launchpad and the market
mood.
