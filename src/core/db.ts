import type { SqlExecutor } from "./storage.ts";
import type { AddressRow, OwnerRef } from "./types.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LOCAL_PART_LENGTH = 10;
const MAX_CREATE_ATTEMPTS = 5;

// Addresses must not be predictable: users can mint addresses and see the
// results, and Math.random()'s PRNG state is recoverable from observed
// output, which would let one user guess another's addresses. Uses rejection
// sampling: bytes at or above the largest multiple of the alphabet length
// are discarded rather than folded in with %, which would bias the low
// characters of the alphabet.
const REJECTION_LIMIT = 256 - (256 % ALPHABET.length);

// Exported since other receivers (mail.tm) need their own random strings
// (a local part, an account password) with the same guarantee.
export function randomAlphanumeric(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= REJECTION_LIMIT) {
        continue;
      }
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) {
        break;
      }
    }
  }
  return out;
}

// 5-digit id shown alongside the address in /list, so /note, /extend, and
// /torch can take this instead of the full string. Not security-sensitive
// the way the address itself is: every lookup by short_id is still scoped to
// the invoking owner, so guessing one does nothing without also owning the
// match, hence plain Math.random() rather than the rejection-sampling
// machinery above.
const SHORT_ID_MIN = 10000;
const SHORT_ID_RANGE = 90000;
const MAX_SHORT_ID_ATTEMPTS = 5;

function randomShortId(): string {
  return String(SHORT_ID_MIN + Math.floor(Math.random() * SHORT_ID_RANGE));
}

async function generateUniqueShortId(db: SqlExecutor): Promise<string> {
  for (let attempt = 0; attempt < MAX_SHORT_ID_ATTEMPTS; attempt++) {
    const shortId = randomShortId();
    const existing = await db.first<{ short_id: string }>(
      `SELECT short_id FROM addresses WHERE short_id = ?`,
      shortId
    );
    if (!existing) {
      return shortId;
    }
  }
  throw new Error("failed to allocate a unique short id after several attempts");
}

// Addresses created before short ids existed (migration 0008) have NULL. A
// SQL-only backfill can't promise uniqueness against the random ids already
// handed out, so this assigns them through the same collision check new
// addresses use. Runs from the daily cleanup so every deployment fills its
// own gaps without a manual step; a no-op once nothing is left.
export async function backfillShortIds(db: SqlExecutor): Promise<number> {
  const rows = await db.all<{ address: string }>(
    `SELECT address FROM addresses WHERE short_id IS NULL AND revoked = 0`
  );
  let filled = 0;
  for (const { address } of rows) {
    const shortId = await generateUniqueShortId(db);
    const result = await db.run(
      `UPDATE addresses SET short_id = ? WHERE address = ? AND short_id IS NULL`,
      shortId,
      address
    );
    filled += result.changes;
  }
  return filled;
}

export async function createAddress(
  db: SqlExecutor,
  owner: OwnerRef,
  domain: string,
  ttlSeconds: number,
  permanent = false,
  note: string | null = null
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const address = `${randomAlphanumeric(LOCAL_PART_LENGTH)}@${domain}`;
    const shortId = await generateUniqueShortId(db);
    const result = await db.run(
      `INSERT INTO addresses (address, short_id, owner_type, owner_id, created_at, expires_at, revoked, permanent, note)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(address) DO NOTHING`,
      address,
      shortId,
      owner.type,
      owner.id,
      now,
      expiresAt,
      permanent ? 1 : 0,
      note
    );

    if (result.changes > 0) {
      await incrementCreatedCounter(db);
      return address;
    }
  }

  throw new Error("failed to allocate a unique address after several attempts");
}

