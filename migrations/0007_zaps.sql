-- Migration number: 0007    zaps
-- NIP-57 zap receipts (#12 v1): server-side aggregation of kind 9735
-- receipts referencing claimed authors' posts, so blog pages can render
-- "⚡ N sats · M zaps" with zero client JS.

-- One row per validated receipt, deduped by the receipt event id. `address`
-- is the NIP-33 a-coordinate of the zapped post (30023:<pubkey>:<d_tag>).
CREATE TABLE zaps (
  receipt_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  author_pubkey TEXT NOT NULL,
  sender_pubkey TEXT,
  amount_msat INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_zaps_address ON zaps(address);

-- Materialized per-post rollup so the render path (post page, discover,
-- search) is a single PK lookup / cheap LEFT JOIN, never a SUM over zaps.
-- Rebuilt idempotently per address after each ingest batch.
CREATE TABLE zap_totals (
  address TEXT PRIMARY KEY,
  msat_total INTEGER NOT NULL,
  zap_count INTEGER NOT NULL
);

-- Cache of LNURL-pay `nostrPubkey` lookups, keyed by the exact lud16 string
-- (receipt validation binds receipts to the author's wallet key; the
-- .well-known fetch must not run per receipt or per request).
CREATE TABLE lnurl_cache (
  lud16 TEXT PRIMARY KEY,
  nostr_pubkey TEXT,
  checked_at INTEGER NOT NULL
);
