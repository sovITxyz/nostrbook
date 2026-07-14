-- Migration number: 0001    init
-- nbread.lol base schema (see docs/phases/CONTRACTS.md).

CREATE TABLE users    (pubkey TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE,
                       claimed_at TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
                       blocked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE events   (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
                       d_tag TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
                       content TEXT NOT NULL, tags TEXT NOT NULL, sig TEXT NOT NULL,
                       raw TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                       UNIQUE(pubkey, kind, d_tag));

CREATE INDEX idx_events_feed ON events(kind, deleted, created_at DESC);

CREATE TABLE profiles (pubkey TEXT PRIMARY KEY, name TEXT, picture TEXT, about TEXT,
                       nip05 TEXT, raw TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE reserved_handles (handle TEXT PRIMARY KEY);

INSERT INTO reserved_handles (handle) VALUES
  ('www'), ('api'), ('admin'), ('staff'), ('static'), ('mail'),
  ('blog'), ('help'), ('about'), ('root'), ('_dmarc');

-- Rate counters live in D1, NOT KV: KV free tier = only 1,000 writes/day (reserved for
-- sessions, login nonces, gen bumps); D1 free tier = 100k writes/day.
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);

-- REGULAR fts5 (stores its own text copy) — contentless/external-content variants can't do
-- the UPDATE/DELETE that edited/deleted posts need. rowid = events.rowid; the mirror service
-- maintains it (INSERT with explicit rowid on store, DELETE by rowid on replace/delete).
CREATE VIRTUAL TABLE posts_fts USING fts5(title, summary, content, tokenize='porter unicode61');
