import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleSlackCommandRequest, handleSlackInteractionRequest, type SlackWebhookEnv } from "../src/adapters/slack/webhook.ts";
import { createAddress } from "../src/core/db.ts";
import { testDb } from "./helpers.ts";

const SIGNING_SECRET = "test-signing-secret";
const BASE_ENV: SlackWebhookEnv = { SLACK_SIGNING_SECRET: SIGNING_SECRET };

function sign(body: string, timestamp: string, secret: string = SIGNING_SECRET): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

function slashRequest(
  form: Record<string, string>,
  opts: { timestamp?: string; signature?: string; skipSignature?: boolean } = {}
): Request {
  const body = new URLSearchParams(form).toString();
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (!opts.skipSignature) {
    headers["X-Slack-Request-Timestamp"] = timestamp;
    headers["X-Slack-Signature"] = opts.signature ?? sign(body, timestamp);
  }
  return new Request("https://example.com/slack/commands", { method: "POST", headers, body });
}

test("rejects a request with a bad signature", async () => {
  const { db } = testDb();
  const req = slashRequest({ command: "/cm-list", text: "", user_id: "U1" }, { signature: "v0=deadbeef" });
  const res = await handleSlackCommandRequest(req, BASE_ENV, db);
  assert.equal(res.status, 401);
});

test("rejects a request with no signature headers at all", async () => {
  const { db } = testDb();
  const req = slashRequest({ command: "/cm-list", text: "", user_id: "U1" }, { skipSignature: true });
  const res = await handleSlackCommandRequest(req, BASE_ENV, db);
  assert.equal(res.status, 401);
});

test("rejects a stale timestamp (replay protection)", async () => {
  const { db } = testDb();
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 60 * 10);
  const req = slashRequest({ command: "/cm-list", text: "", user_id: "U1" }, { timestamp: staleTimestamp });
  const res = await handleSlackCommandRequest(req, BASE_ENV, db);
  assert.equal(res.status, 401);
});

test("accepts a correctly signed request and replies ephemerally", async () => {
  const { db } = testDb();
  const req = slashRequest({ command: "/cm-list", text: "", user_id: "U1" });
  const res = await handleSlackCommandRequest(req, BASE_ENV, db);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { response_type: string; text: string };
  assert.equal(body.response_type, "ephemeral");
  assert.match(body.text, /active addresses/);
});

test("rejects a payload missing command or user_id", async () => {
  const { db } = testDb();
  const req = slashRequest({ command: "", text: "", user_id: "" });
  const res = await handleSlackCommandRequest(req, BASE_ENV, db);
  assert.equal(res.status, 400);
});

test("fails closed (500) when this Worker has no Slack config at all", async () => {
  const { db } = testDb();
  const req = slashRequest({ command: "/cm-list", text: "", user_id: "U1" });
  const res = await handleSlackCommandRequest(req, {}, db);
  assert.equal(res.status, 500);
});

// Slack button clicks: a signed form field `payload` holding JSON, answered by
// POSTing to the click's response_url rather than in the HTTP reply.
function clickRequest(
  payload: Record<string, unknown>,
  opts: { timestamp?: string; signature?: string } = {}
): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": opts.signature ?? sign(body, timestamp),
    },
    body,
  });
}

const click = (value: string, over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "U1" },
  response_url: "https://hooks.slack.com/actions/T0/B0/xyz",
  actions: [{ action_id: `torch_all:${value.split(":")[0]}`, value }],
  ...over,
});

async function withCapturedReplies<T>(fn: () => Promise<T>): Promise<{ result: T; sent: { url: string; body: Record<string, unknown> }[] }> {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  }) as typeof fetch;
  try {
    return { result: await fn(), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("button click: confirm torches the clicker's addresses and replaces the message", async () => {
  const { db } = testDb();
  await createAddress(db, { type: "slack", id: "U1" }, "ex.com", 86400, false, null);
  await createAddress(db, { type: "slack", id: "U2" }, "ex.com", 86400, false, null);
  const { result, sent } = await withCapturedReplies(() =>
    handleSlackInteractionRequest(clickRequest(click("confirm:1")), BASE_ENV, db)
  );
  assert.equal(result.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://hooks.slack.com/actions/T0/B0/xyz");
  assert.deepEqual(sent[0]?.body, { response_type: "ephemeral", replace_original: true, text: "Torched all 1 address." });
  const left = await db.all<{ owner_id: string }>("SELECT owner_id FROM addresses WHERE revoked = 0");
  assert.deepEqual(left.map((r) => r.owner_id), ["U2"], "the other user's address is untouched");
});

test("button click: cancel and stale clicks torch nothing", async () => {
  const { db } = testDb();
  await createAddress(db, { type: "slack", id: "U1" }, "ex.com", 86400, false, null);
  const cancelled = await withCapturedReplies(() =>
    handleSlackInteractionRequest(clickRequest(click("cancel")), BASE_ENV, db)
  );
  assert.equal(cancelled.sent[0]?.body.text, "Cancelled. Nothing was torched.");
  const stale = await withCapturedReplies(() =>
    handleSlackInteractionRequest(clickRequest(click("confirm:5")), BASE_ENV, db)
  );
  assert.match(String(stale.sent[0]?.body.text), /changed since this was shown/);
  assert.equal((await db.all("SELECT 1 FROM addresses WHERE revoked = 0")).length, 1);
});

test("button click: rejects a bad signature, a stale timestamp, and a response_url that isn't Slack's", async () => {
  const { db } = testDb();
  await createAddress(db, { type: "slack", id: "U1" }, "ex.com", 86400, false, null);
  const send = (req: Request) => withCapturedReplies(() => handleSlackInteractionRequest(req, BASE_ENV, db));

  const badSig = await send(clickRequest(click("confirm:1"), { signature: "v0=deadbeef" }));
  assert.equal(badSig.result.status, 401);
  const stale = await send(clickRequest(click("confirm:1"), { timestamp: String(Math.floor(Date.now() / 1000) - 600) }));
  assert.equal(stale.result.status, 401);
  for (const url of ["https://evil.example/hooks.slack.com/", "http://hooks.slack.com/x", "https://hooks.slack.com.evil.example/x"]) {
    const res = await send(clickRequest(click("confirm:1", { response_url: url })));
    assert.equal(res.result.status, 400, url);
    assert.equal(res.sent.length, 0, "never called a URL Slack didn't hand out");
  }
  assert.equal((await db.all("SELECT 1 FROM addresses WHERE revoked = 0")).length, 1, "nothing was torched by any of those");
});

test("button click: ignores anything that isn't one of this bot's buttons", async () => {
  const { db } = testDb();
  const res = await handleSlackInteractionRequest(
    clickRequest(click("confirm:1", { actions: [{ action_id: "other_action", value: "confirm:1" }] })),
    BASE_ENV,
    db
  );
  assert.equal(res.status, 400);
});
