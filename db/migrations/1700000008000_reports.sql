-- Migration: 008_reports
--
-- Player reports of misconduct. `target_type` is one of: user, message,
-- space, call, post, ad. The target_id is a string (the messageId, the
-- spaceId, the callId, the postId, the adId, or the userId). reason_id
-- is from contract/ids/report_reasons.json (spam, scam, harassment,
-- impersonation, nsfw). The optional note is the free-text detail.
--
-- The moderation queue (M5) reads WHERE resolved_at IS NULL ORDER BY
-- created_at ASC.

-- Up Migration
CREATE TABLE reports (
  report_id        bigserial PRIMARY KEY,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type      text NOT NULL CHECK (target_type IN
                      ('user', 'message', 'space', 'call', 'post', 'ad')),
  target_id        text NOT NULL,
  reason_id        text NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz
);

CREATE INDEX reports_unresolved_idx
  ON reports (created_at ASC)
  WHERE resolved_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS reports;
