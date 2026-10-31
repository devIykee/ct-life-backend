# Privacy: what we hold, what account deletion erases

Players delete their account in the app (Settings > Delete account), which calls
`DELETE /v1/me` with `{"confirm": "DELETE"}`. There is no grace period: the data below
is erased in one transaction, sessions end immediately, and stored files are removed by
the `account-purge` worker (every 5 minutes, retried until the store confirms).

The `users` row is anonymised in place rather than deleted, because ledger, payment,
casino and factory rows reference it with `ON DELETE RESTRICT` and have to survive.
After deletion it holds only a random UUID, `wallet = 'deleted:<uuid>'` and `deleted_at`.
The same wallet signing in again creates a different, empty account.

## Erased

| Data                                                                    | Where                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet address link, `.skr` name, Seeker/SGT mint                       | `users` (cleared)                                                                                                                                                            |
| Character: alias, look, tribe, traits, likeness job link                | `characters`                                                                                                                                                                 |
| Face photo, upload sessions, generated avatar models, provider attempts | `likeness_uploads`, `likeness_upload_sessions`, `likeness_jobs`, `likeness_selections`, `likeness_provider_attempts`, `likeness_action_receipts`; files in the private store |
| X account link (handle, avatar URL, token hashes)                       | `x_links`                                                                                                                                                                    |
| Push tokens and preferences, push log                                   | `push_devices`, `push_prefs`, `push_log`                                                                                                                                     |
| Follows and blocks (both directions)                                    | `follows`, `blocks`                                                                                                                                                          |
| Creator profile and its images                                          | `creator_profiles`; files in the ads bucket                                                                                                                                  |
| Ad creatives the player uploaded and never booked                       | `ad_uploads`; files in the ads bucket                                                                                                                                        |
| Voice-room speaker rows                                                 | `voice_speakers`                                                                                                                                                             |
| Real Markets order records; 18+ confirmation audit (time, app version)  | `real_market_orders`, `age_confirmations`                                                                                                                                    |

## Overwritten

| Data                 | Becomes                                                      |
| -------------------- | ------------------------------------------------------------ |
| DMs the player wrote | text `[deleted]` (the other person keeps their own messages) |
| Feed posts           | text `[deleted]`, meta cleared                               |
| Alias on tombstones  | `Deleted player`                                             |

## Retained, keyed to the anonymous id

| Data                                                                                                                      | Why                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ledger_entries`, `payment_intents`, likeness entitlements and payment intents, `tips`, `paid_call_escrow`, `shop_orders` | Financial records and audit. A payer wallet appears in on-chain payments, which are public regardless.      |
| Casino, market, perps, positions, predictions, factory, beef, gigs, quests, season and progress rows                      | Game history and fairness audit; they carry no name, wallet or contact data once the account is anonymised. |
| `reports` filed by or about the player                                                                                    | Safety: moderators still need the record.                                                                   |
| Ad bookings and the creative they use                                                                                     | The advertiser paid for a live slot; the booking runs out its term.                                         |
| `account_deletions` (id and time)                                                                                         | Proof the request was honoured.                                                                             |

Cash is not refunded and cannot be recovered. Open obligations (a head-to-head challenge
the player opened, an escrow) settle through their normal expiry.

## Logs

See "Logs" below once the log-privacy change lands.
