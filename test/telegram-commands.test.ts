import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandConfig } from "../src/core/config.ts";
import { handleCallbackQuery, handleUpdate } from "../src/adapters/telegram/commands.ts";
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

test("/torch all", async (t) => {
  const setup = async () => {
    const { db } = testDb();
    await createAddress(db, telegramOwner("7"), "ex.com", 86400, false, null);
    await createAddress(db, telegramOwner("7"), "ex.com", 86400, true, null);
    return db;
  };
  const tap = (db: SqlExecutor, data: string, chatType = "private", userId = 7) =>
    handleCallbackQuery(
      { callback_query: { id: "cb1", from: { id: userId }, data, message: { message_id: 42, chat: { id: userId, type: chatType } } } },
      db,
      config
    );

  await t.test("shows a confirm/cancel keyboard and deletes nothing", async () => {
    const db = await setup();
    const reply = await run(db, "7", "/torch ALL");
    assert.equal(reply?.text, "This will torch all 2 addresses and can't be undone.");
    assert.deepEqual(reply?.buttons, [
      { text: "Confirm", data: "torch_all:confirm:2" },
      { text: "Cancel", data: "torch_all:cancel" },
    ]);
    assert.match(telegramReplyText(await run(db, "7", "/list")), /^2\//);
  });

  await t.test("confirm torches them and says what it did on the same message", async () => {
    const db = await setup();
    const result = await tap(db, "torch_all:confirm:2");
    assert.deepEqual(result, { callbackId: "cb1", chatId: "7", messageId: 42, text: "Torched all 2 addresses." });
    assert.match(telegramReplyText(await run(db, "7", "/list")), /^0\//);
  });

  await t.test("cancel, stale, and invalid taps torch nothing", async () => {
    const db = await setup();
    assert.equal((await tap(db, "torch_all:cancel"))?.text, "Cancelled. Nothing was torched.");
    await createAddress(db, telegramOwner("7"), "ex.com", 86400, false, null);
    assert.match((await tap(db, "torch_all:confirm:2"))?.text ?? "", /changed since this was shown/);
    assert.match((await tap(db, "torch_all:confirm:x"))?.text ?? "", /isn't valid anymore/);
    assert.match((await tap(db, "elsewhere:1"))?.text ?? "", /isn't valid anymore/);
    assert.match(telegramReplyText(await run(db, "7", "/list")), /^3\//);
  });

  await t.test("only acts in a private chat, and for whoever tapped", async () => {
    const db = await setup();
    assert.equal(await tap(db, "torch_all:confirm:2", "supergroup"), null);
    // User 8 has nothing, so a button meant for user 7 can't make them torch anything of 7's.
    assert.match((await tap(db, "torch_all:confirm:2", "private", 8))?.text ?? "", /changed since this was shown/);
    assert.match(telegramReplyText(await run(db, "7", "/list")), /^2\//);
  });
});
