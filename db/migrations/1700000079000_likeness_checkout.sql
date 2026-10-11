-- Dedicated USDC checkout; never credits Cash or trusts a client purchase claim.
-- Up Migration
ALTER TABLE likeness_entitlements ADD COLUMN fulfillment_status text NOT NULL DEFAULT 'delivery_owed'
  CHECK(fulfillment_status IN ('delivery_owed','delivered','manual_review','refunded'));
CREATE TABLE likeness_payment_intents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  model_id text NOT NULL,
  amount_base_units text NOT NULL CHECK(amount_base_units ~ '^[1-9][0-9]*$'),
  cluster text NOT NULL CHECK(cluster IN ('devnet','mainnet')),
  mint text NOT NULL,
  payer text NOT NULL,
  recipient text NOT NULL,
  reference text NOT NULL UNIQUE,
  memo text NOT NULL UNIQUE,
  transaction_base64 text NOT NULL,
  last_valid_block_height bigint NOT NULL CHECK(last_valid_block_height>0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','expired','manual_review')),
  signature text,
  entitlement_id uuid UNIQUE REFERENCES likeness_entitlements(id) ON DELETE RESTRICT,
  failure_reason text,
  UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX likeness_checkout_one_pending_owner ON likeness_payment_intents(user_id) WHERE status='pending';
-- Every failure path (worker, consent withdrawal, cancellation) keeps paid delivery owed.
-- A delivered purchase is not re-opened when its owner later deletes the asset.
CREATE FUNCTION likeness_record_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('failed','cancelled') OR NEW.phase='reconciliation_required' THEN
    UPDATE likeness_entitlements SET fulfillment_status='manual_review'
      WHERE id=NEW.entitlement_id AND fulfillment_status='delivery_owed';
    UPDATE likeness_payment_intents SET status='manual_review',failure_reason='delivery_owed_after_generation_failure'
      WHERE entitlement_id=NEW.entitlement_id AND status='confirmed'
      AND EXISTS(SELECT 1 FROM likeness_entitlements e WHERE e.id=NEW.entitlement_id AND e.fulfillment_status='manual_review');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER likeness_delivery_failure AFTER UPDATE OF status,phase ON likeness_jobs
  FOR EACH ROW EXECUTE FUNCTION likeness_record_delivery_failure();
-- Down Migration
DROP TRIGGER likeness_delivery_failure ON likeness_jobs;
DROP FUNCTION likeness_record_delivery_failure();
DROP TABLE likeness_payment_intents;
ALTER TABLE likeness_entitlements DROP COLUMN fulfillment_status;
