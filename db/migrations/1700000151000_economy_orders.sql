-- Up Migration
-- Real asset amounts never enter Cash/cents columns. No live prices are seeded.
CREATE TABLE economy_offers (
  offer_id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  chain_id text NOT NULL CHECK (chain_id IN ('solana:mainnet','eip155:4663','near:mainnet')),
  asset_id text NOT NULL,
  amount text NOT NULL CHECK (amount ~ '^[1-9][0-9]{0,77}$'),
  recipient text NOT NULL,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 120),
  item_id uuid NOT NULL REFERENCES cosmetic_items(item_id),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE economy_orders (
  order_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  wallet_link_id uuid NOT NULL REFERENCES economy_wallet_links(id),
  offer_id uuid NOT NULL REFERENCES economy_offers(offer_id),
  idempotency_key uuid NOT NULL,
  chain_id text NOT NULL,
  asset_id text NOT NULL,
  amount text NOT NULL CHECK (amount ~ '^[1-9][0-9]{0,77}$'),
  payer text NOT NULL,
  recipient text NOT NULL CHECK (payer <> recipient),
  terms_version text NOT NULL,
  item_id uuid NOT NULL REFERENCES cosmetic_items(item_id),
  status text NOT NULL CHECK (status IN ('awaiting_payment','cancelled','expired','paid','fulfilled','refund_due','refunded')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX economy_one_open_item ON economy_orders(user_id,item_id)
  WHERE status IN ('awaiting_payment','paid');
CREATE INDEX economy_orders_owner ON economy_orders(user_id,created_at DESC);

-- A receipt belongs to one order globally, even after cancellation/refund.
-- Every extra incoming payment remains a separate refund obligation.
CREATE TABLE economy_receipts (
  receipt_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES economy_orders(order_id),
  chain_id text NOT NULL,
  event_id text NOT NULL,
  transaction_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment','refund')),
  disposition text NOT NULL CHECK (disposition IN ('applied','refund_due','refunded','refund')),
  refunds_receipt_id uuid UNIQUE REFERENCES economy_receipts(receipt_id),
  evidence jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,event_id),
  CHECK ((kind = 'refund') = (refunds_receipt_id IS NOT NULL)),
  CHECK ((kind = 'refund') = (disposition = 'refund'))
);
CREATE INDEX economy_receipts_order ON economy_receipts(order_id,recorded_at);

-- Durable reconciliation input; submitting a hash is never proof of payment.
CREATE TABLE economy_payment_attempts (
  order_id uuid NOT NULL REFERENCES economy_orders(order_id),
  transaction_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment','refund')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(order_id,transaction_id,kind)
);

-- Down Migration
DROP TABLE economy_payment_attempts;
DROP TABLE economy_receipts;
DROP TABLE economy_orders;
DROP TABLE economy_offers;
