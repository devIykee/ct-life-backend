 

CT Life — Build Spec
Oct 4, 2026
 · 
@Someone


A 3D mobile life-sim of Crypto Twitter on Solana, built for the Solana Mobile hackathon by two people working in parallel against one contract.

Verdict and blockers
Build it. As of 4 Oct 2026, nobody has shipped a Crypto Twitter version of Lagos Life. The genre is proven this week: Lagos Life showed 901,562 players and 119,904 online on 4 Oct (public stats). Solana Mobile's judges score "stickiness", meaning daily habits on Seeker, at 25% of the total.

These nine things bend the plan. Each one is already handled in the sections below.

CLOCK IN closes on 8 Oct 2026 at 23:59, in 4 days (rules, blog).

The app must be a native Android APK that uses Mobile Wallet Adapter. The rules say "Direct ports or PWA wrappers will score poorly."

USDC prizes go only to teams with no VC or angel funding. Entrants must be 18+ and pass KYC.

Winners must be on the dApp Store within 30 days of the results.

Plan: every phase ends in a submittable APK. On 8 Oct we submit the latest finished phase and keep building (see Phases).

Life-sims have never won a Colosseum prize.

Of 40 life-sim and metaverse projects in Colosseum's project API, none won.

The winners nearby are social and competitive: Pumpville (grand prize at MONOLITH, a social multiplayer game on Seeker), The Arena, Trenches.top and Memeshot.

Plan: lead the demo with the CT layer (trading, liquidations, voice rooms, rich list), not with chores.

Real money never meets chance.

Cash can never be withdrawn. Coins are fictional. Cosmetic NFTs are never prizes.

Google Play bans wagering "to obtain a prize of real world monetary value" (policy).

The dApp Store has no gambling clause but bans anything illegal under applicable law (publisher policy).

X bans rewards for X actions, virtual ones included. The policy says "you may not sell or receive monetary or virtual compensation for any X actions" (X developer policy).

So there are no X-based quests.

There is no Sign in with X in v1, because X requires it to be "at least as prominent" as every other sign-in.

Asset licences:

Synty's EULA bans "use in Blockchain based projects" (EULA).

Unity Asset Store assets cannot be used "in any digital representation of value".

ActorCore motions cannot be sold as in-app purchases.

Ready Player Me shut down on 31 Jan 2026.

Plan: use our own art plus CC0 kits from Kenney and Quaternius.

