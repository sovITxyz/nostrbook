-- Migration number: 0005    relay
-- First-party relay (#5) support.
--
-- The relay REQ engine's dominant query is authors (+ kinds) ordered by
-- created_at DESC. The existing idx_events_feed(kind, deleted, created_at)
-- cannot serve that ordering for a pubkey-scoped scan, so add a dedicated
-- author+time index.
CREATE INDEX idx_events_author_time ON events(pubkey, created_at DESC);

-- The relay endpoint lives at the apex path wss://nbread.lol/relay, but
-- reserve the handle anyway so no blog ever claims relay.nbread.lol.
INSERT OR IGNORE INTO reserved_handles (handle) VALUES
  ('relay');
