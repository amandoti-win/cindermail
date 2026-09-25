-- Adds a 5-digit short id to addresses, so /note, /extend, and /torch can
-- take that instead of retyping the whole address. Existing rows are left
-- with short_id NULL rather than backfilled; SQLite's unique index allows
-- multiple NULLs, and each is still usable by its full address as before.
--
-- Only needed for databases created before this existed; schema.sql already
-- includes it for fresh installs.
--
--   wrangler d1 execute cinderbox --remote --file=migrations/0008_add_short_id.sql

ALTER TABLE addresses ADD COLUMN short_id TEXT;
CREATE UNIQUE INDEX idx_addresses_short_id ON addresses(short_id);
