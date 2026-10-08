/**
 * Phase 4-6 realtime additions — FE proposal against main @ 9f3e5ef.
 *
 * Written to drop into `contract/realtime/` as a new file (for example
 * `phase4-6.ts`) and be re-exported from `index.ts`. It only adds: new
 * schema classes, new Zod message types, and two lists of enum values to
 * append to existing enums. Nothing existing is renamed, removed or
 * retyped.
 *
 * Conventions copied from `messages.ts` / `states.ts`:
 *   - one `export const <Name>Message = z.object(...)` per message; the
 *     wire type is the snake_case of `<Name>` (checked by
 *     tools/contract-check/realtime-vs-readme.ts), e.g. `BeefUpdateMessage`
 *     is sent as `beef_update`;
 *   - Cash is `z.number().int()` cents, times are epoch ms (`at`);
 *   - ids are strings; ids that come from a registry are documented with
 *     the registry name.
 *
 * Every message below is server -> client. Phase 4-6 player actions go
 * through REST (idempotent and auditable); no new client -> server message
 * is proposed.
 */
import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import { z } from 'zod';
import { PlayerState } from './states';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** One placed furniture instance. Keyed by `anchorId` in HomeDecorState. */
export class FurnitureState extends Schema {
  @type('string') instanceId = '';
  /** furniture.json id */
  @type('string') furnitureId = '';
  /** FE-owned spot id, e.g. home_hacker_house.desk_1 */
  @type('string') anchorId = '';
  /** Quarter turns, 0..3 */
  @type('int8') rotIndex = 0;
}

/**
 * Decoration shared by homes and project HQs. Proposed edit to the
 * existing `HomeState` in states.ts (append one field, after `players`):
 *
 *   @type(HomeDecorState) decor = new HomeDecorState();
 *
 * `HomeState` has no room on main @ 9f3e5ef yet (no `home` room is
 * defined in server/realtime/main.ts), so no client decodes it today.
 */
export class HomeDecorState extends Schema {
  /** open | followers | closed */
  @type('string') visitPolicy = 'followers';
  @type({ map: FurnitureState }) furniture = new MapSchema<FurnitureState>();
  /** Up to 12 asset addresses; images come from GET /nft/gallery?userId=ownerId */
  @type(['string']) galleryAssetAddresses = new ArraySchema<string>();
}

/**
 * `project_hq` room: one per project HQ, created on visit, max 12
 * clients, 10 Hz, joined with `client.joinById(roomId, { token })` using
 * the RoomTicket from POST /projects/{id}/hq/visit.
 */
export class HqState extends Schema {
  @type('string') projectId = '';
  @type('string') projectName = '';
  @type('string') ownerId = '';
  /** founded | launching | live | paused | rugged | dead */
  @type('string') projectStatus = 'founded';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type(HomeDecorState) decor = new HomeDecorState();
}

// ---------------------------------------------------------------------------
// Server -> client (city room, one player) — Phase 4
// ---------------------------------------------------------------------------

