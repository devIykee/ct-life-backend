/**
 * LLM NPC chat (M7 #8: AI Agent + Sleuth).
 *
 * Endpoints:
 *
 *   POST /v1/llm/chat
 *     body: { archetype: 'ai_agent' | 'sleuth', message: string }
 *     — chat with the LLM-powered NPC. The response is
 *     filtered (no PII, no links, no profanity) before
 *     returning.
 *
 * The feature is gated by `LLM_NPCS_ENABLED` (server config).
 * When off, the route returns 503. When on, the call goes
 * through the LLM client (Anthropic API in production; a
 * deterministic stub in dev/tests).
 *
 * Per-player rate limit: 5 messages per minute (Redis token
 * bucket). The application is the only writer of
 * `llm_npc_interactions`; the response is filtered before
 * storage and the unfiltered model output is never persisted.
 *
 * The system prompt includes the player-facing rules (no PII,
 * no real-person impersonation, no real-token airdrops, no
 * real-money payout) and is built server-side. The user
 * message goes through the chat filter + the prompt-injection
 * detector before reaching the model.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { chatFilter, detectPromptInjection } from './llm-filter.js';
import type { AppContext } from './context.js';

export type LlmArchetype = 'ai_agent' | 'sleuth';

export interface LlmChatInput {
  readonly userId: string;
  readonly archetype: LlmArchetype;
  readonly message: string;
}

export interface LlmChatResult {
  /** The stored interaction id; the client reports a reply with it (`npc_reply`). */
  readonly replyId: string;
  readonly archetype: LlmArchetype;
  readonly response: string;
  readonly filtered: boolean;
  readonly refused: boolean;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly refusalReason?: string;
}

interface LlmInteractionDbRow {
  interaction_id: string;
  user_id: string;
  archetype: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  filtered: boolean;
  refused: boolean;
  response_text: string;
  created_at: Date;
}

/** LLM client interface. The production implementation hits
 *  Anthropic; tests inject a stub. */
