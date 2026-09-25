import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandConfig } from "../src/core/config.ts";
import { handleInteraction } from "../src/adapters/discord/interactions.ts";
import { createAddress, revokeAddress, setExpiryReminderPreference } from "../src/core/db.ts";
import { createDispatcher } from "../src/core/dispatch.ts";
import { sendExpiryWarnings } from "../src/core/expiry-warning.ts";
import type { SqlExecutor } from "../src/core/storage.ts";
import type { MailAdapter, OwnerRef } from "../src/core/types.ts";
import { command, owner, replyText, testDb } from "./helpers.ts";

const HOUR = 3600;
const config = buildCommandConfig({});
const createFn = (db: SqlExecutor, o: OwnerRef, ttl: number, permanent: boolean, note: string | null) =>
  createAddress(db, o, "ex.com", ttl, permanent, note);

// Records what was sent rather than asserting on it inline, so tests can
// check both how many DMs went out and what was in them.
function recordingAdapter(fail = false) {
  const sent: { ownerId: string; message: string }[] = [];
  const adapter: MailAdapter = {
    name: "discord",
    deliver: async () => ({ success: true }),
    notify: async (o, message) => {
      sent.push({ ownerId: o.id, message });
      return fail ? { success: false, error: "DMs closed" } : { success: true };
    },
  };
  return { dispatcher: createDispatcher([adapter]), sent };
}

async function optedInDb() {
  const { db } = testDb();
  await setExpiryReminderPreference(db, owner("u1"), true);
  return db;
}

test("expiry reminder window", async (t) => {
  await t.test("warns an address expiring inside the window", async () => {
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    assert.equal(await sendExpiryWarnings(db, dispatcher), 1);
    assert.equal(sent.length, 1);
  });

  await t.test("ignores one expiring too soon to give a day's notice", async () => {
    // Under 24h left. It was already warned yesterday when it sat at 44h, and
    // there's no honest way to give a day's warning now.
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 20 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    assert.equal(await sendExpiryWarnings(db, dispatcher), 0);
    assert.equal(sent.length, 0);
  });

  await t.test("ignores one still outside the window", async () => {
    // Caught by tomorrow's run instead, with 26h notice.
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 50 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    assert.equal(await sendExpiryWarnings(db, dispatcher), 0);
    assert.equal(sent.length, 0);
  });
});