The Unity Solana SDK is community-run, and its tagged release breaks Android IL2CPP builds (#257).

Plan: pin main at 1.3.0.

Fallback: our own plugin over the official Kotlin MWA library.

The day-1 spike decides which.

This game cannot live in the indie-apps repo. Its AGENTS.md bans features that move other people's money, and paid calls and tips do exactly that. Plan: create a new repo, ct-life.

The biggest competitor is Lagos Life itself.

It plans AbujaLife, PHLife and an airport linking cities (isakaba).

It already sells billboards to crypto firms, and its creator took a paid ad for the $LAGOSLIFE coin.

[Inference] A "crypto city" would be cheap for them to add.

Our moat: CT-native depth, plus wallet, payments, voice and video built for Seeker.

Lagos Life's worst week came from an exploit.

An exploit minted trillion-naira balances. Wiping them drew a backlash: "All hacked money will be removed" had 985K views (X trending).

Plan: a server-authoritative, append-only ledger from day 1.

What Lagos Life and PH Lifestyle actually do
Both are already 3D three.js games in the browser, and both make real money from Nigerian brands and top-ups. Observed on your signed-in accounts on 4 Oct 2026.



Lagos Life

PH Lifestyle

Stack

Next.js + three.js r186 (WebGL2), glTF models, REST save API

Plain JS modules + three.js r180, one WebSocket server on Railway

Scale shown in-game

117k online, rich list of 532,578 players

150 online

World

Overview map of Lagos with 27 venues; each venue is a small diorama room with tap-to-go sub-spots

Same diorama pattern; named NPCs (Aunty Boma, DJ Boma) marked "NPC"

Multiplayer

Mostly async; saves via /api/save

Real-time: "everyone you see is a real person"

Voice / video

None seen

Proximity mic + camera, browser peer-to-peer WebRTC, max 6 peers, public STUN only

Phone menu

26 apps: Jobs, Bank, Invest, Forbes rich list, LagosBet, Gov, Police, Family, My Ads

Phone with chat, contacts, bank, gist, photos

Real-money in

Top-up ₦1,000 ($1) → ₦50k up to ₦20,000 ($14) → ₦1.6m; no withdrawal

Top-up via Paystack

Ads

Billboards ₦5,000 per 7 days, 38+ booked into Nov–Dec; "Sea Plot" ad tiles ₦500 per 7 days; sponsored phone apps (Chowdeck, PopOut, Salary Index); stats-page ads ₦100,000 per 7 days with all 10 slots sold; song placements ₦50,000; a 5% fee on player transfers

None seen

Gambling

LagosBet: shared fake football odds, High-Low, Roulette, "18+, money can't be withdrawn, the house always has an edge"

Not checked

What we take:

Diorama venues plus one overview map, not an open-world city. It is cheaper to render on a phone and faster to build.

The phone is the main menu. Every feature is an app on it.

Brands pay for billboards and phone apps. This is the business model for CT projects (see Projects).

Proximity voice and video, but through a media server, not peer-to-peer. A 6-peer mesh with no TURN server breaks on many mobile networks.

Server-authoritative economy with hard sinks. [Inference] Lagos Life's top 9 players are all tied at exactly ₦5.0bn, which reads as a cap that players hit quickly.

The product on one page
CT Life is a 3D multiplayer life-sim set in a parody Crypto Twitter city, built native for the Solana Seeker phone. Players get a job, trade fictional memecoins, host voice rooms, get rugged, climb the rich list and meet real people on calls.

This spec keeps the PRD v2.2 economy and competitive layer. It replaces three of the PRD's choices: 2D becomes 3D, web-first becomes native Android, and "no wallet" becomes Solana-native.

Fixed decisions

Name: CT Life. The city is CT City. "Solana Street" is the main boulevard through the Timeline district.

Platform: native Android APK for Seeker, published on the Solana dApp Store. No iOS in v1.

Sign-in: Sign In With Solana through Mobile Wallet Adapter. There is no X login in v1. A verified X link comes in Phase 6 and only shows your handle and avatar.

Game money: Cash is off-chain, server-ledgered and can never be withdrawn. Every sim action uses Cash.

Real money: USDC, SOL, SKR or ORE is used only for Cash top-ups, cosmetics, tips, paid calls and ads. Paid calls take USDC only.

No token of our own at launch.

Seeker perks: holders of the Seeker Genesis Token get a verified badge and a third birth-lottery outcome, "Seeker Baby".

Core loop

Wake up at home. Five needs decay over time: Energy, Hunger, Fun, Hygiene and Sanity. Touching grass restores Sanity.

Work a shift. Each career has 30–60 second mini-games that pay Cash and skill XP.

Go to a venue. Meet players by proximity voice, trade at a terminal, bet in the Prediction Pit, or host or join a Space.

Something happens: a rug, a liquidation, a moon, a beef or a raid. Each one produces a share card.

Climb the boards: weekly PnL, Net Worth, Clout and Trust Score. Rank buys status, a better home and outfits.

Every Sunday is Unlock: rent and the gas bill are due, and the Weekly Meta rotates.

A 10-minute session

0:00 Open the app. The phone shows today's alpha clue.

0:30 Work a Discord Mod shift: ban 10 drainer DMs in 45 seconds. Earn $40 Cash.

2:00 Go to the Terminal Café. The Pulse screen shows $FROGE in Final Stretch. Tap the 0.5 buy preset.

3:30 The Town Crier shouts "JUST IN: exploit on Audit Row." Market Mood turns red.

4:00 $FROGE graduates at 3.2x. Sell half and share the PnL card.

5:00 Two players at the café talk over proximity voice. One invites you to a Space.

6:00 In the Spaces Studio, the host sells 10-minute video calls at 2 USDC a minute.

8:00 Open a 5x long in the Perp Pit using the Perp Degen tribe perk. Get liquidated. A REKT card pops up and your tombstone appears.

9:30 Go home, tip a friend and set a reminder for Sunday Unlock.

Solana Mobile features used (judges score "usage of mobile features")

Mobile Wallet Adapter 2.0: required by the hackathon

Sign In With Solana

Signing in the Seeker's Seed Vault wallet, through MWA

Seeker Genesis Token check

SKR payments (eligible for the $10k SKR prize)

.skr names shown as a verified tag next to your alias

Solana Pay top-ups

Who lives on CT
Every CT type is in the game: 7 are playable tribes and 28 are NPCs, each with its own loop. The types come from 20+ X searches on 4 Oct 2026 plus published research (HICSS 2024, 115M tweets; arXiv 2403.06036). NPC lines are adapted from real posts and never attributed to real people.

Playable tribes
Picked at signup, changeable once per season. Perks are v0 numbers to playtest.

Tribe

Home turf

Perk

Signature emote

Trencher

The Trenches

Sees new launches 3s earlier

"Send it" slam

Perp Degen

Perp Pit

Leverage cap +5x

Chest-thump "max long"

Prediction Shark

Prediction Pit

Prediction fee −50%

Coin flip

Airdrop Farmer

Airdrop Farm

Farm yield +15%

Watering can

Caller / KOL

Spaces Studio

Calls reach 2x NPC followers

Ring-light pose

Builder

Hackathon House

Project launch cost −30%

Frantic typing

Anon

Anywhere

Hidden from rich list; immune to Doxx events

Hood up

NPC archetypes
NPC

Where

Loop

Signature line

Look

Town Crier ("JUST IN" bot)

Timeline Square

Announces server events and big liquidations every 2 min

"JUST IN: $4.2M in longs liquidated in the past 60 minutes"

Megaphone, siren hat

Giveaway Guy

Timeline Square

Asks players to "drop your wallet"; those who do lose $50 Cash to a fake drain

"Like, RT, drop your wallets, join my TG"

Gold chain, phone

Reply Guy

Follows the richest player in the venue

Spams emotes beside them

"this" / "LFG" / "gm king"

Phone glued to hand

Alpha Caller

Cabal Lounge door

Sells "early CA" for in-game cash; most calls dump

"GUARANTEED 100X. Who wants early CA?"

Anime mask, shades

Cabal Insider

Cabal Lounge (VIP)

Buys before launch, sells into the first buyers

Whispers only

Hood, matching pins

Rug Dev

Launchpad Tower

Launches coins; a share of them rug

"Locking 80% supply. No insiders, no snipers."

Burner phone, hoodie

Sniper Bot

Launchpad Tower

Small drones that buy on the first tick

Beeps

Drone

Perp Degen NPC

Perp Pit

Opens 50x, gets liquidated about every 10 min with the full animation

"Max long" → "it's so over"

Three monitors

Rekt Guy

Rekt Clinic

Sits crying, asks for a stimmy

"It's so over"

Pink face, torn shirt

Doomposter

Timeline Square, red Market Mood only

Calls every −3% a bear market

"The bull is dead"

Black hoodie, rain cloud

Laser-Eyes Maxi

Anywhere

Calls everything a shitcoin

"Have fun staying poor"

Laser eyes

Chain Tribalists (pair)

Ratio Arena

Argue on a loop; players bet on who wins

"Cockroach chain"

Rival jerseys

Sleuth

Audit Row

Posts exposés of NPC cabals to the Timeline; players can hire him

"A thread on how this coin was bundled"

Detective coat

Auditor

Audit Row

Sells audits that reveal a coin's rug risk

"Exploit alert"

Security lanyard

VC

VC Row

Buys player projects cheap, dumps at unlock

"We're excited to back…"

Fleece vest

Farmer + Sybil Farmer

Airdrop Farm

Farms points; the Sybil spawns 10 small clones

"TGE wen?"

Straw hat; clones

Spaces Host

Spaces Studio

Runs an NPC room when no player is hosting

"gm gm, waiting for people to join"

Headphones

Wallet Tracker

Terminal Café

Broadcasts the biggest player wins

"A trader just flipped $44 into $509k"

Binoculars

Fake-Rich LARP

Dubai Marina

Poses with a rented supercar, sells a course

"I made $1M at 21. Here's how."

Rented car

Dubai Relocator

Dubai Marina

Brags about 0% tax

"Taxes are a choice"

Linen shirt

AI Agent

Terminal Café

Trades on its own, posts nonsense philosophy

"I am become liquidity"

Terminal for a head

Drainer

DMs, Discord Heights

Fake support that offers "help"

"DM me, I'm support"

Fake staff badge

Community Mod

Discord Heights

Bans spam; players can take mod shifts

"Team will never DM you first"

Headset

Thread Boy

Timeline Square

Sells threads

"1/ Here's why…"

Notebook

Engagement Farmer

Timeline Square

Asks for likes for a "surprise"

"Like and reply hi, surprise in DMs"

Ring light

Normie (exit liquidity)

Arrives in waves at market peaks

Buys the top

"Is it too late to buy?"

Tourist outfit

Doxxed Founder

Builder Hills

Recruits players into projects

"We're hiring"

Startup tee

Prediction Shark NPC

Prediction Pit

Bets against the crowd

"Fade the public"

Betting slip

Do not use "jeet" in NPC dialogue; it is often read as an ethnic slur (KYM).

[Inference] Market and launch events on X cluster around liquidations, rugs, cabal exposés and giveaways. Those four drive most NPC loops above.

Projects
Decision: projects are in, in three layers. Layers 1 and 2 are gameplay. Layer 3 is the business.

Fictional projects (NPC-run). Parody names only. They launch coins, run airdrops, get exploited and rug. They supply the daily drama.

Player-founded projects. The end-game of the Builder and Founder careers.

Found a project for in-game cash. Pick a type: memecoin, DEX, NFT studio, perps venue, "L2".

Hire other players into roles: dev, mod, KOL, auditor. Pay them salaries in game cash.

Launch the project's token on the in-game launchpad (fictional, server-simulated).

Get an HQ room in Builder Hills that the team decorates and hosts in.

Risks rolled by the server: exploit, rug accusation, VC dump at unlock.

Real projects as advertisers (paid in USDC, SOL or SKR).

Billboards on the city map.

The Pixel Wall on Timeline Square: small ad tiles, like Lagos Life's Sea Plots.

Sponsored apps on the in-game phone.

A branded venue or a booth during in-game Conference Week.

Sponsored quests that only ask for in-game actions.

Why layer 3 works: Lagos Life has 38+ billboards booked into November and December at ₦5,000 per week. It also sells sponsored phone apps to Nigerian startups, and a crypto exchange (ZINEX) already advertises there.

Rules for real projects:

Every placement shows a "Sponsored" label.

No real-money or token rewards for posting, liking or following on X. X revoked API access for apps that reward posting on 15 Jan 2026 (Decrypt).

No real token airdrops to players through the game.

Every creative goes through manual review before it goes live.

v0 prices. [Inference] These are guesses to test. Lagos Life sells out at about $3.60 per week, so it is underpriced.

Placement

Price

Term

Billboard

20 USDC

7 days

Pixel Wall tile

2 USDC

7 days

Sponsored phone app

150 USDC

30 days

Conference Week booth

300 USDC

1 event

Branded venue

1,000 USDC

30 days

The world
Each venue is one diorama scene, loaded when you enter it, as in Lagos Life and PH Lifestyle.

The city map is a separate low-detail scene used to travel between venues. The ORE Refinery opens in Phase 2; the rest of Airdrop Farm opens in Phase 6.

Homes are private rooms reached from the phone: Parent's Basement, Hacker House, Studio, Penthouse, Marina Villa.

Each venue instance holds up to 50 players. Extra players spill into a parallel instance of the same venue.

Economy
Two ledgers that never mix: game Cash, which can never leave the game, and real money, which never enters a game of chance.



Cash (game money)

Real money (USDC, SOL, SKR)

Lives in

Server ledger, append-only

Solana: devnet for the demo, mainnet at launch

Pays for

Rent, food, gear, fictional coins, perps, predictions, businesses, beef stakes, cups

Cash top-ups, cosmetics, tips, paid calls, ads

Withdrawable

Never

It is the player's own wallet

Can be won

Yes, in-game

Never from a game outcome

Top-up packs. These mirror Lagos Life's ratios, scaled to the PRD's fake-dollar economy.

Pay

Get Cash

Pack

1 USDC

$500

Ramen

5 USDC

$3,000

Bag

10 USDC

$7,000

Whale (best value)

20 USDC

$16,000

Cabal

SOL, SKR and ORE are accepted at the live quote. ORE gets a 15% bonus (see ORE) and SKR a 10% bonus. That makes us eligible to compete for the $10k SKR prize, which asks teams to "Use SKR for in-app purchases, rewards, access".

Cap: 100 USDC of top-ups per wallet per day.

Flow: a Solana Pay transfer request to the treasury with a unique reference key. A Helius webhook confirms it and the server credits the ledger. Top-ups are one-way.

Start of life: the birth lottery (forced once per account)

Insider Baby: $3,000 and a Studio.

Exit Liquidity Baby: $300, and owes $720, repaid at $120 a week with a 10% penalty if missed.

Seeker Baby (wallet holds a Seeker Genesis Token): $1,500, a Hacker House and a verified badge.

Cash rules from PRD v2.2, kept as-is

Faucets: shifts, gigs, businesses, vaults, daily alpha, Weekly Meta bonuses.

Sinks: rent, gas, food, transport, tax, gear, business costs, rug losses, bail, cosmetics.

Rent per week: Parent's Basement $20, Hacker House $60, Studio $180, Penthouse $1,500, Marina Villa $5,000.

Tax: the first $5k a week is free, then 20% / 40% / 45%. Resets Monday.

Simulate the economy in a spreadsheet before building shops. Lagos Life's top 9 players are all stuck at the same cap.

Fictional markets (server-simulated, never on-chain)

A new parody coin launches about every 5 minutes on a bonding curve. It graduates to an x·y=k pool at a market-cap threshold. Ticks every 2 s, single writer per coin, seeded RNG for replay.

Outcome mix to tune: rug 25%, slow bleed 40%, sideways 20%, moon 15%. Blind aping should lose slightly after fees.

Perps on fictional coins: the cap follows the Trading skill (1–10): 1x at 1–4, 2x at 5, 10x at 10, +5x for the Perp Degen tribe. Auto-liquidation shows a REKT card.

Predictions on in-game events at 5m, 15m, 1h and daily horizons.

Alpha Calls are immutable, with a public Trust Score.

Market Mood reads the real SOL 24h change from a public price feed. It only modifies the game and is never a currency.

Where the money line sits

Cash can never be converted into anything transferable.

Cosmetics bought with Cash are off-chain.

Cosmetic NFTs (Metaplex Core, about 0.003 SOL a mint, Metaplex) can only be bought with real money and are never prizes.

[Inference] This keeps the game outside Google Play's real-money gambling definition of wagering "to obtain a prize of real world monetary value" (Play policy). That matters if we ever ship on Play. The dApp Store policy has no gambling clause.

Revenue lines

Line

Take

Cash top-ups

100%

Cosmetics and the 5 USDC season pass

100%

Ads from real projects

100% (see Projects)

Paid calls

10% platform fee

Tips

0%

ORE: the Refinery
ORE goes in two ways: as CT City's hard money, and as a Refinery venue where players stake real ORE. We do not put ORE mining in the app, because mining today is a paid game of chance.

What qualifies

These are quoted from the CLOCK IN site's prize section (solanamobile.radiant.nexus).

"One matched prize. One winner. Top 10 only."

The match equals the placement prize: $30k for 1st, down to $5k for 6th–10th.

It is paid in stages against milestones agreed after the hackathon.

"A working, user-facing ORE integration must be live in the submitted product."

"If the product supports competing or similar products, ORE must be the primary product featured and promoted during the prize period."

The integration must stay live and supported.

There are progress updates with usage metrics.

ORE must be "meaningfully included" in launches, demos, content and social posts.

What ORE is today (verified on-chain and on GitHub, 4 Oct 2026)

Program: oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv, v3.8.25 (repo, verified build).

How mining works: it is a 5×5 board game.

Players deploy SOL onto squares. One square wins each round (240 slots plus 48 between rounds).

The winning square earns ORE.

A 1-in-500 "motherlode" jackpot stood at 55 ORE when checked.

Since 12 Aug 2026, losing squares lose about 10.9% of their SOL.

ORE mint: oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp, 11 decimals. Max supply is 3,000,000; 500,966 have been minted. About $135 (CoinGecko).

Staking program: stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH, with deposit, withdraw, claim and compound. The yield is a share of protocol revenue (ore-stake).

stORE mint: storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR.

No official TypeScript SDK. The Rust crates are ore-api 3.8.25 and ore-stake-api 0.3.0. BE ports the few instruction builders it needs to TypeScript with @solana/kit.

Decision: no mining inside the app.

[Inference] Paying SOL for a randomly drawn reward is the lottery pattern: something paid, a chance, a prize.

That breaks our rule that real money never meets chance.

Players who want to mine get a "Mine on ore.com" link.

The integration (Phase 2)

Piece

What the player sees

On-chain

ORE Refinery venue

A 3D refinery in the Airdrop Farm district. A giant live 5×5 ORE board, the round timer and the motherlode counter. The furnace glows brighter as city-wide staked ORE grows.

BE reads ORE's board, round and treasury accounts and caches them every 2 s

Refinery terminal

Stake, unstake, claim and compound real ORE. Your avatar wears a hard hat while you have ORE staked.

ore-stake deposit, withdraw, claim, compound, signed with MWA

ORE as hard money

Pay for Cash packs, cosmetics and ads in ORE. ORE gets the biggest bonus: +15% Cash.

SPL TransferChecked of ORE (11 decimals) to the treasury

Miner badge

Nameplate tiers: Prospector (holds ORE), Miner (stakes 1+ ORE), Refiner (stakes 10+ ORE)

Reads balance, the ["stake", user] PDA and stORE

ORE Miner NPC and Crier lines

An NPC at the Refinery talks up the board. The Town Crier shouts real motherlode hits: "JUST IN: motherlode hit, 55 ORE".

BE watches ORE rounds

ORE-only cosmetics

Hard hat, pickaxe emote, glowing ore backpack. Only buyable with ORE.

SPL transfer

Rules to stay eligible

ORE is the only staking or mining token we feature during the prize period.

ORE is in the demo video, the deck and every launch post.

The Refinery stays live after the hackathon.

ORE features run on mainnet with real ORE. [Unverified] ORE has no devnet deployment, so use small amounts in demos.

[Inference] ORE may rate staking and payments below in-app mining. Whether to add mining is an open question for you.

Social layer
All voice and video runs on LiveKit Cloud through its Unity SDK v2.1.0 (23 Sep 2026, Android supported). The backend mints every room token after Sign In With Solana; the client never holds a LiveKit secret.

Feature

How it works

LiveKit room

Who can talk

Venue chat

"Say something out loud": a speech bubble over your avatar, seen by everyone in the same venue instance. Links and phone numbers are blocked.

None (game socket)

Everyone in the venue

Proximity voice

In any venue you hear players within 8 m, quieter with distance. The client subscribes only to the 6 nearest speakers. Mic is off by default.

One per venue instance

Everyone in the venue

Spaces (audio rooms)

Spaces Studio venue. One host, up to 10 speakers on stage, unlimited listeners. Listeners raise a hand; the host promotes them.

One per Space

Host and promoted speakers

Video calls (free)

Started from the phone's Contacts or Messages app. 1:1 or groups up to 8, shown in the phone UI over the 3D world.

Private

Invited players

Paid video calls

A creator sets a USDC rate per minute (0.25–50) and a maximum length. The fan prepays into escrow; the call settles pro-rata.

Private

Fan and creator

DMs

Text only, opt-in, 18+

None

Two players

Tips

Wallet to wallet in USDC, SOL or SKR from a profile. Cash tips are capped daily.

None

n/a

Spaces mechanics. Listeners join with canPublish: false. To promote one, the backend uses its server API key to call LiveKit UpdateParticipant, setting that listener's canPublish permission to true (LiveKit docs). Each participant can subscribe to at most 100 audio tracks (limits).

Paid call flow

The fan opens a creator's profile, taps Call and picks minutes. The app shows rate × minutes plus a 10% platform fee.

The fan signs open_session through Mobile Wallet Adapter. USDC moves into a session vault owned by the program.

A Helius webhook tells the backend the session exists. The backend creates the private LiveKit room and pushes an invite to the creator.

The creator has 120 s to accept. If they don't, the backend calls refund and the fan gets everything back.

The call runs with a visible timer. The backend closes the room at the paid maximum.

LiveKit's signed participant_left or room_finished webhook fires. The backend calls settle(seconds_used): the creator gets rate × minutes used, the treasury gets the fee, and the fan gets the rest.

If the backend never settles, the fan can call refund after the session's expiry.

Escrow rules. It is adapted from the open-source Anchor escrow example.

The program has no admin withdraw. Funds can only go to the creator, the fan or the fee account, in the split the program computes.

[Inference] The backend is still trusted to report call length truthfully.

Safety (required by the dApp Store publisher policy)

Report and block on every avatar, message, Space and call.

18+ gate at signup.

Creators opt in to paid calls.

Calls are never recorded.

A moderation dashboard is in place before paid calls go live.

Feature list
There are 44 features across the six phases (see Phases). Every row names what each of you builds, so nothing falls between you. Update Status as you go.

Phase 1 · City and identity
#

Feature

FE builds

BE builds

Status

1

Sign In With Solana and Seeker badge

Login screen, MWA calls, badge

Challenge and verify, Seeker Genesis Token check, JWT

Not started
▾


2

Character creator

Modular avatar UI, 3D preview, tribe pick, 18+ confirm

POST /characters, item registry

Not started
▾


3

Birth lottery

Lottery animation, share card

POST /lottery/roll

Not started
▾


4

City map and travel

Map scene, venue loading

Venue registry, instances

Not started
▾


5

Timeline Square

Diorama, billboards, Pixel Wall

Venue room, NPC brains

Not started
▾


6

Movement, emotes, chat bubbles

NavMesh, emote animations, bubbles

move, emote, say, chat filter

Not started
▾


7

Nine NPC archetypes: Town Crier, Giveaway Guy, Reply Guy, Perp Degen, Rekt Guy, Wallet Tracker, Doomposter, Spaces Host, ORE Miner

Prefabs, animations, babble

Brains, lines

Not started
▾


8

Needs and own home

Needs HUD, home scene

Lazy needs decay, actions

Not started
▾


9

First 3 careers with shifts

9 mini-games

Shifts, pay, XP

Not started
▾


10

Town Crier and server events

Toasts, crier, stingers

Event engine

Not started
▾


11

Net Worth and Weekly PnL boards

Rich-list screen

Boards in Redis

Not started
▾


12

Report and block

Report sheet, block button

Endpoints, moderation queue

Not started
▾


Phase 2 · Money and markets
#

Feature

FE builds

BE builds

Status

13

Cash top-ups in USDC, SOL, SKR and ORE

Pay sheet, MWA signing

Payment intents, Helius webhook

Not started
▾


14

Terminal Café trading

Pulse terminal, PnL card

Market sim, trades, ledger

Not started
▾


15

Launchpad Tower

Venue, launch board

Launch-board feed

Not started
▾


16

Perp Pit and liquidation

Leverage UI, REKT card, liquidation animations

Perps, liquidation engine

Not started
▾


17

Rekt Clinic and tombstones

Venue, tombstone props

Rekt events, tombstones

Not started
▾


18

ORE Refinery, ORE payments, Miner badge

Refinery venue, live board, stake terminal, hard hat, ORE cosmetics

ORE account reader, ore-stake builders, ORE intents

Not started
▾


19

Prediction Pit

Venue, betting UI

Prediction markets

Not started
▾


20

Alpha Calls and Trust Score

Call card UI

Call engine, scoring

Not started
▾


21

Smart Money copy trading

Copy UI

Copy engine

Not started
▾


Phase 3 · Voice and calls
#

Feature

FE builds

BE builds

Status

22

Proximity voice

LiveKit, speaking light, lip-sync

POST /rtc/token

Not started
▾


23

Spaces Studio

Stage, raise-hand queue

Spaces endpoints, speaker promotion

Not started
▾


24

Free video calls

Phone call UI

POST /video-calls

Not started
▾


25

Paid video calls

Phone call UI, creator settings

ct_escrow, paid-call API, webhooks

Not started
▾


26

DMs

Phone Messages app

DM storage and delivery

Not started
▾


27

In-game Timeline feed and follows

Phone Timeline app

Feed, follows

Not started
▾


28

Tips in Cash and on-chain

Tip sheet

Tip caps, records

Not started
▾


Phase 4 · City life
#

Feature

FE builds

BE builds

Status

29

All 14 careers and gigs

42 mini-games, gig UI

Career and gig config

Not started
▾


30

Businesses and bad days

Business UI

Business engine

Not started
▾


31

Home visits and rent

Home room, visit UI

home room, rent

Not started
▾


32

Sunday Unlock, Weekly Meta, daily clue

Share cards, clue UI

Scheduler, clue

Not started
▾


33

Cosmetics shop

Shop, try-on

Shop, inventory

Not started
▾


34

Cosmetic NFTs

Wallet inventory

Metaplex Core minting

Not started
▾


35

Season pass

Pass screen

Pass logic

Not started
▾


Phase 5 · Projects and ads
#

Feature

FE builds

BE builds

Status

36

Ads: billboards, Pixel Wall, phone apps, booths

Render live creatives

Slots, bookings, approval

Not started
▾


37

Player projects, Builder Hills, VC Row

HQ rooms, VC Row venue

Project system, VC NPC

Not started
▾


Phase 6 · Competition
#

Feature

FE builds

BE builds

Status

38

Tribe district control

District flags

Tribe scores

Not started
▾


39

Leagues and seasons

League screen

League engine

Not started
▾


40

CT Beef in the Ratio Arena

Arena, voting UI

Beef matches, Elo

Not started
▾


41

Airdrop Farm and Sybil Barn

Venues

Farming, sybil jail

Not started
▾


42

Dubai Marina and Cabal Lounge

Venues

Invites, net-worth gates

Not started
▾


43

LLM chat for 2 NPCs

Chat UI

LLM service, filters

Not started
▾


44

Verified X link

Settings screen

OAuth 2.0, X display rules

Not started
▾


Tech stack
The stack is a Unity 6.3 client, one TypeScript backend, one Anchor program and LiveKit for media. Versions were checked on 4 Oct 2026 against release pages, npm and GitHub.

Client (FE)

Piece

Choice

Version

Note

Engine

Unity 6.3 LTS, URP

6000.3.25f1

Supported to Dec 2027. Personal is free under $200k.

Wallet

Solana.Unity-SDK, a commit SHA, recorded in manifest.json, on main

1.3.0

MWA 2.0 and Sign In With Solana were merged on 17 Jun 2026. The tagged v1.2.9 breaks Android IL2CPP builds (#257).

Wallet fallback

Our own Android plugin wrapping the official mobile-wallet-adapter-clientlib-ktx

2.2.0

Use this only if the SDK fails the day-1 spike

Realtime

Colyseus Unity SDK

0.18.8



Voice and video

LiveKit Unity SDK

2.1.0

Android supported

Audio

FMOD Studio and its Unity integration

[Unverified]

Pin it on day 1

Content

Addressables with a remote catalog on a CDN

—

The dApp Store takes APKs only, so there is no Play Asset Delivery

Thermals

Adaptive Performance 6.0 (Android provider) and Optimized Frame Pacing

6.0

Android docs

Lip-sync

uLipSync

3.1.4



Backend (BE)

Piece

Choice

Version

Runtime

Node.js

22 or later (Colyseus requires it)

REST

Fastify

5.12.5

Realtime

Colyseus with redis-presence and redis-driver for scaling

0.18.9 / 0.18.5 / 0.18.4

Jobs

BullMQ: market ticks, NPC brains, Sunday Unlock, Meta

6.3.11

Data

Postgres (ledger, users, markets) and Redis (presence, boards, rate limits)

Managed

Solana client

@solana/kit and @anchor-lang/core

8.4.0 / 1.2.0

Program

Anchor with Solana CLI 4.1.2

1.2.0

RPC and webhooks

Helius: free tier 1M credits and 10 req/s; Developer plan $49/mo

—

Media

LiveKit Cloud: Build plan free (5,000 participant-min, 100 concurrent); Ship plan $50/mo. Server SDK livekit-server-sdk.

2.19.1

Hosting

Railway for staging and prod. PH Lifestyle runs its realtime server there.

—

Mock

Prism

5.16.0

Rejected, and why

Godot 4.7:

No Android LiveKit SDK (binding is desktop-only).

Open crash reports on Mali GPUs (#122856).

Its Solana SDK lacks Sign In With Solana.

three.js in a WebView: CLOCK IN says "PWA wrappers will score poorly", and the mic and camera need custom native edits.

Nakama 3.41: it has strong built-ins, but its TypeScript runtime can't load npm Solana libraries, so money logic would need a second server.

Photon: priced on cloud concurrent users.

Unreal: its Solana SDK is pre-release.

Ready Player Me: shut down on 31 Jan 2026.

Synty assets: their EULA bans "use in Blockchain based projects" (EULA). Use CC0 kits from Kenney and Quaternius instead.

Engine spike. It is built first, before any Phase 1 feature, so the engine risk is gone before any art is made.

Build an empty Unity 6.3 IL2CPP APK containing Solana.Unity-SDK main, LiveKit and Colyseus.

On a Seeker, it must:

Sign in with Solana.

Join a LiveKit room and a Colyseus room.

Hold 60 fps with 62 placeholder avatars.

If sign-in fails, switch to the plugin fallback before going further.

Art direction and 3D pipeline
The style is a "neon toy diorama":

Chibi characters, 2.5–3 heads tall.

Flat low-poly with one shared gradient-palette atlas.

Toon ramp shading, baked light and blob shadows.

Each district has its own hue ramp; green and red are the city's pump and dump language.

[Inference] This is the cheapest look that still reads well on a Mali-G615 GPU. Arm says mobile cost is now mostly bandwidth, and that alpha-tested overdraw hurts (Arm, Vulkanised 2025).

Tools (versions checked 4 Oct 2026)

Tool

Version

Cost

Use

Blender

5.2.2 LTS

Free

Model, rig, animate

Unity

6.3 LTS (supported to Dec 2027)

Personal: free

Engine

Rigify / AccuRIG 2

Built-in / 2

Free

Auto-rig

Auto-Rig Pro Full

—

$50

Unity Humanoid export

Mixamo

—

Free

Base locomotion clips. Its auto-rigger can fail on chibi proportions.

Cascadeur Indie

—

$96/yr

Hand-keyed falls and liquidation collapses

Meshy Pro or Tripo Pro

7.1 / P1

~$20/mo

Props only. Paid tiers carry commercial rights.

uLipSync

3.1.4

Free (MIT)

Mouth shapes from voice chat

Licensing blockers to respect

The Unity Asset Store EULA forbids using its assets "in any digital representation of value" (terms). Anything minted as an NFT must be made by us.

ActorCore motions "may not be used for in-app purchases" (license). Never sell them as emotes.

Free tiers of Tripo, DeepMotion, QuickMagic and ElevenLabs are non-commercial. Hunyuan3D 2.1 excludes the EU, UK and South Korea.

Character spec

One shared Humanoid skeleton:

20–24 body bones, plus a jaw and 2 eye bones.

Mitten hands with 1–2 finger bones.

Max 4 bone influences per vertex; 2 at LOD2.

Modular parts:

Body, head, hair, top, bottom, shoes and accessory are all skinned to that skeleton.

At runtime they merge into one SkinnedMeshRenderer with one material. Unity says two skinned meshes "could roughly double the rendering time" (Unity manual).

Triangles:

LOD0 4–6k, LOD1 2–3k, LOD2 0.8–1.2k; hidden beyond that. For scale, Roblox caps a whole avatar at 10,742 (Roblox spec).

Make LODs by hand: Unity's Mesh LOD ignores skin weights.

Textures: one 512² atlas per avatar (1024² for hero characters), compressed as ASTC.

Face:

Flipbook eyes and mouths: a 4×4 atlas with 8 eyes and 8 mouths, switched by UV offset.

Blend shapes for blinking only.

FBX export:

Add Leaf Bones off, Only Deform Bones on.

Never use Apply Transform on armatures; it is broken in the exporter (Blender manual).

Unity import:

Rig type Humanoid.

Use "Copy From Other Avatar" for every outfit and clip.

Turn on Optimize Game Object.

Animation list (all in place, no root motion; L = loop; about 70 clips)

Locomotion blend tree:

Idle (L) plus 3 fidgets.

Walk (L), Jog (L), Run (L).

Turn 90° left and right.

Jump: start, air and land.

Sitting and terminal:

Stand→Sit, Sit idle (L).

Type (L), Frantic type (L), Lean back (L).

Desk slam, Sit→Stand.

Phone (upper-body mask): pull out, hold (L), scroll (L), take photo, put away.

Social emotes, 1.5–3 s each:

Wave, point, clap, thumbs-up, facepalm, shrug, laugh.

Nod, head-shake, bow, salute, heart-hands.

gm coffee sip, WAGMI fist pump, moon jump.

Talk: 2 gesture loops (upper-body additive), listen-nod (L), host-with-mic (L).

Dance: 4–6 loops of 8 beats each, all at 120 BPM.

Despair: cry (L), kneel, head-in-hands seated (L), shock gasp, rage stomp.

Liquidation set:

Stagger → collapse → faceplant idle (L) → get up.

Rug-pull fall (the carpet is yanked).

Ghost respawn pop.

Tribe emotes: send-it slam, chest-thump, coin flip, watering can, ring-light pose, hood up.

Hand-key in Blender, not Mixamo: facepalm, phone and crying. [Inference] Mixamo's realistic clips clip through chibi heads.

Networking rule. Positions come from the server. Emotes are sent as {emoteId, emoteAt}. Every clip has an ID in the Contract tab.

Environment

Modular kit:

Pieces on a 2 m grid.

One palette atlas and one trim sheet for the whole city (trim sheets).

Scenes:

Each venue is one diorama scene, loaded additively.

The city map is its own low-detail scene.

Lighting:

Static batching.

Baked lightmaps in Subtractive mode plus light probes.

No realtime shadows.

Blob shadows are a quad with a radial gradient.

Sky: a gradient sky shader, tinted per district.

Unity must-dos

Set Application.targetFrameRate = 60. Android defaults to 30 (Unity docs).

URP, with Vulkan first and a GLES fallback.

Animator Culling Mode: Cull Completely. Animation compression: Optimal.

Post-processing is limited to Bloom (high-quality filtering off), color grading and vignette. Each can be switched off in Settings.

NPCs and AI
NPCs think on the server and move on the client. Every player sees the same NPC doing the same thing, and NPCs cost almost no bandwidth.

Split of work

Backend:

Runs each NPC's brain at 1 Hz and sends only state changes.

A state change is {npcId, state, spotId, lineId, emoteId, startedAt}.

Ties NPCs to real game events: launches, rugs, liquidations, Market Mood.

Frontend:

Walks the NPC to the named spot with Unity NavMesh.

Plays the state's animation, speech bubble and voice babble.

Spots are named anchors inside each venue scene, e.g. terminal_2 or stage. FE authors them; the IDs live in the Contract tab.

Shared states (every NPC uses these; in the Contract they are lowercase, e.g. idle)

State

Meaning

Exit when

IDLE

Stand and fidget

5–15 s pass

WANDER

Walk to a random free spot

Arrives

GOTO

Walk to a given spot

Arrives

ACT

Loop an action anim (type, farm, dance)

Its timer ends or an event fires

TALK

Show a line, play babble, gesture

3 s

REACT

One-shot reaction to an event (liquidated, moon, rugged)

Anim ends

FOLLOW

Stay 2 m behind a target player

Target leaves the venue

LEAVE

Walk to the exit and despawn

Arrives

Archetype loops

NPC

Loop

Triggers

Perp Degen

GOTO terminal → ACT frantic_type 60–120 s → 70%: REACT liquidated → LEAVE, respawn in the Rekt Clinic → ACT cry → LEAVE. 30%: REACT moon_jump → TALK → repeat

Liquidation event broadcast city-wide

Reply Guy

FOLLOW the richest player in the venue; every 20 s TALK + an emote

Target leaves → pick the next richest

Giveaway Guy

GOTO square_center → TALK every 30 s

A player taps "drop wallet" → they lose $50 Cash and get a "you got drained" toast

Town Crier

Patrols 3 spots; on any server event → TALK with the event's numbers

Every server event

Rug Dev

GOTO launch_desk → ACT type → a real in-game coin launches

Coin outcome is rug → REACT run_away → LEAVE. Returns next day in a new colour.

Sniper Bots

Spawn at each launch, swarm the launch board, despawn after 10 s

Coin launch

Sleuth

Once an hour picks a recent rug → posts an exposé to the Timeline → TALK

Players can hire him to reveal a coin's insider share

Doomposter

Spawns only when Market Mood is below −2%

Despawns when Mood turns positive

Normie wave

5–15 spawn when a coin reaches its Peak stage and buy; REACT sad when it dumps

Coin stage change

Sybil Farmer

ACT farm; every 10 min splits into 10 small clones → the Mod NPC arrives → clones vanish

Timer

Chain Tribalists

Alternate TALK lines on a loop; every 5 min a debate round that players bet on

Timer

AI Agent

Trades every 30 s; its PnL is public; posts nonsense lines

Timer

Spaces Host

Opens an NPC Space when no player-hosted Space is live

No live player Space

Dialogue

v1, templates:

Each line has slots filled from live game data, e.g. "JUST IN: {coin} did {x}x in {minutes} minutes".

30–60 lines per archetype, stored in game config.

NPC voice is babble, not text-to-speech: pitched syllables generated from the text, like Animal Crossing. No per-line cost, and it reads as cute.

v2, LLM:

Free-form chat for exactly two NPCs, the AI Agent and the Sleuth, server-side and behind a feature flag.

Hard rate limit per player. Outputs are filtered like player chat.

Density

At most 12 NPCs per venue instance.

More appear only as background crowd (see Performance).

NPCs are always marked "NPC" over their heads, as PH Lifestyle does.

Sound design
Use FMOD Studio for music and sound effects, and LiveKit for voices. The market itself drives the music.

Middleware

FMOD Studio Indie: free while the project budget is under $600k and revenue is under $200k. An FMOD logo credit is required (licensing).

[Unverified] The current FMOD Unity integration version. Check fmod.com/download and pin it.

LiveKit voice plays through Unity audio sources. The music bus ducks 6 dB whenever a nearby player or a Space speaker is talking.

Adaptive music. Each district has four stems: pad, bass, drums and lead.

The market_mood parameter runs from −1 (red) to +1 (green).

Green brings in drums and lead.

Red low-passes the mix and adds a tension layer.

District

Tempo

Feel

Timeline Square

100 BPM

Lo-fi

The Trenches

140 BPM

Trap / phonk

Perp Pit

128 BPM

Techno

Airdrop Farm

90 BPM

Banjo lo-fi

Builder Hills

95 BPM

Synthwave

Dubai Marina

110 BPM

Deep house

Clubs and parties

112 BPM

Amapiano / Afrobeats

Spaces Studio

None

Voice only

Stingers (each ducks the music):

Liquidation: alarm, then glass break, then a falling whoosh.

Rug pull: a carpet zip, then a bass drop.

Graduation fanfare, moon horn and rank-up.

The Sunday Unlock bell.

SFX list (every ID lives in the Contract tab)

UI: tap, toggle, error, success, toast.

Trading:

Buy chime, sell, take-profit hit.

New-coin pop, whale horn, PnL card flip.

Phone: DM ping, mention, incoming call ring, call connect, call end, Space started.

Voice rooms: join, leave, raise hand, promoted to speaker.

Ambience per venue:

Keyboard clatter in the Terminal Café.

Birds on the farm, water at the marina.

Club bass muffled behind doors.

Footsteps: concrete, wood, metal grate, carpet, neon tile, grass.

NPC babble: one syllable set per archetype, pitched per NPC.

Sources and licences

Sonniss GDC 2026 bundle: royalty-free, no attribution, no AI training.

Freesound: use the CC0 filter only.

Kenney: CC0.

ElevenLabs Starter at $6/mo for generated SFX. The free plan is not commercial.

Suno Pro at $8/mo for music sketches.

Do not use Udio: downloads have been disabled since 29 Oct 2025.

Mix targets. −18 to −16 LUFS integrated, true peak at or below −1 dBTP. This follows Sony's portable spec of −18 ±2 LKFS (ASWG-R001).

Performance budgets (Seeker)
The Seeker has a big, sharp screen and a small GPU, so we render below native resolution and lock 60 fps.

Chip: Dimensity 7300 with an Arm Mali-G615 MC2 GPU (2 shader cores) (MediaTek).

8 GB RAM.

6.36" 2670×1200 screen at 120 Hz (Seeker).

Android 16 since MR7 (release notes).

Budget

Target

Basis

Frame rate

60 fps cap; never below 30

[Inference]

Render scale

0.7 (about 1869×840)

[Inference]

Draw calls

Under 150 per frame

Arm's ceiling is 500 on GLES and 1,000 on Vulkan (Arm guide)

Visible triangles

100–150k

[Inference] from Android's geometry guide

Avatars on screen

Nearest 12 at LOD0; next 24 at LOD1 with half-rate animation; the rest at LOD2 with quarter-rate animation; culled beyond 25 m

[Inference]

Avatar mesh

LOD0 4–6k tris, LOD1 2–3k, LOD2 0.8–1.2k; 1 material; up to 24 body bones plus face bones

Art section

Lights

1 directional; everything else baked; blob shadows; no realtime shadows

Unity mobile guidance

Textures

ASTC 6×6 for albedo, 4×4 for UI and normals, 8×8 for environment. Mipmaps on the world, off for UI.

ASTC

Post-processing

Bloom with HQ filtering off, color grading, vignette. No SSAO or depth of field.

Unity URP docs

Memory

At most 1.5 GB resident

[Inference]

APK size

At most 150 MB. Phase 1 and 2 venues ship in the APK; later venues stream in through Addressables.

[Inference]

Network

3–5 KB/s per client in a full venue

[Inference]; see Contract section 5

Thermals

On a thermal warning, Adaptive Performance drops render scale to 0.6 and halves animation rates

Android ADPF

Stress test (definition of done for every venue)

Load 50 players and 12 NPCs, all emoting, with voice on.

It must hold 60 fps for 10 minutes on a Seeker without dropping below 45 when the phone gets hot.

Profile with the Unity Profiler and Arm's Mali tools.

Set Application.targetFrameRate = 60. Android defaults to 30.

How we build in parallel
We agree the contract on day 1, then build against it separately. Integration is an 11-step checklist that should take under an hour. The full contract is in the Contract (FE ↔ BE) tab.

The contract is four things, all versioned in contract/:

openapi.yaml (REST).

Colyseus schemas (realtime).

ID registries.

Game config files.

FE never waits. From the start, a mock serves real Colyseus rooms with fake players, NPCs and market ticks, plus REST examples.

BE never needs Unity. Headless bots join rooms, walk, chat and trade.

Generated code catches drift. C# state classes and REST models are generated from the contract, so drift shows up as a compile error, not a demo-day bug.

FE owns how things look and sound; BE owns what is true.

FE owns animation, SFX and spot IDs.

BE owns venue, item, event and error IDs.

LiveKit and Helius call the API back through signed webhooks.

Phases
We build the whole game in six phases, in dependency order. Every phase ends in a signed APK that passes the integration checklist, so any finished phase can be submitted. Nothing is cut to fit a date. When a deadline arrives, we submit the latest finished phase and keep building.

A phase is done when:

Every feature in that phase of the Feature list is Done.

The Contract tab's integration checklist passes on staging, for every step that phase covers.

The stress test in Performance budgets passes on a Seeker.

A signed APK and a demo video exist for it.

Submission points

CLOCK IN closes 8 Oct 2026 at 23:59. We submit whatever phase is finished by then.

[Unverified] The rules give no timezone, so treat 12:00 UTC on 8 Oct as the cut-off.

Phase 1 meets CLOCK IN's entry rules: a native APK that uses Mobile Wallet Adapter and runs on a device.

Phase 2 adds what the ORE match and the $10k SKR prize ask for.

If we place, the app must be on the dApp Store within 30 days of the results (10 Nov). We list whatever phase we submitted, then update it with every later phase.

Phase 6 is the public Season 1 launch.

Open questions
Each of these needs an answer from one of you. Tick it off when it's decided.


Does the backend dev accept Colyseus + Fastify over Nakama? Decide before tagging contract v1.0.0.


Has either of you shipped a Unity game before? If not, the day-1 spike doubles as learning time. The engine choice stays.


Is the team free of VC or angel funding? CLOCK IN's USDC prizes require it.


Which domain goes in the Sign In With Solana domain field and the app's links? None is bought yet.


Does the Seeker ship Google Play services, which push notifications need? [Unverified]


Which FMOD Unity integration version do we pin?


Does "CT Life" pass a trademark search? The dApp Store bans names that cause "confusion with a third-party's entity, brand", so no X or Twitter marks.


Do sponsored placements fall under Nigeria's SEC finfluencer disclosure rules? [Unverified] Penalties start at ₦10M (Gazette).


Which 10–20 CT creators get early access to seed the game? This is from the PRD growth plan.


Is economy spreadsheet v0 done before any shop ships?


When is the next Solana Mobile hackathon? [Inference] Past cadence (Jul 2025, Feb 2026, Sep 2026) points to about Feb–Mar 2027.


Renew the Colosseum Copilot token at arena.colosseum.org/copilot. It has expired, so this research used Colosseum's public API instead.


Do we add real ORE mining in the app using ORE's deploy or automate instructions? It would strengthen our ORE prize case, but it means shipping a paid game of chance. That needs a legal answer first.

Sources
These pages were opened on 4 Oct 2026. Claims not backed by one of them are labelled [Inference] or [Unverified] where they appear.

Hackathon and Solana Mobile

CLOCK IN rules and ORE terms and the CLOCK IN blog post

Past winners: MONOLITH and 2025

Seeker specs and MR7 release notes

dApp Store: submit an app, publisher policy, developer agreement

MWA 2.0 spec

Seeker features: detecting Seeker users, SKR

Reference games and competitors

Lagos Life and PH Lifestyle, both played on your accounts

Lagos Life's public stats API and advertise page

isakaba coverage

Colosseum projects API

CT behaviour

About 20 X searches covering KOLs, rugs, liquidations, trenches, cabals, reply guys, airdrops, Seeker, Nigerian CT, Lagos Life and prediction markets

Research: HICSS 2024, arXiv 2403.06036, HBS on crypto influencers

News: Decrypt on X's InfoFi ban, CoinDesk on the CLARITY Act

Engine, art and audio

Unity: 6.3 support, optimized characters, targetFrameRate

Performance: Arm GPU best practices, Android geometry, ASTC formats

Solana Unity SDK: repo, issue #257, PR #289

Networking and media: LiveKit Unity SDK, Colyseus, Colyseus Unity SDK, @colyseus/schema

Licences: Synty EULA, Unity Asset Store terms, ActorCore licence, Mixamo FAQ

Audio: FMOD licensing, Sonniss licence, ASWG-R001

Calls, payments and policy

LiveKit: pricing, participants, limits

Solana: Anchor escrow example, Anchor 1.2.0, Metaplex Core, Circle USDC addresses, Helius pricing

Policy: X developer policy, X API pricing, Google Play real-money gambling

ORE

ORE repo, verified build, ore-stake, ORE price

