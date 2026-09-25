CREATE TABLE addresses (
  address TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  -- 1 means the address never expires and is good until torched. expires_at
  -- is still set and kept up to date, so clearing this flag falls back to a
  -- sensible expiry rather than an already-past one.
  permanent INTEGER NOT NULL DEFAULT 0,
  -- Optional user-supplied label ("netflix signup"), shown next to the
  -- address in /list. NULL when none was given.
  note TEXT,
  -- 5-digit id shown next to the address in /list, so /note, /extend, and
  -- /torch can take this instead of the full address. Owner-scoped at lookup
  -- time same as the address itself, so it's a typing convenience, not a
  -- security boundary.
  short_id TEXT,
  -- When an expiry reminder DM was sent, so a second cron run in the same
  -- window can't duplicate it. NULL means not yet warned; extendAddress
  -- resets it so an extended address warns again on its new expiry.
  expiry_warned_at INTEGER,
  -- Opaque, receiver-specific data (JSON). NULL for addresses on a domain you
  -- own. Set for addresses provisioned through mail.tm, which needs to
  -- remember a password to poll for mail and an account id to clean up after
  -- itself. Core never reads or writes this column.
  receiver_data TEXT
);
CREATE INDEX idx_addresses_owner ON addresses(owner_type, owner_id);
CREATE UNIQUE INDEX idx_addresses_short_id ON addresses(short_id);

CREATE TABLE rate_limits (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, action)
);

-- Per-owner settings. A missing row means everything is off, which is what
-- makes expiry reminders opt-in rather than something people receive without
-- asking.
CREATE TABLE owner_preferences (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  expiry_reminders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_type, owner_id)
);

-- Running totals for the public counter page (Cloudflare path only). A
-- single row rather than a live COUNT(*), since cleanup physically deletes
-- expired/torched rows and a live count would lose history as soon as that
-- runs.
CREATE TABLE counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  created INTEGER NOT NULL DEFAULT 0,
  torched INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0
);
INSERT INTO counters (id, created, torched, received) VALUES (1, 0, 0, 0);
