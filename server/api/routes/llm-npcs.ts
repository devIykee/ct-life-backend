/**
 * LLM NPC chat routes (M7 #8).
 *
 *   POST /v1/llm/chat
 *     body: { archetype: 'ai_agent' | 'sleuth', message: string }
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { chatWithLlmNpc, stubLlmClient } from '../../application/llm-npcs.js';
import { createAnthropicClient } from '../../shared/llm/anthropic.js';

const ChatBody = z.object({
  archetype: z.enum(['ai_agent', 'sleuth']),
  message: z.string().min(1).max(1000),
});

/**
 * Register the LLM chat routes on the Fastify app. The route
 * returns 503 when LLM_NPCS_ENABLED is false (master prompt's
 * M7 #8 gate: "behind a feature flag").
 */
export function registerLlmNpcRoutes(app: FastifyInstance): void {
  app.post('/v1/llm/chat', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    if (!req.ctx.config.features.llmEnabled) {
      return reply.status(503).send({
        error: {
          code: 'LLM_DISABLED',
          message: 'LLM NPC chat is disabled.',
        },
      });
    }
    const body = ChatBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    // Production: the real Anthropic client. Dev: a stub
    // when the API key is missing (so the route is wired +
    // the filter is exercised without a network call).
    const client = req.ctx.config.anthropicApiKey
      ? createAnthropicClient({ apiKey: req.ctx.config.anthropicApiKey })
      : stubLlmClient("I'm thinking about the latest launches. Ask me about something specific.");
    const out = await chatWithLlmNpc(
      req.ctx,
      {
        userId: req.user!.sub,
        archetype: body.data.archetype,
        message: body.data.message,
      },
      client,
    );
    return reply.send(out);
  });
}
