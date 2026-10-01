# Deploying on Cloudflare Workers

One Worker, one D1 database, two modes:

- **Your own domain.** Mail arrives through Email Routing. Needs the domain added to your Cloudflare account as a zone.
- **mail.tm mode.** No domain, no DNS, nothing to buy. Addresses are provisioned on mail.tm's domain and polled instead. Read [the caveats](#mailtm-mode) first.

`DISPOSABLE_DOMAIN` is the only difference. Set it for the first, leave it unset for the second. Switching later is one command.

> **Used the [deploy button](../README.md#deploy)?** It has already created your database, set your secrets, and deployed the Worker. You still need to:
>
> - **Step 1**, cloning *your fork* rather than this repo, since the remaining commands run from it.
> - **The schema load at the end of step 2.** The button leaves the database empty. Skip the `d1 create` above it, you already have one.
> - **Step 4**, if you're using your own domain.
> - **Step 6.**

## What you need

- Node.js 18+, only for running these commands. Nothing runs locally once deployed.
- A Cloudflare account.
- A domain in that account, **domain mode only**.

Every command on this page assumes your terminal's current directory is the cloned repo folder (`cd Cindermail` after cloning, per step 1). `wrangler` reads `wrangler.jsonc` from wherever you run it, so a command run from anywhere else fails with something like `Required Worker name missing` rather than doing what the command name suggests. That error means "you're in the wrong folder," not a real config problem.

`wrangler` comes from `npm install` below, so there's no global install to do. Every command here runs from the repo directory.

## 1. Clone and install

```bash
git clone https://github.com/amandoti-win/cindermail.git
cd Cindermail
npm install
```

Used the button? Clone your fork instead, so the `database_id` in its `wrangler.jsonc` matches the database that was provisioned for you.

## 2. Create the database

```bash
npx wrangler d1 create cinderbox
```

Put the `database_id` it prints into `wrangler.jsonc`, then load the schema:

```bash
npm run cf:db:init
```

Button users start here: you have a database already, but it's empty until you run that.

No terminal? **Workers & Pages → D1 SQLite Database → your database → Console** tab also works: open `schema.sql` in this repo, copy its full contents, paste into the console, run it. Same effect as the command above, since both just execute that file's SQL against the database.

<details>
<summary>Why <code>wrangler.jsonc</code> is committed</summary>

Workers Builds clones the repo and needs the D1 binding present at build time, and dashboard-set bindings don't reliably survive into new versions. Nothing deployment-specific is in it, so cloning it is safe: your domain and limits are secrets, and custom domains attach from the dashboard without being declared here.

It silently takes precedence over `wrangler.toml`, so creating one of those has no effect.
</details>

## 3. Set your secrets

From a terminal:

```bash
npx wrangler secret put DISPOSABLE_DOMAIN
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
```

Each prompts for the value, then uploads it, one at a time.

Or from the dashboard, no terminal needed: **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**. Set the **Type** dropdown to **Secret** (not **Text**), give it the name and value, **Deploy** to apply it. Both paths hit the same underlying store and produce an identical result; the dashboard's **Text** type is a different, plaintext kind of variable that behaves nothing like this (see the note below), so the dropdown matters.

Skip `DISPOSABLE_DOMAIN` entirely for mail.tm mode. Where to find the Discord values: [discord-adapter.md](discord-adapter.md). Want Telegram and/or Slack instead of (or alongside) Discord? Their secrets are separate, see [telegram-adapter.md](telegram-adapter.md) and [slack-adapter.md](slack-adapter.md).

Secrets (either path above) rather than plaintext `vars` because they stay out of the repo and survive deploys. A **Text** variable added from the dashboard does not survive: it gets silently overwritten the next time the Worker is deployed by whatever `wrangler.jsonc` declares (only `ADAPTERS` is declared there, so anything else set as **Text** just vanishes on the next `wrangler deploy` or Workers Build). This is the single most common way people lose a setting they were sure they'd saved.

## 4. Point your domain at Email Routing

**Skip in mail.tm mode.**

The step most likely to trip you up. If your domain already has MX records, turning on Email Routing does not overwrite them for you. Check before assuming:

```bash
nslookup -type=MX yourdomain.com 1.1.1.1
```

They need to be `route1.mx.cloudflare.net`, `route2`, `route3`. If they aren't, mail never reaches the Worker and fails silently: no error, no bounce, it just goes wherever the old MX pointed.

## 5. Deploy

```bash
npm run cf:deploy
```

**Domain mode:** then add a catch-all rule under Email > Email Routing with this Worker as its action. Route to a Worker, not "forward to email."

## 6. Set up delivery

Mail is stored now but goes nowhere until at least one delivery platform is set up: [discord-adapter.md](discord-adapter.md) (Interactions Endpoint URL is the Worker's URL plus `/interactions`), [telegram-adapter.md](telegram-adapter.md) (webhook URL is the Worker's URL plus `/telegram-webhook`), and/or [slack-adapter.md](slack-adapter.md) (Request URL is the Worker's URL plus `/slack/commands`). Any combination can run at once, or just one.

## mail.tm mode

**Some sites block it.** mail.tm is a recognizable public disposable-mail service, and plenty of signup forms reject known temp-mail domains. Not looking disposable is most of the reason to run your own domain. A rejected address is this, not a bug.

**Mail is slower.** Cron triggers have a one minute floor, so mail shows up in about 30 seconds on average, 60 at worst.

**Addresses are real mailboxes.** `/new` provisions one through mail.tm's API and stores the password to poll it. `/torch` and expiry delete the account on their side during cleanup.

Everything else matches domain mode.

## The status page

The Worker root shows addresses created, emails received, addresses torched, and how many people hold an active address. Same numbers as JSON at `/counters`. No addresses, notes or owner ids, just totals.

To serve it on your own domain, add a Custom Domain under the Worker's Settings > Domains & Routes. Separate from Email Routing, which only handles inbound mail.

The first three are running totals in a `counters` table rather than row counts, since cleanup deletes rows and a live count would shrink. The user count is live on purpose: people holding an address now, not people who ever did, so it goes down. A missing table reads as zero and breaks nothing.

## Upgrading an existing deployment

Fresh installs get everything from `schema.sql`. Older databases need each migration applied once:

```bash
npx wrangler d1 execute cinderbox --remote --file=migrations/0003_add_permanent.sql
npx wrangler d1 execute cinderbox --remote --file=migrations/0004_add_counters.sql
npx wrangler d1 execute cinderbox --remote --file=migrations/0005_add_received_counter.sql
npx wrangler d1 execute cinderbox --remote --file=migrations/0006_add_note.sql
npx wrangler d1 execute cinderbox --remote --file=migrations/0007_add_expiry_reminders.sql
```

`0003` permanent addresses, `0004`/`0005` status page totals, `0006` notes, `0007` expiry reminders. Re-run `npm run register-commands` after, so Discord picks up new command options.

Same dashboard alternative as loading the initial schema: **D1 SQLite Database → your database → Console**, paste each migration file's contents in order, run it. `register-commands` has no dashboard equivalent either way: it's a script that talks to Discord's API directly, not a Cloudflare operation.
