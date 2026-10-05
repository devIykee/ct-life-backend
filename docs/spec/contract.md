Contract: frontend ↔ backend
This tab is the only interface between the Unity client and the backend. If something is not written here, neither side builds it. Changes go through a pull request to contract/ that both of you approve.
1. Ground rules
Repo. Create a new repo, ct-life. Do not put it in the indie-apps monorepo: that repo's AGENTS.md bans features that move other people's money.
ct-life/
├── contract/            both own; every PR needs both approvals
│   ├── openapi.yaml     REST v1, every response has an example
│   ├── realtime/        Colyseus state schemas (*.ts) + message types
│   ├── ids/             ID registries (JSON)
│   ├── config/          game config (JSON) + JSON Schemas
│   └── idl/             Anchor IDLs (generated, committed)
├── client/              Unity 6.3 LTS project            FE
├── server/
│   ├── api/             Fastify 5 REST                   BE
│   ├── realtime/        Colyseus 0.18 rooms              BE
│   └── workers/         BullMQ 6 jobs: market, NPCs, Sunday Unlock   BE
├── programs/ct_escrow/  Anchor 1.2                       BE
└── tools/
    ├── mock/            REST + realtime mock (ships first)   BE
    └── bots/            headless clients for tests and load  BE
Codegen. It runs in CI, and the output is committed.
• C# realtime state: schema-codegen contract/realtime/*.ts --output client/Assets/Generated/Realtime --csharp --namespace CTLife.Realtime. This is @colyseus/schema 5.0.36 and needs TypeScript 5 or 6.
• C# REST models: openapi-generator 7.25.0, generator csharp, models only. Its unityWebRequest library is marked experimental, so FE writes the thin HTTP wrapper by hand.
• CI also checks that:
    ◦ Generated files are up to date.
    ◦ Config and ID files pass their JSON Schemas.
    ◦ Mock and staging responses match openapi.yaml.
Versioning
• Tags are contract-vX.Y.Z. v1.0.0 is signed before any code is written.
• A breaking change is a major bump. Both of you approve it, and the server keeps the previous major for 14 days.
• The client sends X-Client-Version and X-Contract-Version on every request.
Environments. A ScriptableObject EnvConfig in the client picks one.
Env
REST
Realtime
Solana cluster
Used for
mock
localhost:4010
localhost:2567
None. Wallet flows go to staging.
FE daily work in the editor
local
localhost:3000
localhost:2567
devnet
BE daily work (Docker Compose: api, realtime, Postgres, Redis)
staging
Railway
Railway
devnet for USDC, SOL and ct_escrow. Mainnet for ORE and Seeker Genesis Token reads.
Integration, CLOCK IN demo
prod
Railway
Railway
mainnet
Launch
• [Unverified] Whether SKR has a devnet mint. Until that's confirmed, SKR payments are prod-only.
• ORE payments and staking move real mainnet ORE even on staging. Keep amounts tiny.
Conventions
• JSON fields are camelCase.
• Cash is an int64 in cents, in fields ending Cents.
• Token amounts are strings in base units, always.
    ◦ Decimals: USDC 6, SOL 9 (lamports), ORE 11. SKR decimals come from economy.json.
    ◦ This rule covers amount, ratePerMinUsdc, priceUsdc, creatorAmount, refundAmount, motherlodeOre, cityStakedOre, deployedLamports, balance, staked and stOre.
    ◦ mint is null for SOL.
• priceUsd is a display-only decimal string, for example "135.20". Never compute with it.
• Fictional coins:
    ◦ units is an int64 of coin base units; every coin has 6 decimals.
    ◦ priceMicros is millionths of a Cash dollar per whole coin.
• Times:
    ◦ REST uses ISO-8601 UTC strings. Realtime uses epoch milliseconds.
    ◦ Clients correct their clock with serverNow from the realtime welcome message.
• The week runs Mon 00:00 to Sun 23:59:59 UTC.
    ◦ Sunday Unlock and the Weekly Meta rotation run at Sun 20:00 UTC.
    ◦ Tax and weekly boards reset at Mon 00:00 UTC.
• IDs:
    ◦ The server generates every entity ID as a UUIDv7: users, trades, perps, calls, spaces, intents, messages.
    ◦ The client generates only the Idempotency-Key.
