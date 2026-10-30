-- Migration: 106_report_npc_reply
--
-- Players can report an AI NPC chat reply. The client sends
-- `POST /v1/reports {targetType: 'npc_reply', targetId: <replyId>}`, where
-- replyId is the `llm_npc_interactions.interaction_id` that
-- `POST /v1/llm/chat` now returns. The reports CHECK did not allow the new
-- target type, so the API answered 400.

-- Up Migration
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN
  ('user', 'message', 'space', 'call', 'post', 'ad', 'npc_reply'));

-- Down Migration
DELETE FROM reports WHERE target_type = 'npc_reply';
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN
  ('user', 'message', 'space', 'call', 'post', 'ad'));