/** A business day rolled by a worker (or a business closed for unpaid upkeep). */
export const BusinessDayMessage = z.object({
  businessId: z.string().min(1),
  dayKind: z.enum(['normal', 'bad_day', 'great_day', 'closed']),
  payCents: z.number().int(),
  /** business_events.json id */
  eventId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type BusinessDayMessage = z.infer<typeof BusinessDayMessage>;

/** Rent collected or missed by the Monday rent worker. */
export const RentUpdateMessage = z.object({
  homeId: z.string().min(1),
  status: z.enum(['paid', 'missed']),
  amountCents: z.number().int().nonnegative(),
  overdueCents: z.number().int().nonnegative(),
  nextDueAt: z.number().int().nonnegative(),
});
export type RentUpdateMessage = z.infer<typeof RentUpdateMessage>;

/** Someone entered my home (owner only; never sent for blocked users). */
export const HomeVisitMessage = z.object({
  visitorUserId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type HomeVisitMessage = z.infer<typeof HomeVisitMessage>;

/** NFT purchase progress after a cosmetic intent confirms. Mirrors GET /nft/orders/{intentId}. */
export const NftOrderUpdateMessage = z.object({
  intentId: z.string().min(1),
  sku: z.string().min(1),
  status: z.enum(['paid', 'minting', 'minted', 'failed', 'refunded']),
  assetAddress: z.string().min(1).optional(),
  cluster: z.enum(['devnet', 'mainnet']),
  at: z.number().int().nonnegative(),
});
export type NftOrderUpdateMessage = z.infer<typeof NftOrderUpdateMessage>;

/** Season pass weekly perk credited by Sunday Unlock. */
export const PassPerkMessage = z.object({
  weekIso: z.string().min(1),
  perkCents: z.number().int().nonnegative(),
});
export type PassPerkMessage = z.infer<typeof PassPerkMessage>;

// ---------------------------------------------------------------------------
// Server -> client (city room, everyone) — Phase 4
// ---------------------------------------------------------------------------

/** Sun 20:00 UTC. Clients fetch GET /me/weekly-recap for the share card. */
export const SundayUnlockMessage = z.object({
  weekIso: z.string().min(1),
  metaId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type SundayUnlockMessage = z.infer<typeof SundayUnlockMessage>;

// ---------------------------------------------------------------------------
// Server -> client — Phase 5 (ads, projects)
// ---------------------------------------------------------------------------

/** City, booker only: booking moved state (approved, live, rejected, refunded...). */
export const AdBookingUpdateMessage = z.object({
  bookingId: z.string().min(1),
  status: z.enum([
    'pending_review',
    'scheduled',
    'live',
    'expired',
    'rejected',
    'cancelled',
    'refunded',
  ]),
  /** ad_rejection_reasons.json id when rejected */
  reasonId: z.string().min(1).optional(),
});
export type AdBookingUpdateMessage = z.infer<typeof AdBookingUpdateMessage>;

/** City, everyone: these slots changed; refetch GET /ads/live now instead of waiting for the 5 min cache. */
export const AdsChangedMessage = z.object({
  slotIds: z.array(z.string().min(1)).min(1),
});
export type AdsChangedMessage = z.infer<typeof AdsChangedMessage>;

/** City, invitee only. */
export const HireOfferMessage = z.object({
  offerId: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  fromUserId: z.string().min(1),
  role: z.enum(['dev', 'mod', 'kol', 'auditor']),
  salaryCentsPerWeek: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative(),
});
export type HireOfferMessage = z.infer<typeof HireOfferMessage>;

/** City, every project member (and the HQ room). Server-rolled risk or lifecycle event. */
export const ProjectEventMessage = z.object({
  projectId: z.string().min(1),
  /** project_events.json id */
  eventId: z.string().min(1),
  cashDeltaCents: z.number().int(),
  params: z.record(z.string(), z.string()).optional(),
  at: z.number().int().nonnegative(),
});
export type ProjectEventMessage = z.infer<typeof ProjectEventMessage>;

/** City, founder only: a VC Row NPC sent a term sheet. */
export const VcOfferMessage = z.object({
  offerId: z.string().min(1),
  projectId: z.string().min(1),
  /** archetypes.json id (vc) */
  vcArchetypeId: z.string().min(1),
  investCents: z.number().int().positive(),
  equityBps: z.number().int().min(1).max(10_000),
  expiresAt: z.number().int().nonnegative(),
});
export type VcOfferMessage = z.infer<typeof VcOfferMessage>;

// ---------------------------------------------------------------------------
// Server -> client — Phase 6 (competition)
// ---------------------------------------------------------------------------

/** City, everyone: a district changed hands at the daily rollover. */
export const DistrictFlippedMessage = z.object({
  /** districts.json id */
  districtId: z.string().min(1),
  tribeId: z.string().min(1),
  previousTribeId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type DistrictFlippedMessage = z.infer<typeof DistrictFlippedMessage>;

/** City, everyone: leagues were reassigned. */
export const SeasonRolloverMessage = z.object({
  seasonId: z.string().min(1),
  previousSeasonId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type SeasonRolloverMessage = z.infer<typeof SeasonRolloverMessage>;

/** City, one player: where the rollover put me. */
export const LeagueResultMessage = z.object({
  seasonId: z.string().min(1),
  fromLeagueId: z.string().min(1),
  toLeagueId: z.string().min(1),
  rank: z.number().int().positive(),
  outcome: z.enum(['promoted', 'relegated', 'stayed']),
});
export type LeagueResultMessage = z.infer<typeof LeagueResultMessage>;

/** City, invited player only. */
export const BeefChallengeMessage = z.object({
  matchId: z.string().min(1),
  fromUserId: z.string().min(1),
  /** beef_topics.json id */
  topicId: z.string().min(1),
  stakeCents: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative(),
});
export type BeefChallengeMessage = z.infer<typeof BeefChallengeMessage>;

/**
 * Phase change of a beef. Sent on the city room to both participants and
 * broadcast on every `venue` instance of `ratio_arena`. No vote counts
 * until `beef_result`.
 */
export const BeefUpdateMessage = z.object({
  matchId: z.string().min(1),
  status: z.enum(['open', 'active', 'voting', 'closed', 'declined', 'cancelled', 'expired']),
  challengerUserId: z.string().min(1),
  accepterUserId: z.string().min(1).optional(),
  phaseEndsAt: z.number().int().nonnegative().optional(),
});
export type BeefUpdateMessage = z.infer<typeof BeefUpdateMessage>;

/** Same recipients as beef_update. `winnerUserId` is absent on a draw. */
export const BeefResultMessage = z.object({
  matchId: z.string().min(1),
  winnerUserId: z.string().min(1).optional(),
  votesChallenger: z.number().int().nonnegative(),
  votesAccepter: z.number().int().nonnegative(),
  eloDeltaChallenger: z.number().int(),
  eloDeltaAccepter: z.number().int(),
  payoutCents: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});
export type BeefResultMessage = z.infer<typeof BeefResultMessage>;

/**
 * City, one player: jailed or released. When jailed while inside a venue
 * the player is also sent `kicked { reasonId: 'sybil_jailed' }` and may
 * only join `sybil_barn` until released.
 */
export const SybilStatusMessage = z.object({
  jailed: z.boolean(),
  /** sybil_reasons.json id */
  reasonId: z.string().min(1).optional(),
  releaseAt: z.number().int().nonnegative().optional(),
});
export type SybilStatusMessage = z.infer<typeof SybilStatusMessage>;

/** City, guest only. */
export const CabalInviteMessage = z.object({
  inviteId: z.string().min(1),
  fromUserId: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type CabalInviteMessage = z.infer<typeof CabalInviteMessage>;

/** City, one player: outcome of the X OAuth round trip (the app is in the background during it). */
export const XLinkUpdateMessage = z.object({
  status: z.enum(['linked', 'unlinked', 'failed']),
  /** without @ */
  handle: z.string().min(1).max(32).optional(),
  /** e.g. access_denied, X_ACCOUNT_ALREADY_LINKED */
  reasonId: z.string().min(1).optional(),
});
export type XLinkUpdateMessage = z.infer<typeof XLinkUpdateMessage>;

// ---------------------------------------------------------------------------
// Server -> client — Phase 2 (Smart Money copy trading)
// ---------------------------------------------------------------------------

/** City, copier only: a copy was placed or skipped. */
export const CopyTradeMessage = z.object({
  subscriptionId: z.string().min(1),
  traderId: z.string().min(1),
  coinId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  status: z.enum(['executed', 'skipped']),
  cashCents: z.number().int().nonnegative(),
  reasonId: z
    .enum(['budget_exhausted', 'insufficient_cash', 'slippage_exceeded', 'coin_dead', 'no_position'])
    .optional(),
  at: z.number().int().nonnegative(),
});
export type CopyTradeMessage = z.infer<typeof CopyTradeMessage>;

// ---------------------------------------------------------------------------
// Values to append to existing enums in messages.ts (additive)
// ---------------------------------------------------------------------------

/** Append to `EventMessage.eventId`'s z.enum (and to ids/events.json). */
export const EVENT_ID_ADDITIONS = [
  'evt_sunday_unlock',
  'evt_meta_rotated',
  'evt_project_launch',
  'evt_project_exploit',
  'evt_project_rug_accusation',
  'evt_vc_dump',
  'evt_district_flip',
  'evt_beef_result',
  'evt_season_rollover',
  'evt_sybil_sweep',
  'evt_conference_week',
] as const;

/**
 * Append to `RejectedMessage.code`'s z.enum. The first five are already
 * sent by server/realtime/rooms/venue.ts on main. The last three are the
 * codes a gated room's `onAuth` fails the join with (dubai_marina,
 * cabal_lounge, sybil_barn), matching GET /venues/{venueId}/access.
 */
export const REJECTED_CODE_ADDITIONS = [
  'SPEED_EXCEEDED',
  'OUT_OF_BOUNDS',
  'SPOT_NOT_FOUND',
  'NPC_NOT_FOUND',
  'UNKNOWN_EMOTE',
  'NET_WORTH_TOO_LOW',
  'INVITE_REQUIRED',
  'SYBIL_JAILED',
] as const;

/** Room-level additions, for docs/REALTIME.md's room table. */
export const ROOM_ADDITIONS = {
  project_hq: { phase: 5, onePer: 'project HQ, created on visit', maxClients: 12, patchHz: 10, state: 'HqState' },
} as const;
