# Setting up the Slack adapter

Mail gets delivered as a Slack DM to whoever owns the address. [deploy-cloudflare.md](deploy-cloudflare.md) only gets mail as far as received and stored, so finish that first.

## What you need

- A cloned repo with `npm install` run in it.
- A deployed Worker (the same one from `deploy-cloudflare.md`, or a fresh one if this is the only adapter you're running).
- A Slack workspace you can create an app in.

Every command below assumes your terminal's current directory is that cloned repo folder. `wrangler` reads `wrangler.jsonc` from wherever you run it, so a command run from anywhere else (your home folder, a different project) fails with `Required Worker name missing` rather than doing what it says. That specific error means "wrong folder," not a real problem with your setup.

## 1. Create the app from a manifest

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → pick your workspace.

![Slack's "Create new app" dialog, with "From a manifest" selected as the starting point](images/slack-create-app.png)

Paste this in (YAML tab), replacing `YOUR-WORKER-URL` (six occurrences) with your actual Worker URL first: one find-and-replace, not six manual edits:

```yaml
display_information:
  name: Cindermail
  description: Disposable email delivered as a Slack DM
  background_color: "#f38020"

oauth_config:
  scopes:
    bot:
      - commands
      - chat:write

features:
  bot_user:
    display_name: Cindermail
    always_online: true
  slash_commands:
    - command: /cm-new
      url: https://YOUR-WORKER-URL/slack/commands
      description: Mint a new disposable address
      usage_hint: "[expiry] [note]"
      should_escape: false
    - command: /cm-list
      url: https://YOUR-WORKER-URL/slack/commands
      description: List your addresses
      should_escape: false
    - command: /cm-extend
      url: https://YOUR-WORKER-URL/slack/commands
      description: Change when an address expires
      usage_hint: "<address/id> [expiry]"
      should_escape: false
    - command: /cm-note
      url: https://YOUR-WORKER-URL/slack/commands
      description: Label an address
      usage_hint: "<address/id> [note]"
      should_escape: false
    - command: /cm-torch
      url: https://YOUR-WORKER-URL/slack/commands
      description: Kill an address
      usage_hint: "<address/id>"
      should_escape: false
    - command: /cm-remind
      url: https://YOUR-WORKER-URL/slack/commands
      description: Toggle expiry reminder DMs
      usage_hint: "[on|off]"
      should_escape: false

settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Every command is prefixed `cm-` rather than the bare name: Slack rejects overly generic single-word command names outright, and `/remind` specifically collides with a real Slack built-in. The prefix is stripped back off before dispatch, so the six commands themselves work identically to Discord and Telegram.

## 2. Enable DM slash commands

Left sidebar → **App Home** → **Messages Tab** → turn it on, then check **"Allow users to send Slash commands and messages from the messages tab."**

![Slack App Home settings, with the Messages Tab toggled on and "Allow users to send Slash commands and messages from the messages tab" checked](images/slack-messages-tab.png)

Easy to miss, and the only step that isn't obviously part of "installing the app": without it, the app's own DM won't accept any input at all, commands included, even though the six slash commands work fine from a regular channel either way.

## 3. Install to your workspace

Left sidebar → **Install App** → **Install to Workspace**. The consent screen shows exactly the two scopes from the manifest, nothing more:

![Slack's install-consent screen, showing "Send messages as @cindermail" and "Add shortcuts and/or slash commands" as the only two requested permissions](images/slack-install.png)

Click **Allow**.

## 4. Copy the Bot Token

Still on **Install App** (or **OAuth & Permissions**) → **OAuth Tokens** → copy the **Bot User OAuth Token** (`xoxb-...`).

![The OAuth Tokens panel showing a redacted Bot User OAuth Token, prefixed xoxb-, with a Copy button](images/slack-oauth-token.png)

## 5. Copy the Signing Secret

Left sidebar → **Basic Information** → **App Credentials** → **Signing Secret** → **Show**.

![The App Credentials panel: App ID and Client ID are safe to leave visible, Client Secret and Signing Secret are masked, and the deprecated Verification Token is blocked out since unlike the other two it isn't masked by default](images/slack-signing-secret.png)

App ID and Client ID aren't secret, they're public identifiers. Client Secret and Signing Secret are, and Slack masks both by default. The Verification Token below them is deprecated but still live and shown in plain text, worth blocking out of any screenshot you take of this page, same as the two secrets above it.

## 6. Set both as secrets on the Worker

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

Or skip the terminal entirely: **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, **Type: Secret**, one entry per name above, paste the value, **Deploy**. Both paths write to the same encrypted store. Just make sure the **Type** dropdown says **Secret**, not **Text**. A **Text** variable is plaintext and gets silently wiped the next time this Worker is deployed, since only `ADAPTERS` is declared in `wrangler.jsonc` and a redeploy treats that file as the source of truth for anything not a proper Secret.

Add `"slack"` to `ADAPTERS` in `wrangler.jsonc`'s `vars` (comma-separated with whatever else is there: `"discord,telegram,slack"`), then redeploy:

```bash
npx wrangler deploy
```

Your Request URL is `/slack/commands` on that same Worker, the same one for all six commands, since Slack sends the command name in the payload rather than needing a separate endpoint per command.

## 7. Try it

Open the app's own DM and run a command:

![The Slack message composer with "/cm-new 10 Slack Test" typed in, ready to send](images/slack-mint.png)

A reply comes back visible only to you, regardless of whether you ran it in the DM or a channel:

![A Slack DM from the Cindermail app: "Your new disposable address: tnh87pazbw@vsvn.net (Slack Test), Expires in 10 days.", marked "Only visible to you"](images/slack-reply.png)

Send that address a test email and it arrives the same way Discord and Telegram deliver it: From/To/Subject header, then the body:

![A Slack DM from the Cindermail app forwarding a received test email, with From, To, and Subject lines followed by the message body](images/slack-received.png)

## Commands

Every reply uses Slack's `ephemeral` response type: visible only to whoever ran the command, in a DM or any channel alike, so there's no restriction on where you run one from.

| Command | What it does | Rate limit |
|---|---|---|
| `/cm-new [expiry] [note]` | Creates an address. Permanent unless `expiry` is given. | 1 per 30s |
| `/cm-list` | Your addresses, notes, and expiry. | 15 per 60s |
| `/cm-extend <address/id> [expiry]` | Changes when an address expires. | 15 per 60s |
| `/cm-note <address/id> [note]` | Labels an address. Blank clears it. | 15 per 60s |
| `/cm-torch <address/id>` | Revokes an address. | 15 per 60s |
| `/cm-remind [on\|off]` | Expiry reminder DMs. Blank shows the current setting. | 15 per 60s |

`/cm-list` shows a short 5-digit id next to each address (`#48213`). `/cm-extend`, `/cm-note`, and `/cm-torch` all accept that id there too: just the digits, no `#`.

Plain text after the command, no structured options: for `/cm-new` and `/cm-note`, a leading number is read as `expiry`; everything else is the note. For `/cm-extend`, the address comes first and an optional trailing number is the new expiry:

```
/cm-new                           permanent, no note
/cm-new 7                         expires in 7 days
/cm-new 7 netflix signup          expires in 7 days, noted
/cm-new netflix signup            permanent (no leading number), noted

/cm-extend x@you.com              10 days from now
/cm-extend x@you.com 5            5 days from now
/cm-extend x@you.com 0            permanent
```

`expiry` is in **days** on both `/cm-new` and `/cm-extend`, `0` meaning permanent. One asymmetry: bare `/cm-new` is permanent, bare `/cm-extend` uses the 10 day default, since `/cm-extend` should do what its name says. `/cm-extend` also sets expiry relative to now rather than adding to what's left: an address with 8 days left extended by `5` has 5 days, not 13.

Permanent addresses still count against your active-address limit, and show as `permanent` in `/cm-list` rather than a countdown. Cleanup skips them, so `/cm-torch` is what ends one.

## Notes

A random local part tells you nothing about what you used it for. A note is an optional label, up to 80 characters, shown in `/cm-list`, visible only to the address's owner:

```
/cm-new 0 netflix trial
/cm-note x7k2p9qzrm@you.com bank alerts
/cm-note x7k2p9qzrm@you.com              clears it
```

## Expiry reminders

Off until asked for:

```
/cm-remind on      DM about a day before an address expires
/cm-remind off     stop
/cm-remind         current setting
```

One DM covering everything of yours expiring soon, with notes, so you can `/cm-extend` what you still need. It rides the daily cleanup cron, so it lands 24 to 48 hours ahead rather than exactly a day; an address living under about two days never gets one, since no run sees it with a day still left: `/cm-new 1` won't warn. `/cm-extend` re-arms the reminder against the new expiry.

Defaults for all of the above are configurable, see [configuration.md](configuration.md).
