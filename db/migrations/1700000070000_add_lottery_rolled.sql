-- Up Migration
-- Add lottery_rolled_at to track when a user rolled the birth lottery.
-- This fixes B13: the check should be "has the user rolled", not "does
-- the user have a character", since rolling comes before character creation.

ALTER TABLE users ADD COLUMN lottery_rolled_at timestamptz;

-- Down Migration
ALTER TABLE users DROP COLUMN lottery_rolled_at;
