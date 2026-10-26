/**
 * Message types for the CT Life realtime protocol.
 *
 * Every client->server and server->client message has a Zod schema. The
 * server-side message handler validates with the same schema, so the
 * contract and the implementation are the same code.
 *
 * The TypeScript type for each message is exported alongside the schema
 * so the rest of the backend (Colyseus rooms, REST proxies, the
 * contract-check tool) imports one source of truth.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Client -> server (venue room)
// ---------------------------------------------------------------------------

export const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite(),
  /** Venue rooms: true when x/z/rotY are island coordinates (converted by the server). */
  island: z.boolean().optional(),
});
export type MoveMessage = z.infer<typeof MoveMessage>;

export const SitMessage = z.object({ spotId: z.string().min(1) });
export type SitMessage = z.infer<typeof SitMessage>;

export const StandMessage = z.object({}).strict();
export type StandMessage = z.infer<typeof StandMessage>;

export const EmoteMessage = z.object({ emoteId: z.string().min(1) });
export type EmoteMessage = z.infer<typeof EmoteMessage>;

export const SayMessage = z.object({
  text: z.string().min(1).max(140),
});
export type SayMessage = z.infer<typeof SayMessage>;

export const TalkingMessage = z.object({ on: z.boolean() });
export type TalkingMessage = z.infer<typeof TalkingMessage>;

export const NpcTapMessage = z.object({ npcId: z.string().min(1) });
export type NpcTapMessage = z.infer<typeof NpcTapMessage>;

// ---------------------------------------------------------------------------
// Client -> server (vehicles room). Island metres, radians, m/s.
// ---------------------------------------------------------------------------

export const VEHICLE_KINDS = [
  'compact',
  'suv',
  'sports',
  'moped',
  'roadstar',
  'heli',
  'drone',
  'sedan',
  'taxi',
  'police',
  'pickup',
  'van',
  'bike',
] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** Server speed cap per vehicle kind, m/s. */
export const VEHICLE_MAX_SPEED_M_PER_S: Record<VehicleKind, number> = {
  compact: 60,
  suv: 60,
  sports: 60,
  moped: 25,
  roadstar: 70,
  heli: 60,
  drone: 20,
  sedan: 60,
  taxi: 60,
  police: 60,
  pickup: 60,
  van: 60,
  bike: 25,
};

/** Highest a vehicle may fly, island metres. */
export const VEHICLE_MAX_Y_M = 214;

/**
 * Take the wheel. `kind` and the pose are only read when the server does
 * not know `id` yet (a client-parked car): the server then registers it
 * where the client says, which must be within 4 m of the player.
 */
export const VehicleEnterMessage = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(VEHICLE_KINDS).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  z: z.number().finite().optional(),
  yaw: z.number().finite().optional(),
  /**
   * Take a vehicle that is not yours: an NPC traffic car (id `traffic_*`) or another
   * player's parked vehicle. Adds heat; never transfers ownership; never the roadstar.
   */
  steal: z.boolean().optional(),
});
export type VehicleEnterMessage = z.infer<typeof VehicleEnterMessage>;

export const VehicleMoveMessage = z.object({
  id: z.string().min(1).max(64),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  roll: z.number().finite(),
  speed: z.number().finite().nonnegative(),
  flags: z.number().int().min(0).max(65535).optional(),
});
export type VehicleMoveMessage = z.infer<typeof VehicleMoveMessage>;

/** Leave the vehicle; x/z/yaw are its final parked pose. */
export const VehicleExitMessage = z.object({
  id: z.string().min(1).max(64),
  x: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
});
export type VehicleExitMessage = z.infer<typeof VehicleExitMessage>;

/** A driver hit a player. `victim` is the victim's userId. */
export const VehicleHitMessage = z.object({
  victim: z.string().min(1),
  velocity: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
});
export type VehicleHitMessage = z.infer<typeof VehicleHitMessage>;

// ---------------------------------------------------------------------------
// Server -> client (venue, street and vehicles rooms)
// ---------------------------------------------------------------------------

/** A move went past the speed budget; the server applied this position instead. */
export const CorrectedMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  /** Set when the position is in island coordinates (the move was sent with `island: true`). */
  island: z.boolean().optional(),
});
export type CorrectedMessage = z.infer<typeof CorrectedMessage>;

