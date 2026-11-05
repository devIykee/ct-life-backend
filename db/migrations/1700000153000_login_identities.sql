-- Login credentials are explicit and separate from payment-wallet proofs.
-- Up Migration
ALTER TABLE users ALTER COLUMN wallet DROP NOT NULL;

CREATE TABLE login_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('solana:mainnet','eip155:4663','near:mainnet')),
  address text NOT NULL CHECK (length(address) BETWEEN 2 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network,address),
  CHECK (network <> 'eip155:4663' OR address=lower(address))
);
CREATE INDEX login_identities_user_idx ON login_identities(user_id);
-- Existing SIWS ownership is preserved, including banned players. Deleted rows
-- already anonymised before this migration cannot recover their old address.
INSERT INTO login_identities(id,user_id,network,address)
 SELECT gen_random_uuid(),id,'solana:mainnet',wallet FROM users
 WHERE wallet IS NOT NULL AND wallet NOT LIKE 'deleted:%';

CREATE TABLE login_identity_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('login','enrolment')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  account_hint uuid REFERENCES users(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('eip155:4663','near:mainnet')),
  address text NOT NULL CHECK (length(address) BETWEEN 2 AND 128),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{64}$'),
  message text NOT NULL,
  domain text NOT NULL,
  uri text NOT NULL,
  origin text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((purpose='login' AND user_id IS NULL) OR (purpose='enrolment' AND user_id IS NOT NULL)),
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
  CHECK (network <> 'eip155:4663' OR address=lower(address))
);
CREATE INDEX login_identity_challenges_address_idx ON login_identity_challenges(network,address,expires_at) WHERE consumed_at IS NULL;

CREATE INDEX login_identity_challenges_expiry_idx ON login_identity_challenges(expires_at,id);

ALTER TABLE economy_wallet_links ADD COLUMN ownership_released_at timestamptz;
ALTER TABLE economy_wallet_links DROP CONSTRAINT economy_wallet_links_network_address_key;
UPDATE economy_wallet_links l SET ownership_released_at=now(),revoked_at=COALESCE(revoked_at,now())
 FROM users u WHERE u.id=l.user_id AND u.wallet LIKE 'deleted:%';
CREATE UNIQUE INDEX economy_wallet_links_current_owner ON economy_wallet_links(network,address) WHERE ownership_released_at IS NULL;

-- Down Migration
-- Do not silently strand accounts or erase explicitly enrolled login methods.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM economy_wallet_links GROUP BY network,address HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Cannot roll back retained payment-wallet ownership history';
 END IF;
 IF EXISTS(SELECT 1 FROM users WHERE wallet IS NULL) THEN
   RAISE EXCEPTION 'Cannot roll back login identities while null-wallet accounts exist';
 END IF;
 IF EXISTS(SELECT 1 FROM login_identities WHERE network<>'solana:mainnet') THEN
   RAISE EXCEPTION 'Cannot roll back explicitly enrolled non-Solana login identities';
 END IF;
END $$;
DROP INDEX economy_wallet_links_current_owner;
ALTER TABLE economy_wallet_links ADD CONSTRAINT economy_wallet_links_network_address_key UNIQUE(network,address);
ALTER TABLE economy_wallet_links DROP COLUMN ownership_released_at;
DROP TABLE login_identity_challenges;
DROP TABLE login_identities;
ALTER TABLE users ALTER COLUMN wallet SET NOT NULL;
