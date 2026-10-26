# Timeline: the city's front page

> Backend for board `timeline-36` (approved 2026-10-26): three tabs, server event cards, NPC
> callers, opt-in check-ins. Migration 102. Code: `server/application/timeline.ts`,
> `city-cards.ts`, `npc-callers.ts`.

## Contract for the client

### `GET /v1/feed?tab=foryou|following|city&type=&before=`

Returns `{posts: FeedPost[], nextBefore: string | null, quiet: boolean}`. Page size 40. Pass
`nextBefore` back as `before` for the next page. The older `scope=global|following` still works
(`global` is For you).

| Tab         | Contents                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foryou`    | people, NPC callers, the Sleuth, career posts, check-ins; city cards at most 1 in 4 rows (at least 3 other rows before each one). Nobody posted: the last 5 city cards and `quiet: true` (show "Quiet on the Timeline. Here's what the city's doing."). |
| `following` | posts by the people and NPC callers you follow; no city cards.                                                                                                                                                                                          |
| `city`      | city cards only, newest first. `type=all                                                                                                                                                                                                                | launch | rug | liquidation | casino_win`. |

Authors you blocked never appear.

### `FeedPost`

```jsonc
{
  "postId": "uuid", "userId": "uuid", "alias": "smoothbrain", "text": "...", "createdAt": "ISO",
  "kind": "player | sleuth | career | caller | checkin | launch | rug | liquidation | casino_win",
  "isNpc": false,                      // the city, the Sleuth, an NPC caller: show the NPC badge
  "district": "the_trenches",          // tribe district it counts for, or null
  "meta": { ... },                     // raw server meta (sleuth/career/caller/city details)
  "card": CoinCard | VenueCard | ProfileCard | null,   // the one action card
  "secondaryCard": VenueCard | null,   // Sleuth posts and rug cards: "Go to Launchpad Tower"
  "verdict": { "postId", "text", "sellSharePct" } | null, // the Sleuth's box under a coin card
  "social": { "holders": 12, "followed": [{ "userId", "alias" }] } | null // launch cards
}
```

- `CoinCard {type:"coin", coinId, ticker, name, stage, mcapCents, change5mBps, holders, rugged,
dead, deepLink:"ctlife://coin/<coinId>"}`: hydrated at read time, so the price is live. `rugged`
  true turns the card red; `dead` grey (Open still works).
- `VenueCard {type:"venue", venueId, name, deepLink:"ctlife://venue/<venueId>"}`. `venueId` is a
  `venues.json` id, or `rug_room` for the casino pier.
- `ProfileCard {type:"profile", userId, alias, deepLink:"ctlife://profile/<userId>"}` (reserved;
  no server post uses it yet).
- Unknown `kind` values should render as `player` (the client already does this).

**Deep links** (new routes for `DeepLinks`): `ctlife://coin/<coinId>` opens Pulse on the coin,
`ctlife://venue/<venueId>` routes to the venue, `ctlife://profile/<userId>` opens the profile card.
The Sleuth's older `meta.deepLink: "venue:launchpad_tower"` maps to `ctlife://venue/launchpad_tower`.

### `POST /v1/feed/posts {text, withPlace?}`

201 with the `FeedPost`. The server builds the card: a coin card when the text names a real coin's
`$TICKER`; otherwise, only if `withPlace` is true, a place card for the venue whose door is within
60 m of the author (from the server's position hash). No position or no venue: no card, the post
still goes out. Posting never earns anything.

### `POST /v1/feed/checkins {venueId}`

Opt-in "is at <venue>" (kind `checkin`, a venue card). Only within 60 m of that venue's door per
the server's position (`400 VALIDATION_FAILED`, `details.reason: "not_at_venue"`; a bad id is
`"unknown venue"`), at most once per 15 minutes (`429 RATE_LIMITED`). Nothing posts by itself.

## City event cards

Written by the server as the city system user ("CT City", `isNpc: true`) after the action commits.
A card never blocks or fails the action.

| Kind          | When                                                       | Text                                                  | Card                         | Limit                                                                                      |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `launch`      | a Factory, launchpad or house coin launches                | `smoothbrain launched $FROG` / `$FROG just launched`  | coin, `social` faces         | one per coin; 4 a minute                                                                   |
| `rug`         | the Sleuth flags a creator dump, or a house coin dies      | `RUGGED: $FROG by smoothbrain` / `$FROG went to zero` | coin (red) + Launchpad Tower | one per coin; 4 a minute                                                                   |
| `liquidation` | a perp is liquidated                                       | `$120k of longs liquidated in the Perp Pit`           | venue `perp_pit`             | one card per 10 minutes, totals updated in place (`meta.longCents`, `shortCents`, `count`) |
| `casino_win`  | a slots or crash round settles at 10x or more, paying $10+ | `lucky_ape hit 40x on crash in the Rug Room`          | venue `rug_room`             | one per 2 minutes city-wide                                                                |

`evt_exploit` has no server source yet, so there is no exploit card; the City filter chip can wait.
The realtime `event` messages (`evt_rug`, `evt_coin_launch`, ...) still go out as before.

## NPC callers

Four original parody characters (no real CT account, name or likeness): **Candle Carla** (chart
lines), **Rugwatch Ray** (paranoid, tight stops), **Moonboy Milo** (everything is 10x), **Auntie
Ape** (apes on vibes). Each posts a call on a live **house** coin every 45-120 minutes (a workers
job checks every 5 minutes; the schedule lives in Redis). A call has a coin card and
`meta.call {entryMicros, targetX, stopPct}`. The market's hidden arcs decide whether it works out.
Callers are ordinary users, so following one fills the Following tab. Names and lines are
placeholders to rename (`server/application/npc-callers.ts`, `migration 102` for the names).

## District rollover fix

`workers/district-rollover.ts` counted posts by `feed_posts.district_slug`, a column that did not
exist, so the daily rollover failed every day. Migration 102 adds the column. Player posts and
check-ins fill it from the server's position: a turf venue the player is at (Perp Pit, Prediction
Pit, Spaces Studio, Cabal Lounge), else the island district's turf (trenches = `the_trenches`,
dubai_marina = `marina_villa`, airdrop_farm, builder_hills). The query no longer cross-joins every
character with every district.

## Speed

A page is 1 query (City) or 2 (For you: the social lane, then city cards in the same time window;
Following: newest 40 per followee through `feed_posts_user_created_idx`, then the newest 40), plus
up to 3 batched lookups (coins, Sleuth verdicts, followed buyers), all on indexes from migration 102.

Measured 2026-10-26 on the dev Mac (Postgres 16 capped at 2 vCPU / 2 GB, 50,000 posts, 300
authors, 6,000 follows): 300 readers each loading For you, Following and City every 1-3 s (about
150 requests/s, 10-20 times what real players do) got p50 5-7 ms, p95 213 ms overall (For you
305 ms, Following 239 ms, City 272 ms), p99 about 0.9 s. Database time per query was 0.1-1.3 ms
(EXPLAIN: index scans only); the tail tracked the host, whose load average was about 40 from other
work during the run. 48 of 38,598 requests (0.12%) failed during the sign-up and follow burst
(cause not checked).
