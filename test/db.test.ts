import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createAddress,
  deleteExpiredAndRevoked,
  getCounters,
  listActiveAddresses,
  revokeAddress,
} from "../src/core/db.ts";
import { resolveAddressIdentifier } from "../src/core/commands.ts";
import { createDispatcher } from "../src/core/dispatch.ts";
import { handleInboundEmail } from "../src/core/email.ts";
import type { MailAdapter } from "../src/core/types.ts";
import { migrationFile, owner, schemaSql, testDb } from "./helpers.ts";

const DAY = 86400;
const RAW_MAIL = "From: s@e.com\r\nTo: x\r\nSubject: t\r\n\r\nbody";

function capturingAdapter(): { adapter: MailAdapter; delivered: () => number } {
  let count = 0;
  return {
    adapter: {
      name: "discord",
      deliver: async () => { count++; return { success: true }; },
      notify: async () => ({ success: true }),
    },
    delivered: () => count,
  };
}

test("counters", async (t) => {
  await t.test("count real creations and torches only", async () => {
    const { db } = testDb();
    const a = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    assert.equal((await getCounters(db)).created, 2);

    await revokeAddress(db, owner("u1"), a);
    await revokeAddress(db, owner("u1"), a); // already torched
    await revokeAddress(db, owner("someone-else"), a); // not theirs
    assert.equal((await getCounters(db)).torched, 1);
  });

  await t.test("count mail received for a live address only", async () => {
    const { db } = testDb();
    const { adapter } = capturingAdapter();
    const dispatcher = createDispatcher([adapter]);
    const live = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    const expired = await createAddress(db, owner("u1"), "ex.com", -DAY, false, null);

    await handleInboundEmail({ to: live, from: "s@e.com", raw: RAW_MAIL }, db, dispatcher);
    await handleInboundEmail({ to: expired, from: "s@e.com", raw: RAW_MAIL }, db, dispatcher);
    await handleInboundEmail({ to: "nobody@ex.com", from: "s@e.com", raw: RAW_MAIL }, db, dispatcher);
    assert.equal((await getCounters(db)).received, 1);
  });

  await t.test("survive cleanup deleting the rows they counted", async () => {
    const { db } = testDb();
    await createAddress(db, owner("u1"), "ex.com", -DAY, false, null);
    assert.equal(await deleteExpiredAndRevoked(db, 0), 1);
    assert.equal((await getCounters(db)).created, 1);
  });

  // A vanity stat must never be able to take down mail. This is the exact
  // shape of a bug that once dropped inbound mail on deployments that hadn't
  // run the counters migration.
  await t.test("a missing counters table breaks nothing", async () => {
    const { db, raw } = testDb();
    const { adapter, delivered } = capturingAdapter();
    const address = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    raw.exec("DROP TABLE counters");

    await assert.doesNotReject(createAddress(db, owner("u1"), "ex.com", DAY, false, null));
    await assert.doesNotReject(
      handleInboundEmail({ to: address, from: "s@e.com", raw: RAW_MAIL }, db, createDispatcher([adapter]))
    );
    assert.equal(delivered(), 1, "mail must still be delivered");
    await assert.doesNotReject(revokeAddress(db, owner("u1"), address));
    assert.deepEqual(await getCounters(db), { created: 0, torched: 0, received: 0, users: 0 });
  });

  await t.test("users counts distinct owners, not addresses", async () => {
    const { db } = testDb();
    await createAddress(db, owner("a"), "ex.com", DAY, false, null);
    await createAddress(db, owner("a"), "ex.com", DAY, false, null);
    const b = await createAddress(db, owner("b"), "ex.com", DAY, false, null);
    assert.equal((await getCounters(db)).users, 2);

    // Live rather than a running total, so it goes down. That's the point:
    // it means "people holding an address now", not "people who ever did".
    await revokeAddress(db, owner("b"), b);
    assert.equal((await getCounters(db)).users, 1);
  });
});

test("permanent addresses", async (t) => {
  await t.test("survive cleanup", async () => {
    const { db } = testDb();
    await createAddress(db, owner("u1"), "ex.com", -DAY, true, null);
    await createAddress(db, owner("u1"), "ex.com", -DAY, false, null);
    assert.equal(await deleteExpiredAndRevoked(db, 0), 1);
    assert.equal((await listActiveAddresses(db, owner("u1"))).length, 1);
  });

  await t.test("still receive mail past their expires_at", async () => {
    const { db } = testDb();
    const { adapter, delivered } = capturingAdapter();
    const address = await createAddress(db, owner("u1"), "ex.com", -DAY, true, null);
    await handleInboundEmail({ to: address, from: "s@e.com", raw: RAW_MAIL }, db, createDispatcher([adapter]));
    assert.equal(delivered(), 1);
  });

  await t.test("are still ended by /torch", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("u1"), "ex.com", DAY, true, null);
    await revokeAddress(db, owner("u1"), address);
    assert.equal(await deleteExpiredAndRevoked(db, 0), 1);
  });

  await t.test("count against the active address limit", async () => {
    const { db } = testDb();
    await createAddress(db, owner("u1"), "ex.com", DAY, true, null);
    assert.equal((await listActiveAddresses(db, owner("u1"))).length, 1);
  });
});

