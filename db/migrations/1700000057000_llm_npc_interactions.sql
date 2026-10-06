-- Migration: 057_llm_npc_interactions
--
-- The M7 #8 LLM chat (AI Agent + Sleuth). One row per
-- (interaction_id). The application stores the user's prompt
-- and the model's response on a successful (post-filter) reply.
-- The rate limit is enforced in Redis; this table is the audit
-- log + the (user_id, created_at) hot path for the per-user
-- minute-window cap.
--
-- `archetype` is the NPC family: 'ai_agent' or 'sleuth'. The
--   CHECK keeps the enum honest.
-- `model` is the LLM model id (e.g. 'claude-opus-4-6' from the
--   LLM_MODEL env var). text CHECK non-empty.
-- `prompt_tokens`, `completion_tokens` are int4 (token counts
--   returned by the Anthropic API; CHECK >= 0).
-- `filtered` is boolean — true if the output filter modified or
--   refused the response. The application still stores the
--   filtered response; the unfiltered text is never persisted.
-- `refused` is boolean — true if the input was rejected by the
--   rate limit / injection filter / PII strip before the model
--   was called. The response_text in that case is the refusal
--   text, not the model's output.
-- `created_at` is set on insert.
--
-- Index:
--   (user_id, created_at DESC) - the per-user rate-limit window.
--   (archetype, created_at DESC) - the per-archetype metric.

-- Up Migration
CREATE TABLE llm_npc_interactions (
  interaction_id     uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  archetype          text NOT NULL
                      CHECK (archetype IN ('ai_agent', 'sleuth')),
  model              text NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  prompt_tokens      int NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens  int NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  filtered           boolean NOT NULL DEFAULT false,
  refused            boolean NOT NULL DEFAULT false,
  response_text      text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX llm_npc_interactions_user_idx
  ON llm_npc_interactions (user_id, created_at DESC);

CREATE INDEX llm_npc_interactions_archetype_idx
  ON llm_npc_interactions (archetype, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS llm_npc_interactions;
