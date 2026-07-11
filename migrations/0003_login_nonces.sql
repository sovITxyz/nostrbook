-- Migration number: 0003    login_nonces
-- Login nonces move from KV to D1 (P4 addendum, orchestrator-RATIFIED).
-- KV get→delete was non-atomic and eventually consistent (~60s cross-colo),
-- so nonce single-use was best-effort only: two POSTs presenting the same
-- captured signed event inside that window could both mint a session. D1's
-- `DELETE … WHERE nonce = ? AND expires_at > ? RETURNING nonce` consumes a
-- nonce atomically — exactly one concurrent caller wins. This also removes
-- nonce traffic from the 1,000-writes/day free-tier KV budget entirely
-- (KV now carries only sessions `sess:<token>` and cache gen bumps
-- `gen:<pubkey>`).

CREATE TABLE login_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- The challenge handler opportunistically sweeps expired rows
-- (DELETE ... WHERE expires_at < now); this index keeps that sweep cheap.
CREATE INDEX idx_login_nonces_expiry ON login_nonces(expires_at);
