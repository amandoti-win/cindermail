import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandConfig } from "../src/core/config.ts";
import { handleUpdate } from "../src/adapters/telegram/commands.ts";
import { createAddress, getAddress } from "../src/core/db.ts";
import type { SqlExecutor } from "../src/core/storage.ts";
import type { OwnerRef } from "../src/core/types.ts";
import { telegramOwner, telegramReplyAddress, telegramReplyText, telegramUpdate, testDb } from "./helpers.ts";

const DAY = 86400;
const config = buildCommandConfig({});
const createFn = (db: SqlExecutor, o: OwnerRef, ttl: number, permanent: boolean, note: string | null) =>
  createAddress(db, o, "ex.com", ttl, permanent, note);

const run = (db: SqlExecutor, userId: string, text: string) =>
  handleUpdate(telegramUpdate(userId, text), db, createFn, config);

let seq = 0;
const freshUser = () => `${100000 + seq++}`;

test("/new expiry", async (t) => {
  await t.test("is permanent when expiry is omitted", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "/new");
    assert.match(telegramReplyText(reply), /Permanent/);
    assert.equal((await getAddress(db, telegramReplyAddress(reply)))?.permanent, 1);
  });

  await t.test("a leading integer is the expiry", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "/new 3");
    assert.match(telegramReplyText(reply), /Expires in 3 days/);
    const row = await getAddress(db, telegramReplyAddress(reply));
    assert.equal(row?.permanent, 0);
  });

  await t.test("expiry 0 is also permanent", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "/new 0");
    assert.equal((await getAddress(db, telegramReplyAddress(reply)))?.permanent, 1);
  });

  await t.test("no leading integer means the whole remainder is a note, no expiry", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "/new netflix signup");
    assert.match(telegramReplyText(reply), /Permanent/);
    assert.equal((await getAddress(db, telegramReplyAddress(reply)))?.note, "netflix signup");
  });

  await t.test("rejects an out-of-range expiry", async () => {
    const { db } = testDb();
    assert.match(telegramReplyText(await run(db, freshUser(), "/new 99999")), /whole number/);
  });
});

test("/list", async (t) => {
  await t.test("shows a quota line even with no active addresses", async () => {
    const { db } = testDb();
    assert.equal(telegramReplyText(await run(db, freshUser(), "/list")), `0/${config.maxActiveAddresses} active addresses.`);
  });

  await t.test("counts what's actually active", async () => {
    const { db } = testDb();
    const user = freshUser();
    await createAddress(db, telegramOwner(user), "ex.com", DAY, false, null);
    assert.match(
      telegramReplyText(await run(db, user, "/list")),
      new RegExp(`^1/${config.maxActiveAddresses} active addresses:`)
    );
  });
});

test("/extend", async (t) => {
  await t.test("address comes first, expiry (if any) comes last", async () => {
    const { db } = testDb();
    const user = freshUser();
    const address = await createAddress(db, telegramOwner(user), "ex.com", 10 * DAY, false, null);
    const reply = await run(db, user, `/extend ${address} 5`);
    assert.match(telegramReplyText(reply), /now expires in 5 days/);
  });

  await t.test("omitting the trailing expiry uses the configured default", async () => {
    const { db } = testDb();
    const user = freshUser();
    const address = await createAddress(db, telegramOwner(user), "ex.com", 10 * DAY, false, null);
    const reply = await run(db, user, `/extend ${address}`);
    assert.match(telegramReplyText(reply), /now expires in 10 days/);
  });

  await t.test("refuses an address belonging to someone else", async () => {
    const { db } = testDb();
    const address = await createAddress(db, telegramOwner(freshUser()), "ex.com", DAY, false, null);
    assert.match(telegramReplyText(await run(db, freshUser(), `/extend ${address}`)), /Not found/);
  });
});

test("/note and /torch accept a mangled address", async (t) => {
  await t.test("/torch is case-insensitive", async () => {
    const { db } = testDb();
    const user = freshUser();
    const address = await createAddress(db, telegramOwner(user), "ex.com", DAY, false, null);
    assert.match(telegramReplyText(await run(db, user, `/torch ${address.toUpperCase()}`)), /Torched/);
  });

  await t.test("/note labels and a blank note clears it", async () => {
    const { db } = testDb();
    const user = freshUser();
    const address = await createAddress(db, telegramOwner(user), "ex.com", DAY, false, "first");
    await run(db, user, `/note ${address} second`);
    assert.equal((await getAddress(db, address))?.note, "second");
    await run(db, user, `/note ${address}`);
    assert.equal((await getAddress(db, address))?.note, null);
  });
});

test("/remind reports status when no argument is given, and toggles otherwise", async () => {
  const { db } = testDb();
  const user = freshUser();
  assert.match(telegramReplyText(await run(db, user, "/remind")), /are off/);
  assert.match(telegramReplyText(await run(db, user, "/remind on")), /reminders on/);
  assert.match(telegramReplyText(await run(db, user, "/remind")), /are on/);
});

test("group chats are refused without touching any address data", async () => {
  const { db } = testDb();
  const update = telegramUpdate("1", "/new", "group", -100);
  const reply = await handleUpdate(update, db, createFn, config);
  assert.match(telegramReplyText(reply), /Message me directly/);
});

test("unknown commands are rejected", async () => {
  const { db } = testDb();
  assert.match(telegramReplyText(await run(db, freshUser(), "/definitely-not-a-command")), /Unknown command/);
});

test("non-command messages are ignored entirely", async () => {
  const { db } = testDb();
  const reply = await handleUpdate(telegramUpdate("1", "just chatting, not a command"), db, createFn, config);
  assert.equal(reply, null);
});

test("/torch all", async () => {
  const { db } = testDb();
  await createAddress(db, telegramOwner("7"), "ex.com", 86400, false, null);
  await createAddress(db, telegramOwner("7"), "ex.com", 86400, true, null);

  const preview = telegramReplyText(await run(db, "7", "/torch all"));
  assert.match(preview, /This will torch all 2 addresses and can't be undone/);
  assert.match(preview, /\/torch all confirm/);
  assert.match(telegramReplyText(await run(db, "7", "/torch ALL confirmed")), /This will torch/);
  assert.match(telegramReplyText(await run(db, "7", "/list")), /^2\//);

  assert.equal(telegramReplyText(await run(db, "7", "/torch all confirm")), "Torched all 2 addresses.");
  assert.equal(telegramReplyText(await run(db, "7", "/torch all confirm")), "You have no active addresses to torch.");
});
