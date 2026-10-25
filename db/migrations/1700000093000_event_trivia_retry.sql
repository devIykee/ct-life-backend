-- Migration: 093_event_trivia_retry
--
-- Event trivia can be retried after a wrong answer. Until now a wrong answer
-- was written to event_progress (ok = false) and the question was locked for
-- good, so two wrong answers out of the four questions made the 3-correct step
-- impossible to finish.
--
-- event_trivia_attempts — one row per wrong choice a player tried on a trivia
--                         question. The primary key means a wrong choice can
--                         only be tried once. After the n-th wrong choice on a
--                         question the player waits a cooldown (60 s, 10 min,
--                         60 min) before the next try on THAT question; the
--                         server computes it from the attempts, there is no
--                         timer column. A correct answer still goes to
--                         event_progress (ok = true), once, and the event
--                         reward is still paid once per player (event_completions).
--
-- Existing event_progress rows with ok = false are moved here, so a player who
-- was already locked out can try the choices they have not used yet.

-- Up Migration
CREATE TABLE event_trivia_attempts (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id  text NOT NULL,
  choice_id    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id, question_id, choice_id)
);

-- The wrong choice itself was never stored (only that the question was
-- answered wrong), so old rows keep a placeholder choice that blocks nothing
-- real: it counts as one wrong try and starts the cooldown from its time.
INSERT INTO event_trivia_attempts (user_id, event_id, question_id, choice_id, created_at)
SELECT user_id, event_id, item_id, '?', created_at
  FROM event_progress
 WHERE step = 'trivia' AND ok = false
ON CONFLICT DO NOTHING;

DELETE FROM event_progress WHERE step = 'trivia' AND ok = false;

-- Down Migration
INSERT INTO event_progress (user_id, event_id, step, item_id, ok, created_at)
SELECT user_id, event_id, 'trivia', question_id, false, MIN(created_at)
  FROM event_trivia_attempts
 GROUP BY user_id, event_id, question_id
ON CONFLICT DO NOTHING;
DROP TABLE IF EXISTS event_trivia_attempts;