• Idempotency. Every POST, PUT, PATCH and DELETE sends an Idempotency-Key header (UUIDv4). The server dedupes for 24 h and replays the first response.
• Errors:
    ◦ REST: {"error": {"code": "INSUFFICIENT_CASH", "message": "…", "details": {}}} with a matching HTTP status.
    ◦ Realtime rejections arrive as rejected {type, code}.
    ◦ Codes come from ids/errors.json (section 2).
• Rate limits:
    ◦ REST: 20 requests a second per user.
    ◦ Realtime: say once per 2 s, emote once per second, move 10 times a second.
2. ID registries
Every thing both sides mention has a string ID in contract/ids/*.json. The backend sends IDs, and the client maps them to assets.
• IDs are snake_case.
• They are never renamed and never reused.
Registry
Owner
Contents and examples
venues.json
BE (FE adds scene_key)
timeline_square, spaces_studio, terminal_cafe, perp_pit, rekt_clinic, ore_refinery
spots.json
FE
Per venue: named spots, plus walkable rectangles [{x0, z0, x1, z1}] in metres. Examples: timeline_square.center, timeline_square.crier_1…_3, terminal_cafe.terminal_1…_8, spaces_studio.stage_host, spaces_studio.stage_1…_10, rekt_clinic.bed_1…_6, ore_refinery.terminal_1…_4, launchpad_tower.launch_desk
archetypes.json
BE
Phase 1: town_crier, giveaway_guy, reply_guy, perp_degen_npc, rekt_guy, wallet_tracker, doomposter, spaces_host, ore_miner. The other 20 arrive in later phases.
npc_states.json
BE
idle, wander, goto, act, talk, react, follow, leave
anims.json
FE
loco_idle, loco_walk, loco_run, act_sit, act_type, act_frantic_type, emote_wave, emote_facepalm, react_liquidated, react_moon_jump
sfx.json
FE
sfx_buy, sfx_sell, sfx_liquidation, sfx_rug, sfx_call_ring
items.json
BE (FE adds prefab_key)
Slots: skin, head, hair, top, bottom, shoes, acc. Examples: top_hoodie_black, acc_hard_hat.
tribes.json · traits.json · dreams.json
BE
trencher, perp_degen, prediction_shark, airdrop_farmer, caller, builder, anon · traits · dreams
homes.json
BE
parents_basement, hacker_house, studio, penthouse, marina_villa
mini_games.json
FE builds, BE validates
{id, careerId, maxScore, durationSec}
boards.json
BE
net_worth, weekly_pnl, weekly_return, clout, trust_score
events.json
BE
evt_liquidation, evt_rug, evt_coin_launch, evt_mood_change, evt_exploit, evt_ore_motherlode
toasts.json
BE (FE writes the words)
toast_drained, toast_payment_confirmed, toast_promoted
report_reasons.json · kick_reasons.json
BE
spam, scam, harassment, impersonation, nsfw · banned, duplicate_login, client_outdated
ad_slots.json
BE
billboard_01…, pixel_tile_001…, phone_app_01…, plus terms term_7d, term_30d, term_event
errors.json
BE
See below
Error codes (v1):
• Auth and accounts: NONCE_INVALID, SIGNATURE_INVALID, TOKEN_EXPIRED, SGT_ALREADY_LINKED, ALIAS_TAKEN, ALREADY_ROLLED, CLIENT_OUTDATED.
• Requests: VALIDATION_FAILED, NOT_FOUND, FORBIDDEN, BLOCKED, RATE_LIMITED.
• Economy and trading: INSUFFICIENT_CASH, LEVERAGE_NOT_ALLOWED, SLIPPAGE_EXCEEDED, SHIFT_NOT_FINISHED.
• Places and Spaces: VENUE_FULL, SPOT_TAKEN, NOT_SPACE_HOST.
• Payments: TOPUP_CAP_REACHED, PAYMENT_EXPIRED, PAYMENT_UNDERPAID.
Rules
• If the client gets an unknown ID, it shows a fallback (grey capsule, default sound), logs it, and never crashes.
• A new ID is added to its registry by pull request first, then used.
• FE owns anims, sfx and spots. BE may only reference IDs that already exist in those files.
3. Auth
Sign In With Solana through Mobile Wallet Adapter 2.0 is the only sign-in in v1. There is no email login and no X login.
1. The client calls GET /v1/auth/challenge. It returns {nonce, domain, statement, uri, version: "1", chainId, issuedAt, expirationTime}.
    ◦ chainId is solana:devnet or solana:mainnet.
    ◦ expirationTime is issuedAt plus 5 minutes.
2. The client calls MWA authorize with a sign_in_payload built from those fields. In Unity this is Web3.Instance.LoginWalletAdapter(SignInPayload) on Solana.Unity-SDK main at 1.3.0 (PR #289).
3. The wallet returns sign_in_result {address, signed_message, signature, signature_type: "ed25519"} (MWA spec). The client keeps the MWA auth_token for later payment signing.
4. The client calls POST /v1/auth/verify {address, signedMessage, signature, nonce}. Both byte fields are base64.
5. The server checks three things:
    ◦ The nonce is unused and unexpired.
    ◦ The signed message matches the challenge field for field.
    ◦ The Ed25519 signature is valid for the address.
6. The server checks for a Seeker Genesis Token on mainnet (recipe):
    ◦ Call Helius getTokenAccountsByOwnerV2.
    ◦ Match the group GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te.
    ◦ Store the token's mint so one phone can't verify two accounts.
7. The server returns {accessToken, refreshToken, user: {id, wallet, isSeeker, hasCharacter}}.
    ◦ The access token is a JWT that lasts 15 min, signed RS256. Its claims are sub (user UUID), wal (wallet), skr (isSeeker), iat and exp. The public key is served at /v1/auth/jwks.
    ◦ The refresh token lasts 30 days.
8. REST calls send Authorization: Bearer <accessToken>. Realtime joins pass {token} as join options.
9. POST /v1/auth/refresh {refreshToken} returns a new pair and revokes the old refresh token.
10. POST /v1/auth/logout revokes the refresh token. The client then calls MWA deauthorize.
Dev bypass. The Unity editor cannot run MWA.
• In the mock and local environments only, POST /v1/auth/dev {wallet} returns tokens without a signature.
• It is compiled out of staging and production builds.
4. REST API v1
Base path is /v1. The Ph column is the build phase that needs the endpoint (see Phases in the Build Spec). Auth endpoints are in section 3. Units follow the Conventions in section 1.
Player and life
Ph
Method and path
Body
Returns
1
GET /config
—
Config: all registries and game config (section 7)
1
GET /me
—
Me (shape below)
1
POST /characters
{alias, look {skinTone, headId, hairId, topId, bottomId, shoesId, accId}, traitIds[2], dreamId, tribeId, ageConfirmed: true}
Character. Errors: ALIAS_TAKEN, VALIDATION_FAILED if ageConfirmed isn't true.
1
POST /lottery/roll
—
{outcome: insider | exit_liquidity | seeker, cashCents, debtCents, homeId}. Error: ALREADY_ROLLED (409).
1
POST /needs/actions
{actionId}
{needs, cashCents}
4
PATCH /characters/me/look
Same look object
Character
4
GET /homes · POST /homes/{homeId}/rent
—
Home[] · {homeId, rentCents, nextDueAt}
4
POST /homes/{ownerId}/visit
—
{roomId} to join with joinById
6
PATCH /characters/me/tribe
{tribeId}
Character. Allowed once per season.
POST /needs/actions actions. Each one raises one need:
actionId
Raises
Where
eat
Hunger
Anywhere
sleep
Energy
Anywhere
shower
Hygiene
Anywhere
touch_grass
Sanity
Anywhere
party
Fun
Club venues only
Home. Until Phase 4, the player's own home is a local scene picked by Me.homeId. The home room arrives with home visits in Phase 4.
Me shape
• user {id, wallet, isSeeker, skrName}. skrName is null if the player has no .skr name.
• character {alias, look, tribeId, traitIds, dreamId}.
• needs {energy, hunger, fun, hygiene, sanity}: ints from 0 to 100.
• skills {clout, coding, trading, writing, design, security}: ints from 1 to 10.
• cashCents, debtCents, homeId.
• minerTier: none, prospector, miner or refiner.
• flags {}.
Work
Ph
Method and path
Body
Returns
1
GET /careers
—
Career[] with my level and XP
1
POST /careers/{careerId}/apply
—
Job
1
POST /shifts
{careerId}
Shift {shiftId, miniGameIds[], endsAt}
1
POST /shifts/{shiftId}/complete
{results: [{miniGameId, score}]}
{payCents, xp, promoted}. Scores are capped at maxScore from mini_games.json. Error: SHIFT_NOT_FINISHED.
4
GET /gigs · POST /gigs/{gigId}/run
—
Gig[] · {payCents, outcomeId}
4
GET /daily-clue · POST /daily-clue/answer
{answer}
{clueText, expiresAt} · {correct, prizeCents}
Markets (fictional, Cash only)
Ph
Method and path
Body
Returns
2
GET /market/coins?stage=new|final|graduated
—
Coin[]
2
GET /market/coins/{coinId}
—
{coin, candles1m[], topHolders[], riskHint}. riskHint depends on the Security skill.
2
POST /market/trades
{coinId, side: buy | sell, cashCents? | units?, maxSlippageBps}
Trade {tradeId, units, priceMicros, feeCents, cashCents}. Error: SLIPPAGE_EXCEEDED.
2
GET /market/positions
—
Position[] with unrealized PnL
2
POST /perps
{coinId, side: long | short, leverage, marginCents}
Perp {perpId, entryMicros, liqMicros}. Error: LEVERAGE_NOT_ALLOWED if over the cap set by Trading skill and tribe (skills.json).
2
GET /perps?status=open|closed
—
Perp[]
2
POST /perps/{perpId}/close
—
Perp with realizedCents
2
GET /predictions?status=open · POST /predictions/{id}/bets
{outcomeId, stakeCents}
PredictionMarket[] · Bet
2
POST /alpha-calls
{coinId, entryMicros, targetMicros, stopMicros}
AlphaCall. Calls are immutable; there is no delete endpoint.
2
GET /alpha-calls?userId=
—
{calls[], trustScore {hitRate, avgReturnBps, maxDrawdownBps, heldBagPct}}
2
GET /smart-money
—
Recent trades of opted-in top traders
Social, boards and Rekt
Ph
Method and path
Body
Returns
1
GET /users/{id}
—
PublicProfile {id, alias, skrName, isSeeker, tribeId, minerTier, look, netWorthCents}
1
POST /blocks/{userId} · DELETE /blocks/{userId}
—
204. The server stops sending the blocked user's said messages and DMs.
1
POST /reports
{targetType: user | message | space | call | post | ad, targetId, reasonId, note?}
204. Chat targetId = messageId from said.
1
GET /leaderboards/{boardId}?scope=global&cursor=
—
{entries: [{rank, userId, alias, value}], me}
2
GET /rekt/tombstones?limit=50
—
[{userId, alias, lossCents, coinId, at}], newest first
3
GET /feed?scope=global|following · POST /feed/posts
{text ≤ 280}
FeedPost[] · FeedPost. This is the in-game Timeline, never X.
3
POST /follows/{userId} · DELETE /follows/{userId}
—
204
3
GET /dms · GET /dms/{userId}?before= · POST /dms/{userId}
{text ≤ 500}
Threads · messages · Message. Delivery is pushed on the city room.
3
POST /tips
{toUserId, cashCents}
{cashCents}. Daily cap comes from config.
3
POST /tips/onchain
{toUserId, signature}
204. Record only.
6
scope=friends|league on leaderboards
—
Same shape
Boards
• value is in cents for money boards. It is an int for clout and basis points for weekly_return and trust_score.
• Net Worth = cashCents + open positions at the last price + perp margin + unrealized perp PnL − debtCents.
Voice, video and paid calls
Ph
Method and path
Body
Returns
3
POST /rtc/token
{kind: venue | space | call, id}
{url, token, expiresAt, canPublish}
3
POST /spaces · GET /spaces?live=true
{title}
Space · Space[]
3
GET /spaces/{id}
—
Space {spaceId, title, hostId, speakerIds[], handIds[], listenerCount}
3
POST /spaces/{id}/hand · DELETE /spaces/{id}/hand
—
204. Raise or lower my hand.
3
POST /spaces/{id}/speakers · DELETE /spaces/{id}/speakers/{userId}
{userId}
204. Host only, else NOT_SPACE_HOST.
3
POST /spaces/{id}/end
—
204
3
POST /video-calls
{userIds[] ≤ 7}
{callId}. Invites go out on the city room.
3
PUT /creator
{enabled, ratePerMinUsdc, maxMinutes}
CreatorProfile
3
POST /paid-calls
{creatorId, minutes}
{callId, sessionPda, tx} (section 6)
3
POST /paid-calls/{id}/submitted
{signature}
PaidCall
3
POST /paid-calls/{id}/accept · /decline · /end
—
PaidCall
3
GET /paid-calls/{id}
—
PaidCall {callId, status: awaiting_payment | ringing | live | settled | refunded, minutesUsed, creatorAmount, refundAmount}
RTC tokens
• id is the venue instanceId, the spaceId or the callId.
• The LiveKit room name is {kind}:{id}. The LiveKit identity is the userId.
Promoting a speaker
• The backend uses its own server API key to call LiveKit UpdateParticipant, setting that user's permission to canPublish: true (LiveKit).
• Every hand or speaker change pushes space_update {spaceId} on the city room to everyone in the Space. Clients then refetch GET /spaces/{id}.
Payments, shop and ads
Ph
Method and path
Body
Returns
2
POST /payments/intents
{kind: topup | cosmetic | ad | season_pass, sku, currency: USDC | SOL | SKR | ORE}
PaymentIntent (shape below). Error: TOPUP_CAP_REACHED.
2
GET /payments/intents/{id}
—
{status: pending | confirmed | expired | failed, signature}
4
GET /shop · POST /shop/purchase
{itemId} (Cash items only)
ShopItem[] · Inventory
4
GET /inventory
—
Inventory
5
GET /ads/live
—
Active creatives by slot. Cache for 5 min. Until then, billboards show house art.
5
GET /ads/slots
—
AdSlot[] {slotId, kind, terms: [{termId, priceUsdc}], nextFreeAt}
5
POST /uploads
Multipart image, PNG or JPG ≤ 1 MB
{uploadId, url}
5
POST /ads/bookings
{slotId, termId, uploadId, link}
{bookingId, intent: PaymentIntent}. Live after manual approval.
PaymentIntent shape: {intentId, currency, recipient, mint, amount, cashCents, bonusBps, reference, memo, tx, solanaPayUrl, expiresAt}.
• cashCents and bonusBps are set for top-ups only. The client shows them; it never computes them.
• mint is null for SOL.
• In-app, sign tx with MWA sign_and_send_transactions. solanaPayUrl is the QR fallback.
• After sending, poll GET /payments/intents/{id} every 1 s for up to 30 s.
• If the intent is still pending, show "Payment pending". The city room's payment_confirmed message closes it later.
ORE (mainnet only)
Ph
Method and path
Body
Returns
2
GET /ore/board
—
{roundId, endsAt, endsAtSlot, squares[25] {deployedLamports}, motherlodeOre, cityStakedOre, priceUsd}. BE caches it every 2 s from ORE's on-chain accounts.
2
GET /ore/me
—
{balance, staked, stOre, minerTier}
2
POST /ore/stake/tx
{action: deposit | withdraw | claim | compound, amount?}
{tx}: an unsigned v0 transaction for MWA
Live-ops
Ph
Method and path
Returns
1
GET /events/active
ServerEvent[]
4
GET /meta/current
WeeklyMeta
4
POST /push/register {token}
204
[Unverified] Whether Seeker ships Google Play services, which push needs. Until it's confirmed, the phone's in-app inbox is the only notification surface.
Admin (backend only)
• Admin endpoints live under /v1/admin/*: moderation queue, ad approval, bans.
• Two are test tools, enabled on staging only:
    ◦ POST /admin/market/force-price {coinId, priceMicros}.
    ◦ POST /admin/users/{id}/skills {trading, security, …}.
• The client never calls admin endpoints.
5. Realtime (Colyseus 0.18)
The server is Colyseus 0.18.9 on Node 22 or later. The client is the Colyseus Unity SDK 0.18.8. State types are generated into C# (section 1), so a schema change breaks the client build instead of failing silently at runtime.
Rooms
Ph
Room
One per
Max clients
Patch rate
Holds
1
city
Whole game, sharded at 1,000
1,000
1 Hz
Online count, Market Mood, active events. Carries user-targeted messages.
1
venue
Venue instance (filterBy venueId)
50
10 Hz
Players and NPCs in that venue
2
market
Whole game
2,000
0.5 Hz (one 2 s tick)
Live coins, about 40 at most
4
home
Player home, created on visit
12
10 Hz
Same schema as venue
Joining
• Every client joins city and market after sign-in, and joins one venue at a time.
• joinOrCreate("venue", {token, venueId}). A full instance makes the server open a new one.
• On every join, the room sends welcome {serverNow, instanceId}. Clients keep the clock offset and use it for emoteAt and startedAt.
• Reconnection: the server allows 20 s using the SDK's reconnection token.
State
venue: venueId, instanceId, players (map of PlayerState by sessionId), npcs (map of NpcState by npcId).
PlayerState
Field
Type
Notes
userId, name, skrName, tribeId
string
name is the alias. skrName is empty if the player has none.
isSeeker
boolean
Seeker badge
minerTier
string
none, prospector, miner or refiner. Drives the ORE badge and hard hat.
look
string[7]
Fixed order: [skinTone, headId, hairId, topId, bottomId, shoesId, accId]
x, z, rotY
float32
Metres and radians, venue-local
anim
string
Set by the server: loco_idle, loco_walk or loco_run from speed, act_sit or act_type from the spot. The client never sends it.
emoteId, emoteAt
string, number
Epoch ms in server time; clients start the emote at that moment
spotId
string
Set while seated or at a terminal
talking
boolean
Speaking indicator
NpcState
Field
Type
Notes
archetypeId
string
From archetypes.json
state
string
From npc_states.json
spotId
string
Target spot for goto, wander and act
animId
string
Clip for act and react
targetUserId
string
For follow
lineId, lineParams
string, map of string
Example: npc_lines key crier_coin_moon with {coin: "FROGE", x: "3.2"}
emoteId
string

startedAt
number
Epoch ms, server time
An NPC moving to another venue ("go to the Rekt Clinic") is leave here, then a fresh spawn in that venue.
market: coins, a map of CoinState:
• coinId, ticker, name.
• stage: new, final, graduated or dead.
• priceMicros and mcapCents (int64), vol5mCents, change5mBps, holders, launchedAt.
• Each coin also has a hidden arc (stealth, hype, peak, outcome). It lives only on the server and is never sent. NPC normie waves fire on the hidden peak.
city: online (int), mood (int, basis points of the SOL 24h change), eventIds[], metaId.
Messages from client to server
Room
Type
Payload
Limit and validation
venue
move
{x, z, rotY}
Max 10 a second. The server rejects speeds above 6 m/s and points outside the walkable rectangles in spots.json.
venue
sit / stand
{spotId} / {}
The spot must exist and be free, else SPOT_TAKEN
venue
emote
{emoteId}
Once a second; the ID must be in anims.json
venue
say
{text}
140 chars max, once per 2 s. The server strips links and phone numbers and runs a profanity filter.
venue
talking
{on}
Mirrors the LiveKit speaking state
venue
npc_tap
{npcId}
Phase 1 use: tapping Giveaway Guy's "drop wallet" costs $50 Cash and sends toast_drained
Messages from server to client
Room
Type
To
Payload
any
welcome
Joiner
{serverNow, instanceId}
venue
said
Everyone in the venue except players who blocked the sender
{messageId, userId, sessionId, text, at}
venue
toast
One player
{textId, params}
venue
rejected
One player
{type, code}. type is the message type that was refused.
city
event
Everyone
{eventId, params, at}: liquidations, rugs, launches, exploits, mood changes, ORE motherlode
city
liquidated
That player
{perpId, coinId, lossCents, at}. The client shows the REKT card.
city
payment_confirmed
That player
{intentId, cashCents}
city
space_update
Everyone in that Space
{spaceId}
city
dm
That player
{messageId, fromUserId, text, at}
city
call_invite
That player
{callId, fromUserId, paid}
city
kicked
That player
{reasonId}
market
tape
Everyone
{coinId, side, cashCents, name}: only trades of $1,000 Cash or more
[Inference] At 10 Hz with quantized positions, a full venue costs about 3–5 KB/s per client. Colyseus measured 9.4 KB/s for 60 moving entities at its default 20 Hz (docs).
6. On-chain
Only money touches the chain; gameplay never does. USDC, SOL and ct_escrow use devnet on staging and mainnet in prod. ORE and Seeker Genesis Token reads are always on mainnet (section 1).
Flow
On-chain action
Verified by
Cash top-up
USDC, SKR or SOL transfer to the treasury with a reference key and memo = intentId
Helius webhook on the treasury, then a server getTransaction check
Cosmetic, ad booking, season pass
Same as a top-up
Same
Tip
Wallet-to-wallet transfer; the server is not involved
The client may report the signature to POST /v1/tips/onchain
Paid call
ct_escrow program
Program events via Helius webhook
Payment intent check (server). Credit the ledger only when all of these hold:
• The transaction succeeded at confirmed. Reconcile again at finalized.
• It transfers the expected mint to the treasury account, for at least the intent amount.
• The memo equals the intentId, and the reference key is present.
• The intent has not expired.
• The signature was never credited before. Crediting is idempotent on the signature.
Mints
• USDC mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
• SKR: SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3 (SKR docs).
• USDC devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (Circle).
ORE. This runs on mainnet even in the demo. [Unverified] ORE has no devnet deployment.
• ORE mint: oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp, 11 decimals.
• stORE mint: storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR.
• ORE program: oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv. Read-only for us; we never call deploy.
• Stake program: stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH, with deposit, withdraw, claim and compound. The stake PDA seeds are ["stake", user].
• There is no official TypeScript SDK. BE ports these builders from the Rust crate ore-stake-api 0.3.0 (ore-stake).
• ORE payments use TransferChecked with 11 decimals. They go through the same intent checks as USDC.
ct_escrow program
Built on Anchor 1.2.0 with Solana CLI 4.1.2 (release notes). It is adapted from the Anchor escrow example. The program has no admin withdraw.
Accounts
• Config PDA, seeds ["config"]:
    ◦ admin, settle_authority (the backend's key), treasury (USDC account), usdc_mint.
    ◦ fee_bps: u16 (1000) and accept_window_secs: u32 (120).
• Session PDA, seeds ["session", fan, creator, session_id_le_bytes]:
    ◦ Parties: fan, creator.
    ◦ Terms: session_id: u64, rate_per_min: u64 (USDC base units), max_minutes: u16, deposit: u64, fee_bps: u16 (copied from Config at open).
    ◦ Times: opened_at: i64, accepted_at: i64 (0 until accepted).
    ◦ status: u8: 0 Open, 1 Accepted, 2 Settled, 3 Refunded.
    ◦ bump.
• Vault: the Session PDA's USDC associated token account.
Instructions
Instruction
Signer
Effect
init_config(fee_bps, accept_window_secs)
admin
Runs once
open_session(session_id, rate_per_min, max_minutes)
fan
Creates the Session and vault. Moves rate × max_minutes × (1 + fee_bps/10000) from the fan to the vault.
accept()
settle_authority
Sets accepted_at. Called after the creator taps Accept.
settle(seconds_used)
settle_authority
Minutes = ceil(seconds / 60), capped at max. Pays the creator rate × minutes and the treasury that × fee_bps / 10000, refunds the remainder to the fan, then closes the vault and Session with rent going to the fan.
refund()
fan or settle_authority
Returns everything to the fan, if the session is Open and the accept window has passed (the backend calls this when a creator doesn't answer), or Accepted and more than max_minutes × 60 + 600 s have passed since opened_at.
Events: SessionOpened, SessionAccepted, SessionSettled {minutes, creator_amount, fee, refund}, SessionRefunded.
Errors: InvalidRate (rate is 0 or above 50 USDC a minute), TooEarlyForRefund, AlreadyClosed, Unauthorized, MathOverflow.
Transaction building
1. POST /v1/paid-calls returns {callId, sessionPda, tx}, where tx is an unsigned base64 v0 transaction.
2. The client passes it to MWA sign_and_send_transactions.
3. The client reports the result to POST /v1/paid-calls/{id}/submitted {signature}.
7. Game config
The backend serves every tunable number from GET /v1/config, so live-ops changes ship without an app release. The client caches the config by ETag. The client never hardcodes a number that exists in config.
The files live in contract/config/ as JSON. Each has a JSON Schema that CI validates.
File
Holds
economy.json
Rent table, tax brackets, top-up packs, the per-currency bonus in bps (ORE 1500, SKR 1000), the daily top-up cap, fees, and currency decimals including SKR
needs.json
Decay per real hour for each need, the effect of each actionId, and the party venues
skills.json
The six skills, the XP curve, and the leverage cap by Trading level (1x at levels 1–4, 2x at 5, rising to 10x at 10), plus each tribe's bonus (Perp Degen +5x)
lottery.json
Birth outcomes: Insider, Exit Liquidity, Seeker
careers.json
14 careers × 5 levels: pay, shift length, miniGameIds, skill gates
gigs.json
Side gigs and their pay formulas
businesses.json
Businesses, income ranges, bad-day tables
market.json
Launch interval, hidden-arc outcome mix, fees, tick length
events.json
Server-wide events, their effects and durations
meta.json
The Weekly Meta rotation
npc_lines.json
Lines per archetype, with {slots} filled from lineParams
leagues.json
League tiers and promotion rules
ads.json
Ad slot kinds, terms and USDC prices
ore.json
Miner tier thresholds: Prospector holds any ORE, Miner stakes 1+ ORE, Refiner stakes 10+ ORE
The config payload carries version (semver) and minClientVersion. A client older than minClientVersion shows "Update required" and stops (CLIENT_OUTDATED).
8. Mocks, bots and integration
Neither of you waits for the other. FE builds against a mock that behaves like the real server. BE tests with headless bots that behave like real clients.
First: both of you sign contract v1.0.0 and tag it contract-v1.0.0.
Next: BE ships tools/mock. docker compose up mock starts:
• A REST mock on :4010.
    ◦ Prism 5.16.0 serves the examples in openapi.yaml. That is why every response needs an example.
    ◦ POST /v1/auth/dev works.
• A realtime mock on :2567. These are real Colyseus rooms using the real schemas, and they accept any JWT:
    ◦ venue holds 20 fake players walking between spots, emoting and chatting.
    ◦ The 9 Phase 1 NPCs change state every 5 s.
    ◦ market ticks every 2 s.
    ◦ city emits an event every 10 s, and a liquidated message every 60 s to the first player.
• A LiveKit dev server (livekit-server --dev), so voice works offline.
Wallet flows always go to staging. A phone can't reach localhost, and the REST mock can't sign. Those flows are sign-in, payments, ORE staking and paid calls.
FE daily loop
• Set EnvConfig to mock.
• Every screen must work against the mock before it is called done.
• Wallet flows run on a Seeker against staging.
BE daily loop
• tools/bots uses @colyseus/sdk 0.18.5 and @colyseus/testing 0.18.6.
• Bots sign in with dev auth, join venues, walk, chat, trade and open perps.
• A load test runs 200 bots across 4 venue instances.
Integration checklist (run at the end of every phase; target: under 1 hour)
Run it on staging with two Seekers, A and B. Skip the steps for phases not built yet.
[ ] Switch EnvConfig to staging and build the APK (10 min)
[ ] Sign In With Solana on A; the profile shows the Seeker badge (5 min)
[ ] Create a character with ageConfirmed and roll the birth lottery (3 min)
[ ] Both phones join Timeline Square. Each sees the other move, emote and chat, and B blocks then unblocks A. (7 min)
[ ] Work one shift; Cash rises by the config amount (3 min)
[ ] Buy and sell a coin in the Terminal Café; the position and ledger match (5 min)
[ ] Set A's Trading to 10 with the admin tool. Open a 10x perp and force a liquidation with the admin price tool. The REKT card shows on A, and the tombstone appears in the Rekt Clinic. (5 min)
[ ] Proximity voice between the phones; the speaking indicator lights (4 min)
[ ] A hosts a Space. B raises a hand, A sees it in the queue and promotes B, and B is heard. (5 min)
[ ] Top up 1 devnet USDC. Cash is credited within 10 s, matching cashCents (4 min)
[ ] Open the ORE Refinery. The board timer ticks. A stakes a tiny amount of mainnet ORE, and B sees A's hard hat. (5 min)
From Phase 3, add: a one-minute paid call from A to B, with settlement shown on Solana Explorer.
Any step that fails is a contract bug. Fix the contract first, then the code.
