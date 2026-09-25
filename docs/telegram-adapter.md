# Setting up the Telegram adapter

Mail gets delivered as a Telegram message to whoever owns the address. [deploy-cloudflare.md](deploy-cloudflare.md) only gets mail as far as received and stored, so finish that first.

## What you need

- A cloned repo with `npm install` run in it.
- A deployed Worker (the same one from `deploy-cloudflare.md`, or a fresh one if this is the only adapter you're running).

Every command below assumes your terminal's current directory is that cloned repo folder. `wrangler` reads `wrangler.jsonc` from wherever you run it, so a command run from anywhere else (your home folder, a different project) fails with `Required Worker name missing` rather than doing what it says. That specific error means "wrong folder," not a real problem with your setup.

## 1. Create a bot

Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, follow the prompts. You get back a **bot token**.

![A Telegram chat with BotFather: /newbot, naming it Cindermail, username CindermailBot, ending with "Done! Congratulations on your new bot" and the HTTP API token blurred](images/telegram-create-bot.png)

## 2. Set it up

Two values need to reach two different systems without a typo sneaking in: the bot token goes to Cloudflare *and* gets reused in a `curl` call to Telegram below, and the webhook secret you make up yourself has to end up identical on both the Worker and in that same `curl` call. Put both in shell variables once, at the top, and every command after this (including the ones further down this page) reuses them instead of retyping anything:

```bash
TOKEN=<paste your bot token from step 1 here>
SECRET=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Run these as one sequence in the same terminal session. `$TOKEN` and `$SECRET` only exist for as long as that shell stays open, so if you close it before the next block, set them again rather than guessing what the old values were.

No terminal? Same result from the dashboard: **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, **Type: Secret**, for `TELEGRAM_BOT_TOKEN`. For `TELEGRAM_WEBHOOK_SECRET`, generate the random string yourself first (any long random string works, it just has to match what you give Telegram in the next step), then add it the same way. Either path, use **Type: Secret**, never **Type: Text**. A **Text** variable is plaintext and gets silently wiped on this Worker's next deploy, since only `ADAPTERS` is declared in `wrangler.jsonc` and a redeploy makes that file the source of truth for anything not a proper Secret.

Add `"telegram"` to `ADAPTERS` in `wrangler.jsonc`'s `vars` (comma-separated if Discord's there too: `"discord,telegram"`), then redeploy:

```bash
npx wrangler deploy
```

Now point Telegram at the same Worker, reusing `$TOKEN` and `$SECRET` from above rather than retyping either:

```bash
curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=https://<your-worker>.<your-subdomain>.workers.dev/telegram-webhook&secret_token=$SECRET"
```

A successful response looks like `{"ok":true,"result":true,"description":"Webhook was set"}`, but that only means Telegram accepted the request, not that the secret it now has actually matches what's saved on the Worker. If you used `$SECRET` for both commands in the same shell session, it does. If you typed either one by hand, or ran them in separate sessions, verify before assuming it works:

```bash
curl "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

Check the response for `last_error_message`. `Wrong response from the webhook: 401 Unauthorized` means the two secrets don't match. Set `$SECRET` fresh and redo the `wrangler secret put TELEGRAM_WEBHOOK_SECRET` and `setWebhook` commands above in one sitting, same shell session. No `last_error_message` and `pending_update_count: 0` means it's working.

<details>
<summary>Running both Discord and Telegram and want them on separate Workers instead?</summary>

Not needed for a normal setup: one Worker handling everything is the default for a reason, nothing extra to deploy or keep in sync. This only matters if you specifically want Discord and Telegram bundle-isolated from each other, so a Discord-only change can't bloat what Telegram's Worker ships, and vice versa.

```bash
TOKEN=<paste your bot token from step 1 here>
SECRET=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.telegram.jsonc
echo "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.telegram.jsonc
npx wrangler deploy --config wrangler.telegram.jsonc
```

If your main Worker is in domain mode, also set `DISPOSABLE_DOMAIN` on this one to match. Cloudflare doesn't share secrets between Workers, so this has to be kept in sync by hand:

```bash
npx wrangler secret put DISPOSABLE_DOMAIN --config wrangler.telegram.jsonc
```

Skip that and this Worker falls back to mail.tm mode regardless of what the main Worker does, since it has no way to know otherwise.

Webhook path is `/webhook` on this second Worker (not `/telegram-webhook`), and it needs `TELEGRAM_BOT_TOKEN` set on the **main** Worker too, so it can deliver inbound mail to Telegram users. That part always runs on whichever Worker owns Email Routing and the cron, regardless of which Worker handles the webhook itself. Point `setWebhook` at this second Worker's own URL, still reusing the same `$TOKEN` and `$SECRET`.

</details>

## 3. Try it

Message your bot `/new`. Group chats are refused: commands only work in a private chat with the bot, since Telegram has no way to send a reply that's visible only to the person who ran the command, the way a reply in a private chat already is for everyone else in it.

![A Telegram DM: "/new" sent, followed by the bot's reply "Your new disposable address: lr2ecymcxx@vsvn.net, Permanent, good until you torch it."](images/telegram-mint.png)

Send that address a test email and it arrives as a message within seconds:

![A Telegram DM from the bot forwarding a received test email, with From, To, and Subject lines followed by the message body](images/telegram-received.png)

## Commands

Plain text after the command, no structured options, everything is just typed as one string:

| Command | What it does | Rate limit |
|---|---|---|
| `/new [expiry] [note]` | Creates an address. Permanent unless `expiry` is given. | 1 per 30s |
| `/list` | Your addresses, notes, and expiry. | 15 per 60s |
| `/extend <address/id> [expiry]` | Changes when an address expires. | 15 per 60s |
| `/note <address/id> [note]` | Labels an address. Blank clears it. | 15 per 60s |
| `/torch <address/id>` | Revokes an address. | 15 per 60s |
| `/remind [on\|off]` | Expiry reminder messages. Blank shows the current setting. | 15 per 60s |

`/list` shows a short 5-digit id next to each address (`#48213`). `/extend`, `/note`, and `/torch` all accept that id there too: just the digits, no `#`.

For `/new` and `/note`, a leading number is read as `expiry`; everything else is the note. For `/extend`, the address comes first and an optional trailing number is the new expiry:

```
/new                              permanent, no note
/new 7                            expires in 7 days
/new 7 netflix signup             expires in 7 days, noted
/new netflix signup               permanent (no leading number), noted

/extend x@you.com                 10 days from now
/extend x@you.com 5               5 days from now
/extend x@you.com 0               permanent
```

`expiry` is in **days** on both `/new` and `/extend`, `0` meaning permanent. One asymmetry: bare `/new` is permanent, bare `/extend` uses the 10 day default, since `/extend` should do what its name says. `/extend` also sets expiry relative to now rather than adding to what's left: an address with 8 days left extended by `5` has 5 days, not 13.

Permanent addresses still count against your active-address limit, and show as `permanent` in `/list` rather than a countdown. Cleanup skips them, so `/torch` is what ends one.

## Notes

A random local part tells you nothing about what you used it for. A note is an optional label, up to 80 characters, shown in `/list`, visible only to the address's owner:

```
/new 0 netflix trial
/note x7k2p9qzrm@you.com bank alerts
/note x7k2p9qzrm@you.com              clears it
```

## Expiry reminders

Off until asked for:

```
/remind on      message about a day before an address expires
/remind off     stop
/remind         current setting
```

One message covering everything of yours expiring soon, with notes, so you can `/extend` what you still need. It rides the daily cleanup cron, so it lands 24 to 48 hours ahead rather than exactly a day; an address living under about two days never gets one, since no run sees it with a day still left: `/new 1` won't warn. `/extend` re-arms the reminder against the new expiry.

Defaults for all of the above are configurable, see [configuration.md](configuration.md).
