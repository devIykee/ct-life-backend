-- Identity proofs only: no balance, allowance, custody or spending authority.
-- Up Migration
CREATE TABLE economy_wallet_link_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('eip155:4663', 'near:mainnet', 'solana:mainnet')),
  address text NOT NULL CHECK (length(address) BETWEEN 2 AND 128),
  proof_scheme text NOT NULL CHECK (proof_scheme IN ('eip4361-eoa', 'nep413-ed25519', 'solana-ed25519')),
  nonce text NOT NULL UNIQUE,
  message text NOT NULL,
  domain text NOT NULL,
  uri text NOT NULL,
  origin text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX economy_wallet_link_challenges_user_idx
  ON economy_wallet_link_challenges (user_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE economy_wallet_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('eip155:4663', 'near:mainnet', 'solana:mainnet')),
  address text NOT NULL CHECK (length(address) BETWEEN 2 AND 128),
  proof_scheme text NOT NULL CHECK (proof_scheme IN ('eip4361-eoa', 'nep413-ed25519', 'solana-ed25519')),
  proof_digest text NOT NULL,
  public_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  -- Revoking a link must not transfer a player's identity to another user.
  UNIQUE (network, address),
  CHECK (network <> 'eip155:4663' OR address = lower(address))
);
CREATE INDEX economy_wallet_links_user_idx ON economy_wallet_links (user_id);

-- Down Migration
DROP TABLE IF EXISTS economy_wallet_links;
DROP TABLE IF EXISTS economy_wallet_link_challenges;