/** Same as `corrected`, for the driver of a vehicle. */
export const VehicleCorrectedMessage = z.object({
  id: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type VehicleCorrectedMessage = z.infer<typeof VehicleCorrectedMessage>;

/** Relayed to the victim only, who ragdolls on their own client. */
export const VehicleHitRelayMessage = z.object({
  victim: z.string().min(1),
  velocity: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
  by: z.string().min(1),
  vehicleId: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type VehicleHitRelayMessage = z.infer<typeof VehicleHitRelayMessage>;

// ---------------------------------------------------------------------------
// Server -> client (venue room)
// ---------------------------------------------------------------------------

export const WelcomeMessage = z.object({
  serverNow: z.number().int().nonnegative(),
  instanceId: z.string().min(1),
  /** Venue rooms placed on CT Island: where the venue's local frame sits. */
  island: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
      yaw: z.number().finite(),
    })
    .optional(),
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;

export const SaidMessage = z.object({
  messageId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string().min(1).max(140),
  at: z.number().int().nonnegative(),
});
export type SaidMessage = z.infer<typeof SaidMessage>;

export const ToastMessage = z.object({
  textId: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
});
export type ToastMessage = z.infer<typeof ToastMessage>;

export const RejectedMessage = z.object({
  type: z.string().min(1),
  code: z.enum([
    'NONCE_INVALID',
    'SIGNATURE_INVALID',
    'TOKEN_EXPIRED',
    'SGT_ALREADY_LINKED',
    'ALIAS_TAKEN',
    'ALREADY_ROLLED',
    'CLIENT_OUTDATED',
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'FORBIDDEN',
    'BLOCKED',
    'RATE_LIMITED',
    'ACCOUNT_MUTED',
    'INSUFFICIENT_CASH',
    'LEVERAGE_NOT_ALLOWED',
    'SLIPPAGE_EXCEEDED',
    'SHIFT_NOT_FINISHED',
    'VENUE_FULL',
    'SPOT_TAKEN',
    'NOT_SPACE_HOST',
    'TOPUP_CAP_REACHED',
    'PAYMENT_EXPIRED',
    'PAYMENT_UNDERPAID',
    'SERVER_BUSY',
    'OUT_OF_BOUNDS',
    'UNKNOWN_EMOTE',
    'SPOT_NOT_FOUND',
    'NPC_NOT_FOUND',
    'VEHICLE_TAKEN',
    'VEHICLE_TOO_FAR',
    'VEHICLE_LIMIT',
    'NOT_DRIVER',
    'ALREADY_DRIVING',
    'POSITION_UNKNOWN',
    'NOT_ENTITLED',
    'JAILED',
    'VEHICLE_NOT_STEALABLE',
    'STEAL_REQUIRED',
  ]),
});
export type RejectedMessage = z.infer<typeof RejectedMessage>;

// ---------------------------------------------------------------------------
// Server -> client (city room)
// ---------------------------------------------------------------------------

export const EventMessage = z.object({
  eventId: z.enum([
    'evt_liquidation',
    'evt_rug',
    'evt_coin_launch',
    'evt_mood_change',
    'evt_exploit',
    'evt_ore_motherlode',
  ]),
  params: z.record(z.string(), z.string()).optional(),
  at: z.number().int().nonnegative(),
});
export type EventMessage = z.infer<typeof EventMessage>;

export const LiquidatedMessage = z.object({
  perpId: z.string().min(1),
  coinId: z.string().min(1),
  lossCents: z.number().int(),
  at: z.number().int().nonnegative(),
});
export type LiquidatedMessage = z.infer<typeof LiquidatedMessage>;

export const PaymentConfirmedMessage = z.object({
  intentId: z.string().min(1),
  cashCents: z.number().int(),
});
export type PaymentConfirmedMessage = z.infer<typeof PaymentConfirmedMessage>;

export const SpaceUpdateMessage = z.object({ spaceId: z.string().min(1) });
export type SpaceUpdateMessage = z.infer<typeof SpaceUpdateMessage>;

export const DmMessage = z.object({
  messageId: z.string().min(1),
  fromUserId: z.string().min(1),
  text: z.string().min(1).max(500),
  at: z.number().int().nonnegative(),
});
export type DmMessage = z.infer<typeof DmMessage>;

/** Duo Shop: the courier leaves, about 60 s before `etaAt` (epoch ms). `unitId` is null for a locker. */
export const DeliveryOutMessage = z.object({
  orderId: z.string().uuid(),
  destination: z.enum(['door', 'locker']),
  unitId: z.string().min(1).nullable(),
  etaAt: z.number().int().nonnegative(),
});
export type DeliveryOutMessage = z.infer<typeof DeliveryOutMessage>;

/** Duo Shop: the parcel is there and the items are in the player's inventory. */
export const DeliveryArrivedMessage = z.object({
  orderId: z.string().uuid(),
  destination: z.enum(['door', 'locker']),
  unitId: z.string().min(1).nullable(),
});
export type DeliveryArrivedMessage = z.infer<typeof DeliveryArrivedMessage>;

export const CallInviteMessage = z.object({
  callId: z.string().min(1),
  fromUserId: z.string().min(1),
  paid: z.boolean(),
});
export type CallInviteMessage = z.infer<typeof CallInviteMessage>;

export const KickedMessage = z.object({ reasonId: z.string().min(1) });
export type KickedMessage = z.infer<typeof KickedMessage>;

// ---------------------------------------------------------------------------
// Server -> client (market room)
// ---------------------------------------------------------------------------

export const TapeMessage = z.object({
  coinId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  cashCents: z.number().int(),
  name: z.string().min(1),
});
export type TapeMessage = z.infer<typeof TapeMessage>;

// ---------------------------------------------------------------------------
// Limits (enforced in the room handler)
// ---------------------------------------------------------------------------

export const RATE_LIMITS = {
  move: { perSecond: 10 },
  say: { perMs: 2000 },
  emote: { perSecond: 1 },
} as const;
