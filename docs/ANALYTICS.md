# Analytics (server half)

> Product events for the funnel and the economy, stored in our own Postgres. No third-party
> pipeline, no PII: the internal user id is the only identifier. Backlog item 40 (server half).

## What is recorded

One row in `analytics_events` per event, written **in the same transaction** as the action. An
event exists exactly when the action committed: a rolled-back request, a refused request and an
idempotent replay write nothing.

| Event               | Written when                                                    | `props`                                    | `amount_cents`              |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------ | --------------------------- |
| `signup`            | a wallet signs in for the first time                            | `method` (`siws` / `dev`), `seeker`        |                             |
| `session_start`     | every sign-in (SIWS verify or dev auth)                         | `method`                                   |                             |
| `lottery_rolled`    | the onboarding lottery roll                                     | `outcome`                                  | Cash granted                |
| `character_created` | the character is created                                        | `tribeId`, `likeness`                      |                             |
| `daily_claimed`     | the gm streak chest is claimed                                  | `streakDay`, `reset`                       | Cash paid                   |
| `quest_claimed`     | a quest reward is claimed                                       | `questId`, `period` (`daily` / `weekly`)   | Cash paid                   |
| `shift_paid`        | a work shift pays out                                           | `careerId`, `bonusCents`                   | Cash paid                   |
| `casino_round`      | a Rug Room round settles (slots, coinflip, crash, head-to-head) | `game`, `stakeCents`, `payoutCents`, `pvp` | player net (payout - stake) |
| `shop_order`        | a Duo Shop order is placed                                      | `lines`, `units`                           | total charged               |
| `tip_sent`          | a Cash tip is sent (sender only)                                | `feeCents` (burned)                        | tip amount                  |

The list is closed: the TypeScript union in `server/application/analytics.ts` and the `CHECK` on
`analytics_events.name` (migration 098) must name the same events (a unit test compares them). A
new event needs both, which is deliberate: every new field is a privacy decision.

To add an event from another feature, call `recordEvent(client, userId, event)` with the
transaction's `client`, after the writes it describes. Two open PRs should do this when they land:
the Rekt Burger clock-in (#21) records `shift_paid`, and the onboarding PR (#24) can add a
`first_session_beat` event (new name in the union and the `CHECK`).

## Privacy

- **Identifier:** `user_id` only (a random uuid). No wallet address, alias, X handle, IP, device id,
  location, chat or tip message is ever written. The tip recipient is not recorded.
- **Props:** numbers, booleans and catalogue ids (`^[a-z0-9][a-z0-9_:.-]{0,63}$`). `recordEvent`
  throws on any other value, so a wallet (mixed case base58) or free text cannot slip in.
- **Erasure:** rows are deleted with the user (`ON DELETE CASCADE`).
- **Retention:** the workers delete events older than `ANALYTICS_RETENTION_DAYS` (default 180) every
  day at 03:15 UTC.
- **Off switch:** `ANALYTICS_ENABLED=false` stops the writes; the game actions still run.
- **Who can read it:** whoever has database access (the operators). There is no API for it.

Testers should still be told in the privacy notice that gameplay events are recorded against their
account for balancing; the legal pack (item 41) owns that wording.

## Daily rollups (UTC days)

Plain views, computed on read. They are cheap at tester scale; if they get slow, materialise them.

| View                             | One row per                 | Columns                                                                                                                                                                                                                       |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analytics_daily`                | day, event name             | `events`, `users`, `amount_cents`                                                                                                                                                                                             |
| `analytics_funnel_daily`         | signup cohort day           | `signups`, then how many reached each beat within 24 h of signup (`lottery_24h`, `character_24h`, `daily_claim_24h`, `quest_claim_24h`, `shift_24h`, `casino_24h`, `shop_order_24h`, `tip_24h`), `returned_d1`, `returned_d7` |
| `analytics_economy_daily`        | day, account, ledger reason | `inflow_cents`, `outflow_cents`, `net_cents`, `entries`, `users`                                                                                                                                                              |
| `analytics_economy_totals_daily` | day                         | `faucet_cents`, `sink_cents`, `net_supply_change_cents`, `transferred_cents`                                                                                                                                                  |

The economy views read the Cash ledger (`ledger_entries`), which is the source of truth for every
cent, so faucets and sinks cover every feature, instrumented or not. Player-to-player transfers
(`tip`, `tip_out`, `beef_stake`, `beef_payout`, `beef_stake_refund`) are reported as
`transferred_cents` and left out of faucets and sinks, so a tip only shows its burned fee
(`tip_fee_burn`) as a sink. Head-to-head casino rounds go through the house reasons and count as
faucet and sink.

### Queries

```sql
-- The last 14 days of the economy.
SELECT * FROM analytics_economy_totals_daily ORDER BY day DESC LIMIT 14;

-- Biggest faucets and sinks yesterday.
SELECT reason, inflow_cents, outflow_cents, users
  FROM analytics_economy_daily
 WHERE day = current_date - 1 AND account = 'cash'
 ORDER BY greatest(inflow_cents, outflow_cents) DESC;

-- Funnel per signup day.
SELECT * FROM analytics_funnel_daily ORDER BY cohort_day DESC LIMIT 14;

-- Casino: rounds, players and house take per game, per day.
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, props->>'game' AS game,
       count(*) AS rounds, count(DISTINCT user_id) AS players, -sum(amount_cents) AS house_net_cents
  FROM analytics_events WHERE name = 'casino_round'
 GROUP BY 1, 2 ORDER BY 1 DESC, 2;
```

Run them from any `psql` session on the database (on Railway, the Postgres service's connection URL).

## Cost

One extra `INSERT` inside transactions that already write several rows. In the 300-player load
test ([LOAD-TEST.md](LOAD-TEST.md)) the 9,344 event inserts averaged 0.12 ms each (1.1 s of
Postgres time in 10 minutes). That is about 56,000 rows an hour with 300 busy bots online around
the clock; real testers produce far fewer, and the retention job keeps the table bounded.
