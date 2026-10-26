# Group chats and alpha groups

> Backend for board `groupchats-22` (approved 2026-10-26): groups live inside Messages, free and
> invite-only, caps 12/50/200, booths, invite links that never reward posting, voice later.
> Migration 103. Code: `server/application/groups.ts`, routes `server/api/routes/groups.ts`.

## Kinds

| Kind      | Who creates                    | Cap | Topics                  | Joining                          |
| --------- | ------------------------------ | --- | ----------------------- | -------------------------------- |
| `friends` | any player (owner)             | 12  | `chat`                  | invite link or direct invite     |
| `alpha`   | any player (the caller, owner) | 50  | `calls`, `chat`, `wins` | invite link or direct invite     |
| `tribe`   | automatic, per tribe           | 200 | `chat`                  | joined when you list your groups |

[Inference] The caps 12 / 50 / 200 are read as friends / alpha / tribe, in the order the decision
listed the kinds. They are one constant (`GROUP_CAPS`) if that reading is wrong.

There is **no entry fee and nothing is ever paid** for joining, inviting or posting a link: Cash is
non-transferable and the X rule (no reward for posting) applies. A player owns at most 5 groups.

## Contract for the client

All routes need auth; writes need `Idempotency-Key`. A group you are not in answers `404` (the id
leaks nothing). A hidden group (reported) answers `403 FORBIDDEN reason: group_hidden`.

