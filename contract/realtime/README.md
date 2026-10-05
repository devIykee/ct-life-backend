realtime
=======

Colyseus state classes and message schemas for the CT Life realtime protocol. Generated to C# via `schema-codegen contract/realtime/*.ts --output client/Assets/Generated/Realtime --csharp --namespace CTLife.Realtime`.

Files:

| File          | Contents                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `states.ts`   | `PlayerState`, `NpcState`, `VenueState`, `CoinState`, `MarketState`, `CityState`, `HomeState` (`@colyseus/schema`). |
| `messages.ts` | Zod-validated message types and the rate-limit table for `move` / `say` / `emote`.                                  |
| `index.ts`    | Barrel. The codegen runs on this directory.                                                                         |

Every client->server message has a rate limit and a per-room validation. Every server->client message documents the room and the recipient. The `RejectedMessage` enum lists every code a client can be sent.

The hidden arc on a coin is server-only. It is never set on `CoinState`; the server holds it.