test("short ids", async (t) => {
  await t.test("every address gets a unique 5-digit id", async () => {
    const { db } = testDb();
    await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    const [first, second] = await listActiveAddresses(db, owner("u1"));
    assert.match(first?.short_id ?? "", /^\d{5}$/);
    assert.match(second?.short_id ?? "", /^\d{5}$/);
    assert.notEqual(first?.short_id, second?.short_id);
  });

  await t.test("resolves to the matching address, scoped to the owner", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    const [row] = await listActiveAddresses(db, owner("u1"));
    const shortId = row?.short_id ?? "";

    assert.equal(await resolveAddressIdentifier(db, owner("u1"), shortId), address);
    assert.equal(await resolveAddressIdentifier(db, owner("someone-else"), shortId), null);
  });

  await t.test("anything that isn't 5 digits is passed through unchanged", async () => {
    const { db } = testDb();
    assert.equal(await resolveAddressIdentifier(db, owner("u1"), "abc123@ex.com"), "abc123@ex.com");
    assert.equal(await resolveAddressIdentifier(db, owner("u1"), "1234"), "1234");
    assert.equal(await resolveAddressIdentifier(db, owner("u1"), "123456"), "123456");
  });

  await t.test("a torched address's short id stops resolving", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    const [row] = await listActiveAddresses(db, owner("u1"));
    const shortId = row?.short_id ?? "";
    await revokeAddress(db, owner("u1"), address);
    assert.equal(await resolveAddressIdentifier(db, owner("u1"), shortId), null);
  });
});

test("inbound mail is dropped for anything not live", async (t) => {
  for (const [label, make] of [
    ["expired", async (db: Parameters<typeof createAddress>[0]) => createAddress(db, owner("u1"), "ex.com", -DAY, false, null)],
    ["revoked", async (db: Parameters<typeof createAddress>[0]) => {
      const a = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
      await revokeAddress(db, owner("u1"), a);
      return a;
    }],
  ] as const) {
    await t.test(label, async () => {
      const { db } = testDb();
      const { adapter, delivered } = capturingAdapter();
      const address = await make(db);
      await handleInboundEmail({ to: address, from: "s@e.com", raw: RAW_MAIL }, db, createDispatcher([adapter]));
      assert.equal(delivered(), 0);
    });
  }

  await t.test("recipient case is normalised on the way in", async () => {
    const { db } = testDb();
    const { adapter, delivered } = capturingAdapter();
    const address = await createAddress(db, owner("u1"), "ex.com", DAY, false, null);
    await handleInboundEmail(
      { to: address.toUpperCase(), from: "s@e.com", raw: RAW_MAIL },
      db,
      createDispatcher([adapter])
    );
    assert.equal(delivered(), 1);
  });
});

// A fresh install runs schema.sql; an existing one runs the migrations. If
// those two ever disagree, the difference only shows up as a confusing
// runtime error on whichever path is wrong.
test("schema.sql matches the migration chain", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(schemaSql());

  const upgraded = new DatabaseSync(":memory:");
  upgraded.exec(`CREATE TABLE addresses (
    address TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX idx_addresses_owner ON addresses(owner_type, owner_id);
  CREATE TABLE rate_limits (owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, action TEXT NOT NULL,
    window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (owner_type, owner_id, action));`);
  for (const name of [
    "0001_add_revoked_at.sql",
    "0002_add_receiver_data.sql",
    "0003_add_permanent.sql",
    "0004_add_counters.sql",
    "0005_add_received_counter.sql",
    "0006_add_note.sql",
    "0007_add_expiry_reminders.sql",
    "0008_add_short_id.sql",
  ]) {
    upgraded.exec(migrationFile(name));
  }

  const columns = (db: DatabaseSync, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown }[])
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`)
      .sort();

  for (const table of ["addresses", "rate_limits", "counters", "owner_preferences"]) {
    assert.deepEqual(columns(upgraded, table), columns(fresh, table), `${table} differs`);
  }
  assert.deepEqual(upgraded.prepare("SELECT * FROM counters").all(), fresh.prepare("SELECT * FROM counters").all());
});
