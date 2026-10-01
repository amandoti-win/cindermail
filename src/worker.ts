import { verifyKey } from "discord-interactions";
import { createDiscordAdapter } from "./adapters/discord/index.ts";
import { createTelegramAdapter } from "./adapters/telegram/index.ts";
import { handleTelegramWebhookRequest } from "./adapters/telegram/webhook.ts";
import { createSlackAdapter } from "./adapters/slack/index.ts";
import { handleSlackCommandRequest } from "./adapters/slack/webhook.ts";
import { buildCommandConfig } from "./core/config.ts";
import { handleInteraction, type DiscordInteraction } from "./adapters/discord/interactions.ts";
import { backfillShortIds, createAddress, getCounters } from "./core/db.ts";
import { createDispatcher } from "./core/dispatch.ts";
import { handleInboundEmail } from "./core/email.ts";
import { sendExpiryWarnings } from "./core/expiry-warning.ts";
import type { MailAdapter, OwnerRef } from "./core/types.ts";
import { renderCounterPage } from "./counter-page.ts";
import { createMailtmAddress } from "./receivers/mailtm/address.ts";
import { runMailtmCleanup } from "./receivers/mailtm/cleanup.ts";
import { pollOnce } from "./receivers/mailtm/poller.ts";
import { createD1Executor } from "./storage/d1.ts";
import pkg from "../package.json";

// One Worker, two modes, picked by whether DISPOSABLE_DOMAIN is set:
//
//   set   -> your own domain. Mail arrives through Email Routing's catch-all
//            hitting email() below. Needs DNS and a zone.
//   unset -> mail.tm. Addresses are provisioned on mail.tm's domain and
//            their API is polled on a cron instead, no domain, no DNS, no
//            Email Routing. email() is never invoked because nothing routes
//            mail here.
//
// Everything else (commands, storage, delivery, cleanup, the status page) is
// identical between them, which is why this is a runtime branch rather than
// two entrypoints to keep in sync.
export interface Env {
  DB: D1Database;
  // Optional: leave unset to run in mail.tm mode.
  DISPOSABLE_DOMAIN?: string;
  ADAPTERS: string;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  // Only needed if ADAPTERS includes "telegram". Used both to deliver
  // outbound mail/reminders to Telegram users, and (if you're pointing
  // Telegram's webhook at this Worker rather than a separate one -- see
  // docs/telegram-adapter.md) to reply to commands.
  TELEGRAM_BOT_TOKEN?: string;
  // Only needed if you're handling the Telegram webhook on this Worker.
  // Unused if you deploy src/telegram-worker.ts separately instead.
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Only needed if ADAPTERS includes "slack". Used both to deliver outbound
  // mail/reminders to Slack users and to reply to slash commands.
  SLACK_BOT_TOKEN?: string;
  // Verifies incoming slash command requests are really from Slack.
  SLACK_SIGNING_SECRET?: string;
  // Optional overrides for core/config.ts defaults, see
  // docs/configuration.md for the full list of accepted vars.
  [key: string]: unknown;
}

// Matches the daily schedule in wrangler.jsonc. Every other cron that fires
// is the frequent mail.tm poll, which no-ops immediately in domain mode.
const CLEANUP_CRON = "0 3 * * *";

function usesOwnDomain(env: Env): boolean {
  return !!env.DISPOSABLE_DOMAIN && env.DISPOSABLE_DOMAIN.trim() !== "";
}