| Route                                               | What                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/groups`                                    | `{groups: GroupSummary[]}` newest activity first, unread (max 99), muted, last message preview, booth                                             |
| `POST /v1/groups {kind, name, inviteUserIds?}`      | 201 `GroupSummary`; invitees get direct invites                                                                                                   |
| `GET /v1/groups/invites`                            | `{invites: GroupInvitePreview[]}`: the Invites list (kept apart like message requests)                                                            |
| `GET /v1/groups/:id`                                | `GroupInfo`: rules, topics, slow mode, owner, `trust` (alpha), booth, `hereWithYou`, muted                                                        |
| `PATCH /v1/groups/:id {name?, rules?, slowMode?}`   | owner renames; owner or mod sets rules and `slowMode {topic: seconds 0..300}`                                                                     |
| `GET /v1/groups/:id/members`                        | `{members: [{userId, alias, role, joinedAt}]}`                                                                                                    |
| `POST /v1/groups/:id/members/:userId/remove`        | owner or mod; mods cannot remove the owner or mods; the player is banned from rejoining                                                           |
| `POST /v1/groups/:id/members/:userId/role {role}`   | owner: `mod` or `member`                                                                                                                          |
| `POST /v1/groups/:id/leave`                         | owner hands over (oldest mod, else oldest member); last one out deletes; tribe chats cannot be left (mute)                                        |
| `POST /v1/groups/:id/mute {hours}`                  | `{mutedUntil}`; 0 unmutes. Muted = unread dot, no banner                                                                                          |
| `POST /v1/groups/:id/read`                          | clears unread                                                                                                                                     |
| `POST /v1/groups/:id/report {reasonId, note?}`      | `report_reasons.json` ids; once per player; 3 different reporters hide the group                                                                  |
| `POST /v1/groups/:id/invites {maxUses?, ttlHours?}` | 201 `{code, deepLink: "ctlife://invite/<code>", expiresAt, maxUses, uses}`. Friends: any member; alpha: owner or mod; tribe: none                 |
| `POST /v1/groups/:id/invites/user {userId}`         | direct invite (realtime `group_invite`); blocked either way = `403 BLOCKED`                                                                       |
| `GET /v1/invites/:code`                             | `GroupInvitePreview {groupName, kind, memberCount, memberCap, from, owner, trust, valid, ...}`                                                    |
| `POST /v1/invites/:code/accept`                     | joins; atomic (cap and max uses hold under concurrent joins). `409 CONFLICT group_full`, `403 invite_expired / removed_from_group / group_hidden` |
| `POST /v1/invites/:code/decline`                    | direct invites only                                                                                                                               |
| `GET /v1/groups/:id/messages?topic=&before=`        | `{messages: GroupMessage[], nextBefore}` newest first, 50 a page; authors you blocked are left out                                                |
| `POST /v1/groups/:id/messages`                      | see below                                                                                                                                         |
| `DELETE /v1/groups/:id/messages/:messageId`         | author, owner or mod                                                                                                                              |
| `GET /v1/venues/:venueId/booths`                    | `{booths: [{venueId, boothId, group: {groupId, name, memberCount, here}                                                                           | null}]}` |
| `POST /v1/groups/:id/booth {venueId, boothId}`      | alpha owner; one booth per group (claiming another moves it); `409 booth_taken`                                                                   |
| `DELETE /v1/groups/:id/booth`                       | owner                                                                                                                                             |

### Posting

- `{topic: "chat", text}`: any member. Friends and tribe groups only have `chat`.
- `{topic: "calls", coinId, targetX, stopPct, text?}`: **alpha groups, owner only**
  (`403 calls_owner_only`). The server takes the coin's current price as the entry, computes
  target (`entry x targetX`, 1.05..100) and stop (`entry x (1 - stopPct/100)`, 1..95), and creates
  a real alpha call (`POST /alpha-calls` path), so the existing evaluator grades it and it counts in
  the caller's Trust score. Nobody can fake a win.
- `{topic: "wins", coinId, text?}`: alpha groups; the author must have realized profit on that coin
  (`positions.realized_cents > 0`), else `400`.

Text: links, e-mails, phone numbers and wallet addresses are masked (`[link]`, `[hidden]`,
`[phone]`, `[wallet]`). Limits: slow mode per topic (`429 RATE_LIMITED`,
`details.slowModeSeconds`; owner and mods exempt) and a per-player burst of 10 messages, then one a
second.

`GroupMessage {messageId, groupId, topic, authorUserId, authorAlias, text, card, at}`, where
`card` is:

- `{type: "call", callId, coinId, ticker, entryMicros, targetMicros, stopMicros, status, priceMicros,
deepLink: "ctlife://coin/<coinId>"}`: `status` (`open`, `hit_target`, `hit_stop`, `expired`) and
  `priceMicros` are read live, so the "now +18%" bar and the HIT / STOPPED badge come from the
  server.
- `{type: "pnl", coinId, ticker, realizedCents, deepLink}`.

### Realtime

Over the existing per-user bus (the `city` room, like `dm`):

- `group_msg {messageId, groupId, groupName, kind, topic, authorUserId, authorAlias, text, card, at,
muted}` to every member but the author and anyone who blocked the author. `muted: true`: unread
  dot, no banner. The board's rule: banners for calls and mentions only.
- `group_invite {code, groupId, groupName, fromUserId, at}`.

### Place-aware

- `GroupInfo.hereWithYou`: members within 60 m of you now, from the server's position hash (the
  "6 members · 2 here" header).
- Booths: `cabal_lounge` `booth_1`..`booth_6`, `discord_heights` doors `general`, `alpha_maybe`,
  `gm`, `wen_token`, `support_ticket`, `memes`. `GET /v1/venues/:venueId/booths` gives each booth's
  group and `here` (members within 60 m of the venue door) for the venue board ("FROG CALLS · 6
  here"). Group tags over heads are client-side (members of your own groups only).

## Safety

- Same masking as above on messages, rules and report notes; group names go through the Factory name
  filter (`NAME_NOT_ALLOWED`).
- Blocks: a blocked author's messages are not delivered or listed to the blocker; blocked pairs cannot
  invite each other.
- Report, leave, mute, delete; owner and mods remove (with a ban) and set slow mode. Three distinct
  reporters hide a group for everyone (server-side; unhide by clearing `groups.hidden_at`).
- Tribe chats have no owner or mods yet: members can mute, block and report.
- [Unverified] The profanity filter from the moderation PR (#30) is not on main yet; once it lands,
  `cleanChatText` should also run its free-text check (one line in `groups.ts`).

## Not built (later)

Voice rooms (board D6: later), share-out links on the website (D5 needs the site to open
`ctlife://invite/<code>`), per-topic mentions.
