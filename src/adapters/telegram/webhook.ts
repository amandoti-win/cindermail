import { createAddress } from "../../core/db.ts";
import { buildCommandConfig } from "../../core/config.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import { createMailtmAddress } from "../../receivers/mailtm/address.ts";
import { sendMessage } from "./telegram-rest.ts";
import { handleUpdate, type TelegramUpdate } from "./commands.ts";

export interface TelegramWebhookEnv {
  DISPOSABLE_DOMAIN?: string;
  // Optional at the type level since a Worker not handling Telegram at all
  // (e.g. Discord-only) has no reason to set it -- but a request that
  // reaches this handler needs a real value, or every secret-token check
  // fails closed, since undefined can never equal a header value.
  TELEGRAM_BOT_TOKEN?: string;
  // Telegram echoes this back on every webhook call so a request can be
  // confirmed as actually coming from Telegram, not just anyone who finds
  // the URL. Set with `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, then
  // pass the same value as setWebhook's own secret_token parameter.
  TELEGRAM_WEBHOOK_SECRET?: string;
  [key: string]: unknown;
}

function usesOwnDomain(env: TelegramWebhookEnv): boolean {
  return !!env.DISPOSABLE_DOMAIN && env.DISPOSABLE_DOMAIN.trim() !== "";
}

// Shared by both src/worker.ts (Telegram-only or Telegram+Discord on one
// Worker) and src/telegram-worker.ts (Telegram split onto its own Worker,
// for whoever wants Discord and Telegram bundle-isolated from each other).
// Same handler either way; only which Worker's fetch() calls it differs.
export async function handleTelegramWebhookRequest(
  request: Request,
  env: TelegramWebhookEnv,
  db: SqlExecutor
): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Telegram not configured on this Worker", { status: 500 });
  }

  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("invalid secret token", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("malformed update", { status: 400 });
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

  // Anything non-2xx makes Telegram redeliver the update, which would re-run
  // a command whose side effects (rate-limit row, new address, mail.tm
  // account, torch) are already committed. So neither a failed handler nor a
  // reply Telegram refuses to deliver (bot blocked, no rights in a group) is
  // allowed to escape as a 500.
  let reply: Awaited<ReturnType<typeof handleUpdate>> = null;
  try {
    reply = await handleUpdate(update, db, createAddressFn, config);
  } catch (err) {
    console.error(`telegram command failed: ${err instanceof Error ? err.message : String(err)}`);
    if (update.message?.chat) {
      reply = { chatId: String(update.message.chat.id), text: "Something went wrong, try again in a moment." };
    }
  }
  if (reply) {
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, reply.chatId, reply.text);
    } catch (err) {
      console.warn(`telegram reply not delivered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Telegram retries a webhook that doesn't return 200 promptly. The reply
  // is already sent above via a direct API call, so this response body is
  // just an acknowledgement, not the reply itself.
  return new Response("ok");
}
