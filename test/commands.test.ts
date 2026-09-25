import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandConfig } from "../src/core/config.ts";
import { handleInteraction } from "../src/adapters/discord/interactions.ts";
import { createAddress, getAddress } from "../src/core/db.ts";
import type { SqlExecutor } from "../src/core/storage.ts";
import type { OwnerRef } from "../src/core/types.ts";
import { command, owner, replyAddress, replyText, testDb } from "./helpers.ts";

const DAY = 86400;
const config = buildCommandConfig({});
const createFn = (db: SqlExecutor, o: OwnerRef, ttl: number, permanent: boolean, note: string | null) =>
  createAddress(db, o, "ex.com", ttl, permanent, note);

const run = (db: SqlExecutor, userId: string, name: string, opts: { name: string; value: string | number }[] = []) =>
  handleInteraction(command(userId, name, opts), db, createFn, config);

// /new is rate limited to one call per 30s per owner, so anything creating
// more than one address has to use a fresh owner id each time.
let seq = 0;
const freshUser = () => `u${seq++}`;

test("/new expiry", async (t) => {
  await t.test("is permanent when expiry is omitted", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "new");
    assert.match(replyText(reply), /Permanent/);
    assert.equal((await getAddress(db, replyAddress(reply)))?.permanent, 1);
  });

  await t.test("expiry: 0 is also permanent", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "new", [{ name: "expiry", value: 0 }]);
    assert.equal((await getAddress(db, replyAddress(reply)))?.permanent, 1);
  });

  await t.test("expiry in days sets a real expiry", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "new", [{ name: "expiry", value: 3 }]);
    assert.match(replyText(reply), /Expires in 3 days/);
    const row = await getAddress(db, replyAddress(reply));
    assert.equal(row?.permanent, 0);
    assert.ok(Math.abs((row?.expires_at ?? 0) - (Date.now() / 1000 + 3 * DAY)) < 60);
  });

  await t.test("keeps a future expires_at even on permanent rows", async () => {
    // core/db.ts relies on this so that dropping the flag later leaves a
    // usable date rather than one that lapsed while it was permanent.
    const { db } = testDb();
    const reply = await run(db, freshUser(), "new");
    const row = await getAddress(db, replyAddress(reply));
    assert.ok((row?.expires_at ?? 0) > Date.now() / 1000 + 9 * DAY);
  });

  await t.test("says day, not days, for one", async () => {
    const { db } = testDb();
    assert.match(replyText(await run(db, freshUser(), "new", [{ name: "expiry", value: 1 }])), /Expires in 1 day\./);
  });

  await t.test("rejects out-of-range values", async () => {
    const { db } = testDb();
    assert.match(replyText(await run(db, freshUser(), "new", [{ name: "expiry", value: -5 }])), /whole number/);
    assert.match(replyText(await run(db, freshUser(), "new", [{ name: "expiry", value: 99999 }])), /whole number/);
  });
});

test("/extend expiry", async (t) => {
  const setup = async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("ext"), "ex.com", 10 * DAY, false, null);
    return { db, address };
  };

  await t.test("uses the configured default when expiry is omitted", async () => {
    // Deliberately different from /new: a command called "extend" doing
    // something other than extending would be worse than the asymmetry.
    const { db, address } = await setup();
    assert.match(replyText(await run(db, "ext", "extend", [{ name: "address", value: address }])), /expires in 10 days/);
    assert.equal((await getAddress(db, address))?.permanent, 0);
  });

  await t.test("sets expiry relative to now, not additively", async () => {
    const { db, address } = await setup();
    await run(db, "ext", "extend", [
      { name: "address", value: address },
      { name: "expiry", value: 5 },
    ]);
    const row = await getAddress(db, address);
    assert.ok(Math.abs((row?.expires_at ?? 0) - (Date.now() / 1000 + 5 * DAY)) < 60);
  });

  await t.test("expiry: 0 makes it permanent without lapsing the date", async () => {
    const { db, address } = await setup();
    assert.match(
      replyText(await run(db, "ext", "extend", [
        { name: "address", value: address },
        { name: "expiry", value: 0 },
      ])),
      /now permanent/
    );
    const row = await getAddress(db, address);
    assert.equal(row?.permanent, 1);
    assert.ok((row?.expires_at ?? 0) > Date.now() / 1000 + 9 * DAY);
  });

  await t.test("a later expiry puts a permanent address back on the clock", async () => {
    const { db, address } = await setup();
    await run(db, "ext", "extend", [{ name: "address", value: address }, { name: "expiry", value: 0 }]);
    await run(db, "ext", "extend", [{ name: "address", value: address }, { name: "expiry", value: 7 }]);
    assert.equal((await getAddress(db, address))?.permanent, 0);
  });

  await t.test("refuses an address belonging to someone else", async () => {
    const { db, address } = await setup();
    assert.match(replyText(await run(db, "someone-else", "extend", [{ name: "address", value: address }])), /Not found/);
  });
});

