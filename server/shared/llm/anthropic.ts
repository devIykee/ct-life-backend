/**
 * Anthropic Messages API client (M7 #8).
 *
 * Thin fetch wrapper for the chat completions endpoint. The
 * application is the only caller. When `ctx.config.features.llmEnabled`
 * is false, this client is never invoked; the route returns 503.
 *
 * The response is `text` (the model's reply) and the token
 * counts. Errors from the upstream API surface as `LlmError`
 * with the HTTP status; the route maps to 502.
 */
import { LlmClient } from '../../application/llm-npcs.js';

export interface AnthropicClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export class LlmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createAnthropicClient(cfg: AnthropicClientConfig): LlmClient {
  const baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com';
  return {
    async complete(params) {
      const url = `${baseUrl}/v1/messages`;
      const body = {
        model: params.model,
        max_tokens: 256,
        system: params.system,
        messages: [{ role: 'user', content: params.user }],
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        throw new LlmError(`anthropic ${r.status}: ${await r.text()}`, r.status);
      }
      const data = (await r.json()) as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };
      const text = data.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('');
      return {
        text,
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
