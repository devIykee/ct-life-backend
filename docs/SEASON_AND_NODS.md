# Season Pass tracks and community nods

Retention items #4 and #5. Code: `server/application/season-tracks.ts`, `nods.ts`, `rewards.ts`; routes in `server/api/routes/season.ts`; migration `1700000087000_season_tracks_nods.sql`.

## Season tracks

- Definitions: `contract/config/season_tracks.json` (validated by `pnpm contract:check`). A season has a window, `xpPerTier`, `nodXp` and a free and a paid track of at least 10 tiers. Tier `n` needs `n * xpPerTier` Season XP earned inside `[startsAt, endsAt)`.
- A tier reward is one of `cashCents`, `cosmeticId` or `furnitureItemId`. All are off-chain and never tradable; none is an NFT. Cash is ledger reason `season_reward`; a cosmetic is a `cosmetic_inventory` row (source `grant`); furniture is a `player_items` row (no order).
- A claim is a row in `season_tier_claims` (PK `user, season, track, tier`). The row and the reward commit in one transaction, so a tier pays once however many times, or how concurrently, it is claimed.
- The paid track needs a live `season_pass` row (`tier = 'season'`, not expired). The pass is bought with real money through the payment intent flow (`kind: season_pass`: SOL, USDC or SKR); this feature only reads it. The pass is checked when a tier is claimed.
- The client never sends XP or a reward.

## Season XP sources and the PR #9 reconciliation

Season XP is the sum of `season_xp` rows created inside the season window.

| Source              | Writer                         | `source` | `ref`                |
| ------------------- | ------------------------------ | -------- | -------------------- |
| Daily/weekly quests | PR #9 `quests.ts` `claimQuest` | `quest`  | `<period>:<questId>` |
| Nod finds           | this PR `collectNod`           | `nod`    | `<nodId>`            |

PR #9 (migration 084) already creates `season_xp (id, user_id, amount, source, ref, season_iso, created_at, UNIQUE (user_id, source, ref))` and inserts quest XP into it. This PR reads that table by `created_at`, not by `season_iso` (an ISO week), because a season spans several weeks. So once #9 merges, quest XP flows into the tracks with no further change here.

To compile and test on main alone, migration 087 creates `season_xp` with `CREATE TABLE IF NOT EXISTS` in exactly the same shape (and 084's index with `IF NOT EXISTS`).

Merge order:

- #9 first (084 runs, then 087 finds the table and skips it): nothing to do.
- This PR first: 087 creates the table, and 084 must not fail on it. Change 084's `CREATE TABLE season_xp` and `CREATE INDEX season_xp_user_season_idx` to `IF NOT EXISTS` (a two-line edit in #9), and run migrations with `--no-check-order` if 087 is applied before 084.

`awardSeasonXp` in `season-tracks.ts` is the same insert #9 uses, for any later source (shifts, event nods).

## Nods

- Registry: `contract/ids/nods.json`, FE-owned and PLACEHOLDER. Ids are the community-eggs ids; sets group nods; `x`/`z` are provisional grid points inside each nod's district (island metres, `ctl:pos` frame). The frontend replaces the file with the placed prop positions. Set rewards are reward-only cosmetics (`reward_*` keys, hidden from the shop, not buyable).
- `POST /v1/nods/{id}/collect {proof: {nodId, x, z}}`.
- Anti-cheat: the server never trusts the client position. It reads its own last position for the player from the `ctl:pos` presence hash (written by the street, venue and vehicles rooms, which already clamp speed and bounds), requires it to be at most 30 s old, and requires it to be within the nod's radius (15 m default) of the registry position. The client position is only a sanity check. Attempts (hit or miss) are rate limited to 10 burst and 12 a minute per player, so probing nod ids with a spoofed position is slow. Replays of an already-collected nod need no position and pay nothing.
- Limits of this check: it is as strong as the realtime rooms' movement validation. A player who is allowed to be somewhere can collect what is there; teleporting is caught by the rooms, not here.
- A find awards `nodXp` Season XP once (`season_xp` source `nod`). Filling a set grants its cosmetic once (`nod_set_grants` PK `user, set`).
- Hunter board: players ranked by nods found among nods still in the registry; ties go to whoever reached the count first. Computed on read with an indexed aggregate; cache it in Redis if the table grows large.
