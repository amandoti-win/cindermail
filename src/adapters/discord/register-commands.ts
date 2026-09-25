// Standalone script, not part of the Worker bundle.
// Run with: DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node --experimental-strip-types src/adapters/discord/register-commands.ts

import { MAX_EXPIRY_DAYS, MAX_NOTE_LENGTH } from "./interactions.ts";

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID must be set in the environment.");
  console.error("");
  console.error("These live in Cloudflare as encrypted secrets, which can't be read back,");
  console.error("so pass them from your own copy, e.g.:");
  console.error("  DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... npm run register-commands");
  process.exit(1);
}

const GUILD_AND_USER_INSTALL = [0, 1];
const ALL_CONTEXTS = [0, 1, 2];

// Discord option type 4 is INTEGER, 3 is STRING. min_value/max_value/
// max_length make Discord reject out-of-range input in its own UI before it
// ever reaches the Worker; interactions.ts validates again anyway. The
// bounds are imported from there so the two can't drift apart and leave
// Discord accepting something the Worker rejects.

const commands = [
  {
    name: "new",
    description: "Create a new disposable email address",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
    options: [
      {
        type: 4,
        name: "expiry",
        description: "Days until it expires. Leave blank or use 0 for permanent.",
        required: false,
        min_value: 0,
        max_value: MAX_EXPIRY_DAYS,
      },
      {
        type: 3,
        name: "note",
        description: "A label to remember what it's for, shown in /list",
        required: false,
        max_length: MAX_NOTE_LENGTH,
      },
    ],
  },
  {
    name: "list",
    description: "List your active disposable email addresses",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
  },
  {
    name: "note",
    description: "Label an address so you remember what it's for",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
    options: [
      {
        type: 3,
        name: "address_or_id",
        description: "The address, or its short id from /list (digits only, no #)",
        required: true,
      },
      {
        type: 3,
        name: "note",
        description: "The label. Leave blank to remove it.",
        required: false,
        max_length: MAX_NOTE_LENGTH,
      },
    ],
  },
  {
    name: "extend",
    description: "Change when a disposable email address expires",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
    options: [
      {
        type: 3,
        name: "address_or_id",
        description: "The address, or its short id from /list (digits only, no #)",
        required: true,
      },
      {
        type: 4,
        name: "expiry",
        description: "Days from now until it expires. Use 0 for permanent.",
        required: false,
        min_value: 0,
        max_value: MAX_EXPIRY_DAYS,
      },
    ],
  },
  {
    name: "torch",
    description: "Torch (revoke) a disposable email address",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
    options: [
      {
        type: 3,
        name: "address_or_id",
        description: "The address, or its short id from /list (digits only, no #)",
        required: true,
      },
    ],
  },
  {
    name: "remind",
    description: "Get a DM about a day before an address expires",
    integration_types: GUILD_AND_USER_INSTALL,
    contexts: ALL_CONTEXTS,
    options: [
      {
        // Type 5 is BOOLEAN. Optional on purpose: omitting it reports the
        // current setting rather than changing it.
        type: 5,
        name: "enabled",
        description: "On or off. Leave blank to see the current setting.",
        required: false,
      },
    ],
  },
];

async function main() {
  const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to register commands: ${response.status} ${body}`);
    process.exit(1);
  }

  console.log("Commands registered successfully.");
}

main();
