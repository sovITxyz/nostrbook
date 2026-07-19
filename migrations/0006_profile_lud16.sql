-- Migration number: 0006    profile lud16
-- Configurable profile (#11): dedicated column for the lightning address so
-- the render path can read it without parsing profiles.raw per request.
-- lud16 is the prerequisite NIP-57 zaps (#12) consume server-side.
ALTER TABLE profiles ADD COLUMN lud16 TEXT;