export interface LlmClient {
  complete(params: {
    system: string;
    user: string;
    model: string;
  }): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

const RATE_LIMIT_PER_MIN = 5;
const RATE_LIMIT_PER_DAY = 50;
const RATE_LIMIT_REFUSAL = "You're sending too many messages. Try again in a minute.";

/** System prompt for the LLM NPC. The hard rules are server-side
 *  and apply regardless of what the user types. */
export function systemPrompt(archetype: LlmArchetype): string {
  const base = [
    'You are an in-game NPC in CT Life, a 3D multiplayer Crypto Twitter life-sim on Solana.',
    'You must NEVER: impersonate a real person, share real personal information (PII) about real people,',
    '   share wallet addresses, phone numbers, or email addresses, link to external URLs,',
    '   promise real money, real tokens, or real airdrops, or use profanity.',
    'Speak as a CT-influencer persona; keep responses under 200 words; never break character.',
  ].join(' ');
  const persona =
    archetype === 'ai_agent'
      ? 'You are AI Agent: a slightly cocky, always-on-the-bleeding-edge degen who tracks new launches.'
      : 'You are a Police detective: a methodical, evidence-first investigator who tracks wallet flows and on-chain forensics.';
  return `${persona}\n\n${base}`;
}

/** Per-user rate limit. The bucket is keyed by
 *  `llm:rl:${userId}:${minute}` and expires after 90s. */
async function takeRateLimitToken(ctx: AppContext, userId: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `llm:rl:${userId}:${minute}`;
  const r = await ctx.redis.main.incr(key);
  if (r === 1) {
    await ctx.redis.main.expire(key, 90);
  }
  if (r > RATE_LIMIT_PER_MIN) return false;
  // Daily ceiling as well, so GET /v1/llm/quota reports a limit that is
  // actually enforced rather than an advisory number.
  const dayKey = `llm:rl:day:${userId}:${new Date().toISOString().slice(0, 10)}`;
  const d = await ctx.redis.main.incr(dayKey);
  if (d === 1) {
    await ctx.redis.main.expire(dayKey, 60 * 60 * 26);
  }
  return d <= RATE_LIMIT_PER_DAY;
}

export interface LlmQuotaRow {
  readonly perMinuteLimit: number;
  readonly remainingThisMinute: number;
  readonly perDayLimit: number;
  readonly remainingToday: number;
  readonly resetsAt: string;
}

/**
 * The caller's remaining LLM chat quota.
 *
 * Reads the same Redis counters the limiter writes, so the numbers match
 * what the next chat turn will do. Reading does not consume quota.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @returns The remaining per-minute and per-day allowance.
 */
export async function getLlmQuota(ctx: AppContext, userId: string): Promise<LlmQuotaRow> {
  const minute = Math.floor(Date.now() / 60_000);
  const day = new Date().toISOString().slice(0, 10);
  const [minRaw, dayRaw] = await Promise.all([
    ctx.redis.main.get(`llm:rl:${userId}:${minute}`),
    ctx.redis.main.get(`llm:rl:day:${userId}:${day}`),
  ]);
  const usedMin = Number(minRaw ?? '0');
  const usedDay = Number(dayRaw ?? '0');
  const nextMidnight = new Date(`${day}T00:00:00.000Z`);
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  return {
    perMinuteLimit: RATE_LIMIT_PER_MIN,
    remainingThisMinute: Math.max(0, RATE_LIMIT_PER_MIN - usedMin),
    perDayLimit: RATE_LIMIT_PER_DAY,
    remainingToday: Math.max(0, RATE_LIMIT_PER_DAY - usedDay),
    resetsAt: nextMidnight.toISOString(),
  };
}

/**
 * Run a chat turn for the caller. Filters + injection-checks
 * the input, enforces the per-user rate limit, calls the LLM
 * client, and persists the (filtered) interaction.
 *
 * @param ctx - Application context.
 * @param input - The chat input (userId + archetype + message).
 * @param client - The LLM client (Anthropic in production, stub
 *                in dev/tests). Dependency-injected so the
 *                filter + rate-limit + persistence paths can
 *                be exercised without a network call.
 * @param now - Optional clock for tests.
 * @returns The LLM response (filtered) + metadata.
 */
export async function chatWithLlmNpc(
  ctx: AppContext,
  input: LlmChatInput,
  client: LlmClient,
  now: Date = new Date(),
): Promise<LlmChatResult> {
  if (input.message.length === 0 || input.message.length > 1000) {
    throw new ValidationFailedError({ reason: 'message length 1..1000' });
  }
  // Filter + injection check the user's input.
  const filteredInput = chatFilter(input.message);
  if (detectPromptInjection(input.message)) {
    return persistRefusal(ctx, input, 'prompt_injection_detected', now);
  }
  // Rate limit per user.
  const ok = await takeRateLimitToken(ctx, input.userId);
  if (!ok) {
    return persistRefusal(ctx, input, RATE_LIMIT_REFUSAL, now);
  }
  // The system prompt is server-side; the user's input is the
  // filtered text (PII removed).
  const system = systemPrompt(input.archetype);
  const model = ctx.config.llmModel;
  const raw = await client.complete({
    system,
    user: filteredInput.text,
    model,
  });
  // Filter the model's output too.
  const filteredOutput = chatFilter(raw.text);
  const replyId = uuidv7();
  return runInTransaction(async (dbClient) => {
    const r = await dbClient.query<LlmInteractionDbRow>(
      `INSERT INTO llm_npc_interactions
         (interaction_id, user_id, archetype, model, prompt_tokens,
          completion_tokens, filtered, refused, response_text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)
       RETURNING interaction_id, user_id, archetype, model, prompt_tokens,
                 completion_tokens, filtered, refused, response_text, created_at`,
      [
        replyId,
        input.userId,
        input.archetype,
        model,
        raw.promptTokens,
        raw.completionTokens,
        filteredOutput.filtered,
        filteredOutput.text,
        now.toISOString(),
      ],
    );
    void r;
    return {
      replyId,
      archetype: input.archetype,
      response: filteredOutput.text,
      filtered: filteredOutput.filtered,
      refused: false,
      model,
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
    };
  });
}

async function persistRefusal(
  ctx: AppContext,
  input: LlmChatInput,
  reason: string,
  now: Date,
): Promise<LlmChatResult> {
  const model = ctx.config.llmModel;
  const replyId = uuidv7();
  return runInTransaction(async (dbClient) => {
    await dbClient.query(
      `INSERT INTO llm_npc_interactions
         (interaction_id, user_id, archetype, model, prompt_tokens,
          completion_tokens, filtered, refused, response_text, created_at)
       VALUES ($1, $2, $3, $4, 0, 0, false, true, $5, $6)`,
      [replyId, input.userId, input.archetype, model, reason, now.toISOString()],
    );
    return {
      replyId,
      archetype: input.archetype,
      response: reason,
      filtered: false,
      refused: true,
      model,
      promptTokens: 0,
      completionTokens: 0,
      refusalReason: reason,
    };
  });
}

/** A stub LLM client that returns a canned response. Useful
 *  for dev paths and tests. The production Anthropic client
 *  is in server/shared/llm/anthropic.ts. */
export function stubLlmClient(reply: string): LlmClient {
  return {
    async complete(params) {
      void params;
      return { text: reply, promptTokens: 16, completionTokens: 8 };
    },
  };
}

void ForbiddenError;
