# Configuration reference

Everything is read from the Worker's environment, so anything below works either as a secret or as a plain `vars` entry in `wrangler.jsonc`. Set a secret with `wrangler secret put NAME`, run from the cloned repo folder. From anywhere else it fails with `Required Worker name missing`, since that's where it reads `wrangler.jsonc` from to know which Worker you mean. Or without a terminal at all: **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, **Type: Secret**. Both write to the same encrypted store.

Use secrets for anything specific to your deployment. `wrangler.jsonc` is committed, so values there ship to everyone who clones it. Only `ADAPTERS` sits in `vars`, because it's the same everywhere. Everything else should be a Secret, not the dashboard's **Type: Text** option. A **Text** variable is plaintext and gets silently overwritten on the next deploy by whatever `wrangler.jsonc` declares, since that file is the source of truth for anything not a proper Secret. A Secret survives deploys; a Text variable doesn't.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DISCORD_TOKEN` | if `ADAPTERS` includes `discord` | | Bot token. |
| `DISCORD_PUBLIC_KEY` | if `ADAPTERS` includes `discord` | | Verifies that interactions actually came from Discord. |
| `DISCORD_APPLICATION_ID` | if `ADAPTERS` includes `discord` | | Used by `register-commands.ts`. |
| `TELEGRAM_BOT_TOKEN` | if `ADAPTERS` includes `telegram` | | Bot token, from @BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | only if this Worker handles the Telegram webhook itself | | One you make up, not one Telegram gives you. Verifies a webhook call actually came from Telegram. Unused if you split Telegram onto its own Worker via `wrangler.telegram.jsonc` and it's set there instead. See [telegram-adapter.md](telegram-adapter.md). |
| `SLACK_BOT_TOKEN` | if `ADAPTERS` includes `slack` | | Bot User OAuth Token (`xoxb-...`), from your Slack app's OAuth & Permissions page. |
| `SLACK_SIGNING_SECRET` | if `ADAPTERS` includes `slack` | | Verifies that slash command requests actually came from Slack. From the app's Basic Information page. See [slack-adapter.md](slack-adapter.md). |
| `DISPOSABLE_DOMAIN` | no | unset | Domain addresses are generated on. Unset means mail.tm mode: addresses on mail.tm's domain, no domain of your own needed. Set independently per Worker if you're running Telegram split onto its own Worker; Cloudflare doesn't share secrets between Workers. |
| `ADAPTERS` | no | `discord` | Comma separated list of enabled delivery adapters: `discord`, `telegram`, `slack`, or any combination. |
| `MAX_ACTIVE_ADDRESSES` | no | `5` | Addresses one owner can hold at once. |
| `ADDRESS_TTL_SECONDS` | no | `864000` (10 days) | What a bare `/extend` uses. `/new` is permanent by default and ignores this unless given an explicit `expiry`. |
| `RATE_LIMIT_<CMD>_WINDOW_SECONDS` | no | see below | Window length for a command's rate limit. `<CMD>` is `NEW`, `LIST`, `EXTEND`, `TORCH`, `NOTE` or `REMIND`. |
| `RATE_LIMIT_<CMD>_MAX` | no | see below | Calls allowed per window. `0` disables that command's limit. |

Rate limit defaults: `NEW` is 1 call per 30 seconds, everything else 15 per 60.

They're there to stop a deployment other people can reach getting hammered, not to protect you from yourself. Scoped per owner rather than shared, so running this for yourself you'll likely never hit them. Set every `RATE_LIMIT_*_MAX` to `0` to remove them.

## Cron triggers

In `wrangler.jsonc` under `triggers.crons`, not variables:

| Schedule | What it does |
|---|---|
| `0 3 * * *` | Daily: deletes expired and torched addresses, clears stale rate-limit rows, sends expiry reminders, and deletes the remote mailbox behind any dropped mail.tm-backed address, regardless of whether this Worker's own `DISPOSABLE_DOMAIN` is set. |
| `*/1 * * * *` | **Not in the default config. Add it for mail.tm mode.** Polls mail.tm for any mail.tm-backed address in the database, regardless of this Worker's own `DISPOSABLE_DOMAIN`. |

The poll is opt-in because a cron trigger can't be conditional on a setting: listed by default, it would invoke the Worker every minute on domain deployments that never poll anything. If you run mail.tm mode, or split Telegram onto its own Worker running in mail.tm mode while this one uses a domain, add `"*/1 * * * *"` to `triggers.crons` in `wrangler.jsonc` and redeploy; without it mail.tm-backed addresses receive nothing. The daily cleanup still removes their remote mailboxes either way.

Once the poll is listed, `scheduled()` runs it unconditionally rather than gating on this Worker's own mode, for the same split-Worker reason.

With the poll enabled, the one minute floor on cron triggers is why mail.tm mode averages about 30 seconds to deliver.

Times are UTC. The daily one sends reminder messages, so its hour decides when people get notified.