// Addresses are stored lowercase. Phone keyboards autocapitalise the first
// letter and copy/paste picks up whitespace, and without normalising both
// come back as "Not found or not yours", which reads like an ownership
// problem rather than a typo.
test("address input is normalised", async (t) => {
  for (const [label, mangle] of [
    ["uppercased", (a: string) => a.toUpperCase()],
    ["padded with spaces", (a: string) => ` ${a} `],
    ["both", (a: string) => `  ${a.toUpperCase()}\t`],
  ] as const) {
    await t.test(`/torch accepts an address ${label}`, async () => {
      const { db } = testDb();
      const address = await createAddress(db, owner("n"), "ex.com", DAY, false, null);
      assert.match(replyText(await run(db, "n", "torch", [{ name: "address", value: mangle(address) }])), /Torched/);
    });
  }

  await t.test("/note accepts a mangled address", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    const reply = await run(db, "n", "note", [
      { name: "address", value: ` ${address.toUpperCase()} ` },
      { name: "note", value: "x" },
    ]);
    assert.match(replyText(reply), /labelled/);
  });
});

test("short id in place of the full address", async (t) => {
  await t.test("/list shows the short id next to each address", async () => {
    const { db } = testDb();
    await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    const listReply = replyText(await run(db, "n", "list"));
    assert.match(listReply, /^\d+\/\d+ active addresses:\n#\d{5} `/);
  });

  await t.test("/torch accepts the short id instead of the address", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    const listReply = replyText(await run(db, "n", "list"));
    const shortId = listReply.match(/#(\d{5})/)?.[1] ?? "";

    const reply = await run(db, "n", "torch", [{ name: "address", value: shortId }]);
    assert.match(replyText(reply), new RegExp(`Torched \`${address}\``));
  });

  await t.test("someone else's short id resolves to nothing", async () => {
    const { db } = testDb();
    await createAddress(db, owner("owner-1"), "ex.com", DAY, false, null);
    const listReply = replyText(await run(db, "owner-1", "list"));
    const shortId = listReply.match(/#(\d{5})/)?.[1] ?? "";

    const reply = await run(db, "owner-2", "torch", [{ name: "address", value: shortId }]);
    assert.match(replyText(reply), /Not found/);
  });
});

test("notes", async (t) => {
  await t.test("/new stores and echoes a note", async () => {
    const { db } = testDb();
    const reply = await run(db, freshUser(), "new", [{ name: "note", value: "netflix signup" }]);
    assert.match(replyText(reply), /\(netflix signup\)/);
    assert.equal((await getAddress(db, replyAddress(reply)))?.note, "netflix signup");
  });

  await t.test("no note stores NULL rather than an empty string", async () => {
    const { db } = testDb();
    assert.equal((await getAddress(db, replyAddress(await run(db, freshUser(), "new"))))?.note, null);
  });

  await t.test("/note relabels, and a blank value clears it", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("n"), "ex.com", DAY, false, "first");
    await run(db, "n", "note", [{ name: "address", value: address }, { name: "note", value: "second" }]);
    assert.equal((await getAddress(db, address))?.note, "second");
    await run(db, "n", "note", [{ name: "address", value: address }]);
    assert.equal((await getAddress(db, address))?.note, null);
  });

  await t.test("/list strips backticks so a note cannot break the code span", async () => {
    const { db } = testDb();
    const address = await createAddress(db, owner("n"), "ex.com", DAY, false, "ev`il` x");
    const out = replyText(await run(db, "n", "list"));
    assert.equal(out.replaceAll(`\`${address}\``, "").includes("`"), false, out);
  });

  await t.test("/list shows permanence instead of a countdown", async () => {
    const { db } = testDb();
    await createAddress(db, owner("n"), "ex.com", DAY, true, null);
    assert.match(replyText(await run(db, "n", "list")), /\(permanent\)/);
  });

  await t.test("/list shows a quota line even with no active addresses", async () => {
    const { db } = testDb();
    assert.equal(replyText(await run(db, "n", "list")), `0/${config.maxActiveAddresses} active addresses.`);
  });

  await t.test("/list's quota line reflects how many are actually active", async () => {
    const { db } = testDb();
    await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    assert.match(replyText(await run(db, "n", "list")), new RegExp(`^2/${config.maxActiveAddresses} active addresses:`));
  });

  await t.test("/new's refusal at the cap reports current/max, not just max", async () => {
    const { db } = testDb();
    for (let i = 0; i < config.maxActiveAddresses; i++) {
      await createAddress(db, owner("n"), "ex.com", DAY, false, null);
    }
    assert.match(
      replyText(await run(db, "n", "new")),
      new RegExp(`${config.maxActiveAddresses}/${config.maxActiveAddresses} active addresses`)
    );
  });
});

test("unknown commands are rejected", async () => {
  const { db } = testDb();
  assert.match(replyText(await run(db, "n", "definitely-not-a-command")), /Unknown command/);
});
