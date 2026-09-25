import {
  countActiveAddresses,
  extendAddress,
  getExpiryReminderPreference,
  listActiveAddresses,
  revokeAddress,
  setAddressNote,
  setExpiryReminderPreference,
} from "../../core/db.ts";
import { checkAndIncrement } from "../../core/ratelimit.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import type { OwnerRef } from "../../core/types.ts";
import type { CommandConfig } from "../../core/config.ts";
import {
  BAD_EXPIRY_MESSAGE,
  type CreateAddressFn,
  describeExpiry,
  MAX_EXPIRY_DAYS,
  MAX_NOTE_LENGTH,
  parseExpiry,
  resolveAddressIdentifier,
} from "../../core/commands.ts";

export type { CreateAddressFn } from "../../core/commands.ts";
export { MAX_EXPIRY_DAYS, MAX_NOTE_LENGTH } from "../../core/commands.ts";

const EPHEMERAL = 64;

const RATE_LIMIT_MESSAGE = "Slow down a moment, then try again.";

interface DiscordInteractionOption {
  name: string;
  value?: string | number | boolean;
}

export interface DiscordInteraction {
  type: number;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name: string;
    options?: DiscordInteractionOption[];
  };
}

function ephemeralReply(content: string) {
  return {
    type: 4,
    data: { content, flags: EPHEMERAL },
  };
}

function getInvokingUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function getOption(interaction: DiscordInteraction, name: string): string | undefined {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

// Addresses are stored lowercase (generated from a fixed lowercase alphabet,
// and core/email.ts lowercases inbound recipients before looking them up), so
// commands have to normalise too. Phone keyboards autocapitalise the first
// letter and copy/paste picks up stray whitespace, and without this both come
// back as "Not found or not yours", which reads like an ownership problem
// rather than a typo.
// Checks both keys: register-commands.ts registers this option as
// address_or_id, but until that script has actually been re-run against a
// given Discord application, Discord is still sending the old address key
// from before the rename. Once every deployment has re-registered, the
// fallback can go.
function getAddressOption(interaction: DiscordInteraction): string | undefined {
  const value = getOption(interaction, "address_or_id") ?? getOption(interaction, "address");
  return value?.trim().toLowerCase();
}

// Discord sends numbers for INTEGER options. Undefined means the option was
// left off entirely, which every caller treats differently from an explicit
// value (notably 0, which means permanent).
function getIntegerOption(interaction: DiscordInteraction, name: string): number | undefined {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// Undefined means the option was omitted, which /remind treats as "just tell
// me the current setting" rather than as false.
function getBooleanOption(interaction: DiscordInteraction, name: string): boolean | undefined {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "boolean" ? value : undefined;
}

export async function handleInteraction(
  interaction: DiscordInteraction,
  db: SqlExecutor,
  createAddressFn: CreateAddressFn,
  config: CommandConfig
) {
  const userId = getInvokingUserId(interaction);
  if (!userId) {
    return ephemeralReply("Could not identify the invoking user.");
  }
  const owner: OwnerRef = { type: "discord", id: userId };
  const commandName = interaction.data?.name;

  const limit = commandName ? config.rateLimits[commandName] : undefined;
  if (limit) {
    const allowed = await checkAndIncrement(
      db,
      owner.type,
      owner.id,
      commandName as string,
      limit.windowSeconds,
      limit.maxCount
    );
    if (!allowed) {
      return ephemeralReply(RATE_LIMIT_MESSAGE);
    }
  }

  switch (commandName) {
    case "new":
      return handleNew(
        db,
        owner,
        createAddressFn,
        config,
        getIntegerOption(interaction, "expiry"),
        getOption(interaction, "note")
      );
    case "list":
      return handleList(db, owner, config);
    case "note":
      return handleNote(db, owner, getAddressOption(interaction), getOption(interaction, "note") ?? "");
    case "extend":
      return handleExtend(
        db,
        owner,
        getAddressOption(interaction),
        config,
        getIntegerOption(interaction, "expiry")
      );
    case "torch":
      return handleTorch(db, owner, getAddressOption(interaction));
    case "remind":
      return handleRemind(db, owner, getBooleanOption(interaction, "enabled"));
    default:
      return ephemeralReply("Unknown command.");
  }
}

async function handleNew(
  db: SqlExecutor,
  owner: OwnerRef,
  createAddressFn: CreateAddressFn,
  config: CommandConfig,
  expiryDays: number | undefined,
  note: string | undefined
) {
  // Leaving `expiry` off means permanent. Addresses are meant to outlive
  // whatever you signed up for unless you say otherwise.
  const expiry =
    expiryDays === undefined
      ? { ttlSeconds: config.addressTtlSeconds, permanent: true }
      : parseExpiry(expiryDays, config.addressTtlSeconds);
  if (!expiry) {
    return ephemeralReply(BAD_EXPIRY_MESSAGE);
  }

  const activeCount = await countActiveAddresses(db, owner);
  if (activeCount >= config.maxActiveAddresses) {
    return ephemeralReply(
      `You already have ${activeCount}/${config.maxActiveAddresses} active addresses. Torch one before creating another.`
    );
  }

  const trimmedNote = note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  const address = await createAddressFn(db, owner, expiry.ttlSeconds, expiry.permanent, trimmedNote);
  const label = trimmedNote ? ` (${trimmedNote})` : "";
  return ephemeralReply(`Your new disposable address: \`${address}\`${label}\n${describeExpiry(expiry)}`);
}

async function handleNote(db: SqlExecutor, owner: OwnerRef, addressOrId: string | undefined, note: string) {
  if (!addressOrId) {
    return ephemeralReply("Missing address.");
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return ephemeralReply("Not found or not yours.");
  }
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH);
  const updated = await setAddressNote(db, owner, address, trimmed);
  if (!updated) {
    return ephemeralReply("Not found or not yours.");
  }
  return trimmed
    ? ephemeralReply(`\`${address}\` is now labelled "${trimmed}".`)
    : ephemeralReply(`Cleared the note on \`${address}\`.`);
}

async function handleList(db: SqlExecutor, owner: OwnerRef, config: CommandConfig) {
  const addresses = await listActiveAddresses(db, owner);
  const quota = `${addresses.length}/${config.maxActiveAddresses} active addresses`;
  if (addresses.length === 0) {
    return ephemeralReply(`${quota}.`);
  }
  const lines = addresses.map((a) => {
    const when = a.permanent === 1 ? "permanent" : `expires <t:${a.expires_at}:R>`;
    // Notes are user-supplied, so strip backticks to stop one from breaking
    // out of the code span and mangling the rest of the line.
    const label = a.note ? ` ${a.note.replaceAll("`", "")} ` : " ";
    const id = a.short_id ? `#${a.short_id} ` : "";
    return `${id}\`${a.address}\`${label}(${when})`;
  });
  return ephemeralReply([`${quota}:`, ...lines].join("\n"));
}

async function handleExtend(
  db: SqlExecutor,
  owner: OwnerRef,
  addressOrId: string | undefined,
  config: CommandConfig,
  expiryDays: number | undefined
) {
  if (!addressOrId) {
    return ephemeralReply("Missing address.");
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return ephemeralReply("Not found or not yours.");
  }

  // Unlike /new, leaving `expiry` off here means the configured default
  // rather than permanent: /extend without arguments should do the thing
  // its name says.
  const expiry =
    expiryDays === undefined
      ? { ttlSeconds: config.addressTtlSeconds, permanent: false }
      : parseExpiry(expiryDays, config.addressTtlSeconds);
  if (!expiry) {
    return ephemeralReply(BAD_EXPIRY_MESSAGE);
  }

  const updated = await extendAddress(db, owner, address, expiry.ttlSeconds, expiry.permanent);
  if (!updated) {
    return ephemeralReply("Not found or not yours.");
  }

  if (expiry.permanent) {
    return ephemeralReply(`\`${address}\` is now permanent, good until you torch it.`);
  }
  const days = Math.round(expiry.ttlSeconds / 86400);
  return ephemeralReply(`\`${address}\` now expires in ${days} day${days === 1 ? "" : "s"}.`);
}

async function handleTorch(db: SqlExecutor, owner: OwnerRef, addressOrId: string | undefined) {
  if (!addressOrId) {
    return ephemeralReply("Missing address.");
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return ephemeralReply("Not found or not yours.");
  }
  const updated = await revokeAddress(db, owner, address);
  if (!updated) {
    return ephemeralReply("Not found or not yours.");
  }
  return ephemeralReply(`Torched \`${address}\`.`);
}

// Omitting `enabled` reports the current setting instead of toggling, so
// running the command to check where you stand can't accidentally change it.
async function handleRemind(db: SqlExecutor, owner: OwnerRef, enabled: boolean | undefined) {
  if (enabled === undefined) {
    const current = await getExpiryReminderPreference(db, owner);
    return ephemeralReply(
      current
        ? "Expiry reminders are **on**. `/remind enabled: false` turns them off."
        : "Expiry reminders are **off**. `/remind enabled: true` turns them on."
    );
  }

  await setExpiryReminderPreference(db, owner, enabled);
  return ephemeralReply(
    enabled
      ? "Expiry reminders **on**. You'll get a DM about a day before an address expires, with time to `/extend` it. Addresses shorter-lived than that won't get one."
      : "Expiry reminders **off**. Addresses still expire on schedule, you just won't hear about it first."
  );
}