function buildAdapters(env: Env): MailAdapter[] {
  const enabled = env.ADAPTERS.split(",").map((s) => s.trim());
  const adapters: MailAdapter[] = [];
  if (enabled.includes("discord")) {
    adapters.push(createDiscordAdapter(env.DISCORD_TOKEN));
  }
  if (enabled.includes("telegram") && env.TELEGRAM_BOT_TOKEN) {
    adapters.push(createTelegramAdapter(env.TELEGRAM_BOT_TOKEN));
  }
  if (enabled.includes("slack") && env.SLACK_BOT_TOKEN) {
    adapters.push(createSlackAdapter(env.SLACK_BOT_TOKEN));
  }
  return adapters;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderCounterPage(pkg.version), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      return handleTelegramWebhookRequest(request, env, createD1Executor(env.DB));
    }

    if (request.method === "POST" && url.pathname === "/slack/commands") {
      return handleSlackCommandRequest(request, env, createD1Executor(env.DB));
    }

    if (request.method === "GET" && url.pathname === "/counters") {
      const db = createD1Executor(env.DB);
      const counters = await getCounters(db);
      // Public and unauthenticated, and the user count is a full scan of the
      // addresses table. Cache so hammering this can't run up D1 reads; the
      // page's own client-side cache only hits this every 30 minutes at
      // most anyway, so nothing here needs to be fresher.
      return Response.json(counters, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }

    if (request.method === "POST" && url.pathname === "/interactions") {
      const signature = request.headers.get("X-Signature-Ed25519");
      const timestamp = request.headers.get("X-Signature-Timestamp");
      const rawBody = await request.text();

      if (!signature || !timestamp) {
        return new Response("missing signature headers", { status: 401 });
      }

      const isValid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
      if (!isValid) {
        return new Response("invalid request signature", { status: 401 });
      }

      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(rawBody) as DiscordInteraction;
      } catch {
        return new Response("malformed interaction payload", { status: 400 });
      }

      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }

      if (interaction.type === 2) {
        const db = createD1Executor(env.DB);
        const config = buildCommandConfig(env as Record<string, string | undefined>);
        const domain = env.DISPOSABLE_DOMAIN;
        // The only thing that actually differs between the two modes:
        // where a new address comes from. createMailtmAddress already
        // matches CreateAddressFn's signature, createAddress needs the
        // domain bound in.
        const createAddressFn = usesOwnDomain(env)
          ? (
              executor: ReturnType<typeof createD1Executor>,
              owner: OwnerRef,
              ttl: number,
              permanent: boolean,
              note: string | null
            ) => createAddress(executor, owner, domain as string, ttl, permanent, note)
          : createMailtmAddress;
        const result = await handleInteraction(interaction, db, createAddressFn, config);
        return Response.json(result);
      }

      return new Response("unsupported interaction type", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const db = createD1Executor(env.DB);
    const dispatcher = createDispatcher(buildAdapters(env));
    await handleInboundEmail({ to: message.to, from: message.from, raw: message.raw }, db, dispatcher);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const db = createD1Executor(env.DB);

    // Not gated on this Worker's own DISPOSABLE_DOMAIN: a mail.tm-backed
    // address can exist in this same database even when this Worker is in
    // domain mode, created by another adapter (e.g. the Telegram Worker)
    // that's independently in mail.tm mode. pollOnce already no-ops cheaply
    // when there's nothing mail.tm-backed to poll, so there's no benefit to
    // skipping the call based on a setting that no longer tells you whether
    // any row actually needs it.
    if (event.cron !== CLEANUP_CRON) {
      await pollOnce(db, createDispatcher(buildAdapters(env)));
      return;
    }

    // Before the cleanup below, so an address can't be deleted in the same
    // run that was about to warn about it. Only reaches owners who opted in
    // via /remind, and never throws, so a reminder failure can't stop
    // cleanup from running.
    await sendExpiryWarnings(db, createDispatcher(buildAdapters(env)));

    // Convenience only, so a failure is logged and never allowed to stop the
    // cleanup below.
    try {
      await backfillShortIds(db);
    } catch (err) {
      console.warn(`short id backfill skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Same reasoning as the poll above: runMailtmCleanup handles both kinds
    // of row in one pass (it deletes each mailbox on mail.tm's side first
    // for mail.tm-backed rows, which plain deleteExpiredAndRevoked can't
    // do, then runs that and deleteStaleRateLimits regardless), so it's a
    // strict superset of the domain-only path rather than an alternative
    // to it.
    await runMailtmCleanup(db);
  },
};
