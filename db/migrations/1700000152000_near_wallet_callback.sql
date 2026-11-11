-- Up Migration
-- Existing challenges were signed with Some(uri). Preserve those exact signed bytes.
ALTER TABLE economy_wallet_link_challenges ADD COLUMN near_callback_url text,
  ADD COLUMN near_callback_mode text NOT NULL DEFAULT 'uri';
UPDATE economy_wallet_link_challenges SET near_callback_url=uri WHERE network='near:mainnet';
ALTER TABLE economy_wallet_link_challenges ADD CONSTRAINT economy_wallet_near_callback_check
  CHECK (
    (network='near:mainnet' AND (
      (near_callback_mode='none' AND near_callback_url IS NULL) OR
      (near_callback_mode='uri' AND (near_callback_url IS NULL OR near_callback_url=uri))
    )) OR
    (network<>'near:mainnet' AND near_callback_mode='uri' AND near_callback_url IS NULL)
  );
-- An older server can keep inserting its original column list during an upgrade.
-- The default mode remains 'uri'; new readers then use the row's saved uri when
-- near_callback_url is null. Only an explicit 'none' row means Borsh None.

-- Down Migration
-- A None challenge cannot be verified by an older server expecting Some(uri).
UPDATE economy_wallet_link_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp())
  WHERE network='near:mainnet' AND near_callback_mode='none';
ALTER TABLE economy_wallet_link_challenges DROP COLUMN near_callback_url,
  DROP COLUMN near_callback_mode;
