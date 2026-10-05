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
// Server -> client (venue room)
// ---------------------------------------------------------------------------

export const WelcomeMessage = z.object({
  serverNow: z.number().int().nonnegative(),
  instanceId: z.string().min(1),
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
