import { createAddress } from "../../core/db.ts";
import { buildCommandConfig } from "../../core/config.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import { createMailtmAddress } from "../../receivers/mailtm/address.ts";
import { verifySlackSignature } from "./slack-rest.ts";
import { handleSlashCommand, type SlackSlashCommandPayload } from "./commands.ts";

export interface SlackWebhookEnv {
  DISPOSABLE_DOMAIN?: string;
  // Optional at the type level for the same reason Telegram's bot token is:
  // a Worker not running Slack at all has no reason to set it, but a
  // request that reaches this handler needs a real value or every
  // signature check fails closed.
  SLACK_SIGNING_SECRET?: string;
  [key: string]: unknown;
}

function usesOwnDomain(env: SlackWebhookEnv): boolean {
  return !!env.DISPOSABLE_DOMAIN && env.DISPOSABLE_DOMAIN.trim() !== "";
}

// Slack expects a response within 3 seconds. Every handler is DB-only except
// /cm-new in mail.tm mode, which makes sequential calls to mail.tm; those are
// kept few (cached domain, capped retries) rather than moved to the async
// response_url path. A timeout there can still leave a created address the
// user didn't see; /cm-list shows it.
export async function handleSlackCommandRequest(
  request: Request,
  env: SlackWebhookEnv,
  db: SqlExecutor
): Promise<Response> {
  if (!env.SLACK_SIGNING_SECRET) {
    return new Response("Slack not configured on this Worker", { status: 500 });
  }

  const signature = request.headers.get("X-Slack-Signature");
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  if (!signature || !timestamp) {
    return new Response("missing signature headers", { status: 401 });
  }
  // Slash-command bodies are a few hundred bytes; don't buffer arbitrary
  // unauthenticated uploads before the signature can be checked.
  if (Number(request.headers.get("Content-Length") ?? 0) > 64 * 1024) {
    return new Response("payload too large", { status: 413 });
  }
  const rawBody = await request.text();

  const isValid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, rawBody, timestamp, signature);
  if (!isValid) {
    return new Response("invalid request signature", { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const payload: SlackSlashCommandPayload = {
    command: form.get("command") ?? "",
    text: form.get("text") ?? "",
    user_id: form.get("user_id") ?? "",
  };
  if (!payload.command || !payload.user_id) {
    return new Response("malformed slash command payload", { status: 400 });
  }

  const config = buildCommandConfig(env as Record<string, string | undefined>);
  const domain = env.DISPOSABLE_DOMAIN;
  const createAddressFn = usesOwnDomain(env)
    ? (
        executor: SqlExecutor,
        owner: { type: string; id: string },
        ttl: number,
        permanent: boolean,
        note: string | null
      ) => createAddress(executor, owner, domain as string, ttl, permanent, note)
    : createMailtmAddress;

  const text = await handleSlashCommand(payload, db, createAddressFn, config);

  // response_type "ephemeral" is Slack's native equivalent of Discord's
  // ephemeral replies: visible only to whoever ran the command, regardless
  // of which channel or DM it was run from. Unlike Telegram, that means
  // there's no need to refuse non-DM use -- a reply in a busy channel is
  // still private to the person who typed it.
  return Response.json({ response_type: "ephemeral", text });
}
