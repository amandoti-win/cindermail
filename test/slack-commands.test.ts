import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandConfig } from "../src/core/config.ts";
import { handleSlashCommand, handleSlashCommandRich } from "../src/adapters/slack/commands.ts";
import { createAddress, getAddress } from "../src/core/db.ts";
import type { SqlExecutor } from "../src/core/storage.ts";
import type { OwnerRef } from "../src/core/types.ts";
import { slackPayload, testDb } from "./helpers.ts";

const config = buildCommandConfig({});
const createFn = (db: SqlExecutor, o: OwnerRef, ttl: number, permanent: boolean, note: string | null) =>
  createAddress(db, o, "ex.com", ttl, permanent, note);

const run = (db: SqlExecutor, userId: string, command: string, text: string = "") =>
  handleSlashCommand(slackPayload(userId, command, text), db, createFn, config);

let seq = 0;
const freshUser = () => `U${100000 + seq++}`;

// The address a reply embeds, same "address: <addr>" shape Telegram's plain
// text replies use, since both hand back a bare string rather than a
// wrapped object.
const replyAddress = (reply: string): string => (reply.match(/address: (?:#\d+ )?(\S+)/) ?? [])[1] ?? "";

test("strips the /cm- prefix so the same command names as Discord/Telegram apply", async () => {
  const { db } = testDb();
  const reply = await run(db, freshUser(), "/cm-new");
  assert.match(reply, /Your new disposable address/);
});

test("/cm-new reports the short id it just allocated", async () => {
  const { db } = testDb();
  const reply = await run(db, freshUser(), "/cm-new");
  const stored = await getAddress(db, replyAddress(reply));
  assert.ok(stored?.short_id && reply.includes(`address: #${stored.short_id} ${stored.address}`));
});

test("an unprefixed or unknown command is rejected, not silently handled", async () => {
  const { db } = testDb();
  const reply = await run(db, freshUser(), "/cm-bogus");
  assert.equal(reply, "Unknown command.");
});

test("/cm-new then /cm-list shows the created address", async () => {
  const { db } = testDb();
  const user = freshUser();
  const created = await run(db, user, "/cm-new", "7 test note");
  const address = replyAddress(created);
  assert.ok(address);

  const listed = await run(db, user, "/cm-list");
  assert.match(listed, new RegExp(address));
  assert.match(listed, /test note/);
});

test("/cm-torch revokes an address owned by that user", async () => {
  const { db } = testDb();
  const user = freshUser();
  const created = await run(db, user, "/cm-new");
  const address = replyAddress(created);

  const reply = await run(db, user, "/cm-torch", address);
  assert.match(reply, /Torched/);
  assert.equal((await getAddress(db, address))?.revoked, 1);
});

test("/cm-torch refuses an address owned by someone else", async () => {
  const { db } = testDb();
  const owner = freshUser();
  const other = freshUser();
  const created = await run(db, owner, "/cm-new");
  const address = replyAddress(created);

  const reply = await run(db, other, "/cm-torch", address);
  assert.match(reply, /Not found or not yours/);
});

test("/cm-remind with no argument reports current state instead of erroring", async () => {
  const { db } = testDb();
  const reply = await run(db, freshUser(), "/cm-remind");
  assert.match(reply, /off/);
});

test("/cm-remind on then off round-trips the preference", async () => {
  const { db } = testDb();
  const user = freshUser();
  assert.match(await run(db, user, "/cm-remind", "on"), /reminders on/i);
  assert.match(await run(db, user, "/cm-remind"), /are on/);
  assert.match(await run(db, user, "/cm-remind", "off"), /reminders off/i);
});

test("/cm-torch all", async () => {
  const { db } = testDb();
  await createAddress(db, { type: "slack", id: "s" }, "ex.com", 86400, false, null);

  const reply = await handleSlashCommandRich(slackPayload("s", "/cm-torch", "all"), db, createFn, config);
  assert.equal(reply.text, "This will torch all 1 address and can't be undone.");
  const actions = (reply.blocks?.[1] as { elements: { action_id: string; value: string }[] }).elements;
  assert.deepEqual(
    actions.map((a) => [a.action_id, a.value]),
    [
      ["torch_all:confirm", "confirm:1"],
      ["torch_all:cancel", "cancel"],
    ]
  );
  assert.match(await run(db, "s", "/cm-list"), /^1\//, "the preview deletes nothing");

  const empty = await handleSlashCommandRich(slackPayload("nobody", "/cm-torch", "all"), db, createFn, config);
  assert.equal(empty.text, "You have no active addresses to torch.");
  assert.equal(empty.blocks, undefined);
});