test("expiry reminders are opt-in", async (t) => {
  await t.test("an owner who never opted in gets nothing", async () => {
    const { db } = testDb();
    await createAddress(db, owner("nobody"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    assert.equal(await sendExpiryWarnings(db, dispatcher), 0);
    assert.equal(sent.length, 0);
  });

  await t.test("an owner who opted back out gets nothing", async () => {
    const db = await optedInDb();
    await setExpiryReminderPreference(db, owner("u1"), false);
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    assert.equal(await sendExpiryWarnings(db, dispatcher), 0);
    assert.equal(sent.length, 0);
  });

  await t.test("only the opted-in owner is warned", async () => {
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    await createAddress(db, owner("u2"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    await sendExpiryWarnings(db, dispatcher);
    assert.deepEqual(
      sent.map((s) => s.ownerId),
      ["u1"]
    );
  });
});

test("what never warns", async (t) => {
  await t.test("permanent addresses", async () => {
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, true, null);
    const { dispatcher, sent } = recordingAdapter();
    await sendExpiryWarnings(db, dispatcher);
    assert.equal(sent.length, 0);
  });

  await t.test("torched addresses", async () => {
    const db = await optedInDb();
    const address = await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    await revokeAddress(db, owner("u1"), address);
    const { dispatcher, sent } = recordingAdapter();
    await sendExpiryWarnings(db, dispatcher);
    assert.equal(sent.length, 0);
  });
});

test("one DM per owner, not per address", async () => {
  const db = await optedInDb();
  await createAddress(db, owner("u1"), "ex.com", 26 * HOUR, false, "netflix");
  await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
  await createAddress(db, owner("u1"), "ex.com", 40 * HOUR, false, null);
  const { dispatcher, sent } = recordingAdapter();

  await sendExpiryWarnings(db, dispatcher);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message, /3 of your addresses/);
  assert.match(sent[0]!.message, /netflix/, "notes should be included so the list is readable");
});

test("a reminder is only sent once", async (t) => {
  await t.test("a second run in the same window sends nothing", async () => {
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    await sendExpiryWarnings(db, dispatcher);
    await sendExpiryWarnings(db, dispatcher);
    assert.equal(sent.length, 1);
  });

  await t.test("/extend re-arms it", async () => {
    // Without clearing the flag on extend, an address warned once would never
    // warn again however far its expiry moved.
    const db = await optedInDb();
    const address = await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    const { dispatcher, sent } = recordingAdapter();
    await sendExpiryWarnings(db, dispatcher);

    await handleInteraction(
      command("u1", "extend", [
        { name: "address_or_id", value: address },
        { name: "expiry", value: 2 },
      ]),
      db,
      createFn,
      config
    );
    await sendExpiryWarnings(db, dispatcher);
    assert.equal(sent.length, 2);
  });
});

test("a failed DM still marks the address warned", async () => {
  // Retrying every run against someone with closed DMs is worse than
  // dropping one non-critical notice.
  const db = await optedInDb();
  await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
  const { dispatcher, sent } = recordingAdapter(true);

  assert.equal(await sendExpiryWarnings(db, dispatcher), 0, "a failure is not counted as notified");
  await sendExpiryWarnings(db, dispatcher);
  assert.equal(sent.length, 1, "not retried on the next run");
});

// sendExpiryWarnings runs immediately before cleanup in the same cron, so
// anything escaping it stops expired addresses being deleted. Reminders are a
// convenience, cleanup isn't.
test("nothing escapes to break the cleanup behind it", async (t) => {
  await t.test("an adapter that throws", async () => {
    const db = await optedInDb();
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    const dispatcher = createDispatcher([
      {
        name: "discord",
        deliver: async () => ({ success: true }),
        notify: async () => {
          throw new Error("Discord is down");
        },
      },
    ]);
    await assert.doesNotReject(sendExpiryWarnings(db, dispatcher));
  });

  await t.test("one bad owner doesn't cost everyone else their reminder", async () => {
    const db = await optedInDb();
    await setExpiryReminderPreference(db, owner("u2"), true);
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    await createAddress(db, owner("u2"), "ex.com", 30 * HOUR, false, null);

    let calls = 0;
    const dispatcher = createDispatcher([
      {
        name: "discord",
        deliver: async () => ({ success: true }),
        notify: async () => {
          calls++;
          if (calls === 1) {
            throw new Error("first one blew up");
          }
          return { success: true };
        },
      },
    ]);
    assert.equal(await sendExpiryWarnings(db, dispatcher), 1);
    assert.equal(calls, 2, "the second owner is still attempted");
  });

  await t.test("a database that predates migration 0007", async () => {
    // The realistic failure: deploy the code, forget the migration, and the
    // first query hits a table that isn't there. A missing table silently
    // breaking mail has already happened once in this project.
    const { db, raw } = testDb();
    await setExpiryReminderPreference(db, owner("u1"), true);
    await createAddress(db, owner("u1"), "ex.com", 30 * HOUR, false, null);
    raw.exec("DROP TABLE owner_preferences");

    const { dispatcher, sent } = recordingAdapter();
    await assert.doesNotReject(sendExpiryWarnings(db, dispatcher));
    assert.equal(sent.length, 0);
  });
});

test("/remind", async (t) => {
  const run = (db: SqlExecutor, opts: { name: string; value: string | number | boolean }[] = []) =>
    handleInteraction(command("r", "remind", opts), db, createFn, config);

  await t.test("is off until asked for", async () => {
    const { db } = testDb();
    assert.match(replyText(await run(db)), /\*\*off\*\*/);
  });

  await t.test("turns on and reports on", async () => {
    const { db } = testDb();
    assert.match(replyText(await run(db, [{ name: "enabled", value: true }])), /\*\*on\*\*/);
    assert.match(replyText(await run(db)), /are \*\*on\*\*/);
  });

  await t.test("turns back off", async () => {
    const { db } = testDb();
    await run(db, [{ name: "enabled", value: true }]);
    assert.match(replyText(await run(db, [{ name: "enabled", value: false }])), /\*\*off\*\*/);
    assert.match(replyText(await run(db)), /are \*\*off\*\*/);
  });

  await t.test("checking the setting does not change it", async () => {
    const { db } = testDb();
    await run(db, [{ name: "enabled", value: true }]);
    await run(db);
    await run(db);
    assert.match(replyText(await run(db)), /are \*\*on\*\*/);
  });
});