// For receivers that provision the address themselves (mail.tm calls their
// API and gets an address back, rather than inventing a local part on a
// domain we own) and just need it persisted. receiverData is opaque to core,
// see schema.sql for what it's for.
export async function registerAddress(
  db: SqlExecutor,
  address: string,
  owner: OwnerRef,
  ttlSeconds: number,
  receiverData: string,
  permanent = false,
  note: string | null = null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const shortId = await generateUniqueShortId(db);
  await db.run(
    `INSERT INTO addresses (address, short_id, owner_type, owner_id, created_at, expires_at, revoked, permanent, note, receiver_data)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    address,
    shortId,
    owner.type,
    owner.id,
    now,
    expiresAt,
    permanent ? 1 : 0,
    note,
    receiverData
  );
  await incrementCreatedCounter(db);
}

// Empty string clears the note rather than storing "", so /note with a blank
// value is how you remove one.
export async function setAddressNote(
  db: SqlExecutor,
  owner: OwnerRef,
  address: string,
  note: string
): Promise<boolean> {
  const result = await db.run(
    `UPDATE addresses SET note = ?
     WHERE address = ? AND owner_type = ? AND owner_id = ? AND revoked = 0`,
    note.trim() === "" ? null : note,
    address,
    owner.type,
    owner.id
  );
  return result.changes > 0;
}

export async function getAddress(db: SqlExecutor, address: string): Promise<AddressRow | null> {
  return db.first<AddressRow>(`SELECT * FROM addresses WHERE address = ?`, address);
}

// Scoped to the owner same as every other lookup by identifier, so trying
// short ids that aren't yours behaves exactly like trying addresses that
// aren't yours: "not found", never a hint that a match exists elsewhere.
export async function getAddressByShortId(
  db: SqlExecutor,
  owner: OwnerRef,
  shortId: string
): Promise<AddressRow | null> {
  return db.first<AddressRow>(
    `SELECT * FROM addresses WHERE short_id = ? AND owner_type = ? AND owner_id = ? AND revoked = 0`,
    shortId,
    owner.type,
    owner.id
  );
}

export async function listActiveAddresses(db: SqlExecutor, owner: OwnerRef): Promise<AddressRow[]> {
  const now = Math.floor(Date.now() / 1000);
  return db.all<AddressRow>(
    `SELECT * FROM addresses
     WHERE owner_type = ? AND owner_id = ? AND revoked = 0 AND (permanent = 1 OR expires_at > ?)
     ORDER BY permanent ASC, expires_at ASC`,
    owner.type,
    owner.id,
    now
  );
}

// Every active address that has receiver-specific data attached, regardless
// of which receiver set it. Used by a receiver's own poller/cleanup to find
// the rows it's responsible for; core has no idea what's inside the column,
// callers filter by whatever shape they expect.
export async function listActiveAddressesWithReceiverData(db: SqlExecutor): Promise<AddressRow[]> {
  const now = Math.floor(Date.now() / 1000);
  return db.all<AddressRow>(
    `SELECT * FROM addresses
     WHERE receiver_data IS NOT NULL AND revoked = 0 AND (permanent = 1 OR expires_at > ?)`,
    now
  );
}

// Same rows deleteExpiredAndRevoked would remove, but as a read. A receiver
// that needs to clean up external state (mail.tm deleting the account on
// its side) has to know which rows are about to go before they're gone.
export async function listExpiredAndRevoked(db: SqlExecutor, graceSeconds: number): Promise<AddressRow[]> {
  const now = Math.floor(Date.now() / 1000);
  return db.all<AddressRow>(
    `SELECT * FROM addresses
     WHERE (revoked = 1 AND COALESCE(revoked_at, expires_at) + ? <= ?)
        OR (permanent = 0 AND expires_at + ? <= ?)`,
    graceSeconds,
    now,
    graceSeconds,
    now
  );
}

export async function countActiveAddresses(db: SqlExecutor, owner: OwnerRef): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.first<{ count: number }>(
    `SELECT COUNT(*) as count FROM addresses
     WHERE owner_type = ? AND owner_id = ? AND revoked = 0 AND (permanent = 1 OR expires_at > ?)`,
    owner.type,
    owner.id,
    now
  );
  return row?.count ?? 0;
}

// expires_at is always pushed out, even when making an address permanent, so
// that clearing the flag later leaves a fresh expiry rather than one that
// lapsed while the address was permanent. `permanent` undefined leaves the
// flag as it is, which is what a plain /extend does.
//
// expiry_warned_at resets to NULL on every extend. Without that, an address
// warned once would never warn again no matter how far its expiry moved.
export async function extendAddress(
  db: SqlExecutor,
  owner: OwnerRef,
  address: string,
  ttlSeconds: number,
  permanent?: boolean
): Promise<boolean> {
  const newExpiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const setPermanent = permanent === undefined ? "" : `, permanent = ${permanent ? 1 : 0}`;
  const result = await db.run(
    `UPDATE addresses SET expires_at = ?, expiry_warned_at = NULL${setPermanent}
     WHERE address = ? AND owner_type = ? AND owner_id = ? AND revoked = 0`,
    newExpiresAt,
    address,
    owner.type,
    owner.id
  );
  return result.changes > 0;
}

export async function revokeAddress(db: SqlExecutor, owner: OwnerRef, address: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.run(
    `UPDATE addresses SET revoked = 1, revoked_at = ?
     WHERE address = ? AND owner_type = ? AND owner_id = ? AND revoked = 0`,
    now,
    address,
    owner.type,
    owner.id
  );
  if (result.changes > 0) {
    await incrementTorchedCounter(db);
  }
  return result.changes > 0;
}

// Addresses due an expiry reminder: expiring inside the given window, still
// live, not already warned, and belonging to someone who opted in. The join
// is what enforces opt-in, since an owner with no preferences row can't
// match.
export async function listAddressesNeedingExpiryWarning(
  db: SqlExecutor,
  minSeconds: number,
  maxSeconds: number
): Promise<AddressRow[]> {
  const now = Math.floor(Date.now() / 1000);
  return db.all<AddressRow>(
    `SELECT a.* FROM addresses a
     JOIN owner_preferences p
       ON p.owner_type = a.owner_type AND p.owner_id = a.owner_id
     WHERE p.expiry_reminders = 1
       AND a.revoked = 0
       AND a.permanent = 0
       AND a.expiry_warned_at IS NULL
       AND a.expires_at >= ?
       AND a.expires_at <= ?
     ORDER BY a.expires_at ASC`,
    now + minSeconds,
    now + maxSeconds
  );
}

export async function markExpiryWarned(db: SqlExecutor, addresses: string[]): Promise<void> {
  if (addresses.length === 0) {
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const placeholders = addresses.map(() => "?").join(", ");
  await db.run(
    `UPDATE addresses SET expiry_warned_at = ? WHERE address IN (${placeholders})`,
    now,
    ...addresses
  );
}

// Absent row means off, so reminders are opt-in rather than something people
// receive without asking.
export async function getExpiryReminderPreference(db: SqlExecutor, owner: OwnerRef): Promise<boolean> {
  const row = await db.first<{ expiry_reminders: number }>(
    `SELECT expiry_reminders FROM owner_preferences WHERE owner_type = ? AND owner_id = ?`,
    owner.type,
    owner.id
  );
  return row?.expiry_reminders === 1;
}

export async function setExpiryReminderPreference(
  db: SqlExecutor,
  owner: OwnerRef,
  enabled: boolean
): Promise<void> {
  await db.run(
    `INSERT INTO owner_preferences (owner_type, owner_id, expiry_reminders)
     VALUES (?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET expiry_reminders = excluded.expiry_reminders`,
    owner.type,
    owner.id,
    enabled ? 1 : 0
  );
}

// Expired rows are removed once they are `graceSeconds` past expiry; revoked
// rows once they are `graceSeconds` past the moment they were revoked, rather
// than waiting out their original (possibly week-long) expiry. Rows revoked
// before revoked_at existed have no timestamp, so they fall back to expiry.
// Permanent rows never expire, so only the revoked branch can ever collect
// them: torching one is still the way it goes away.
export async function deleteExpiredAndRevoked(db: SqlExecutor, graceSeconds: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.run(
    `DELETE FROM addresses
     WHERE (revoked = 1 AND COALESCE(revoked_at, expires_at) + ? <= ?)
        OR (permanent = 0 AND expires_at + ? <= ?)`,
    graceSeconds,
    now,
    graceSeconds,
    now
  );
  return result.changes;
}

// Rate-limit rows are keyed by (owner, action) so the table is bounded by
// user count rather than traffic, but rows for users who stop using the bot
// would otherwise persist forever. Anything whose window closed long ago is
// inert. Dropping it is equivalent to the row never having existed.
export async function deleteStaleRateLimits(db: SqlExecutor, olderThanSeconds: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  const result = await db.run(`DELETE FROM rate_limits WHERE window_start <= ?`, cutoff);
  return result.changes;
}

// Running totals for the public counter page. Deliberately best effort:
// these are display-only numbers, and a database that predates the counters
// table (an existing deployment that hasn't run migrations 0004/0005 yet)
// must not lose mail or fail to hand out addresses over a stat nobody's
// looking at. A failure here is logged and swallowed, never propagated to
// the caller.
//
// Not wrapped in the same transaction as the insert/revoke they follow
// either -- SqlExecutor has no multi-statement transaction primitive -- so
// a crash between the two statements can undercount by one. Fine for a
// vanity counter, not worth adding transaction plumbing for.
async function bumpCounter(db: SqlExecutor, column: "created" | "torched" | "received"): Promise<void> {
  try {
    await db.run(`UPDATE counters SET ${column} = ${column} + 1 WHERE id = 1`);
  } catch (err) {
    console.warn(`counter "${column}" not incremented: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function incrementCreatedCounter(db: SqlExecutor): Promise<void> {
  await bumpCounter(db, "created");
}

async function incrementTorchedCounter(db: SqlExecutor): Promise<void> {
  await bumpCounter(db, "torched");
}

export async function incrementReceivedCounter(db: SqlExecutor): Promise<void> {
  await bumpCounter(db, "received");
}

export interface Counters {
  created: number;
  torched: number;
  received: number;
  users: number;
}

const EMPTY_COUNTERS: Counters = { created: 0, torched: 0, received: 0, users: 0 };

// Unlike the three running totals, this is counted live, so it goes down when
// cleanup removes the last address belonging to someone. It's "people with an
// active address right now", not "people who ever used it", and the status
// page labels it that way.
async function countOwners(db: SqlExecutor): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // Distinct on (owner_type, owner_id), not owner_id alone: ids are only
  // unique within an adapter, so a second adapter would otherwise merge two
  // different people who happened to share an id.
  const row = await db.first<{ count: number }>(
    `SELECT COUNT(DISTINCT owner_type || ':' || owner_id) as count FROM addresses
     WHERE revoked = 0 AND (permanent = 1 OR expires_at > ?)`,
    now
  );
  return row?.count ?? 0;
}

// Same reasoning as bumpCounter: the page renders zeroes rather than the
// endpoint 500ing if the table isn't there yet.
export async function getCounters(db: SqlExecutor): Promise<Counters> {
  try {
    const row = await db.first<Omit<Counters, "users">>(
      `SELECT created, torched, received FROM counters WHERE id = 1`
    );
    return { ...EMPTY_COUNTERS, ...row, users: await countOwners(db) };
  } catch (err) {
    console.warn(`counters unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_COUNTERS;
  }
}
