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
  MAX_NOTE_LENGTH,
  parseExpiry,
  resolveAddressIdentifier,
} from "../../core/commands.ts";

const RATE_LIMIT_MESSAGE = "Slow down a moment, then try again.";
// Slack rejects bare generic words as custom slash command names (and
// /remind collides with a real Slack built-in), so every command here is
// registered as /cm-<name>. Stripped back off before dispatch so the
// internal command names, rate-limit keys, and config vars stay identical
// to Discord/Telegram's.
const COMMAND_PREFIX = "cm-";

export interface SlackSlashCommandPayload {
  command: string;
  text: string;
  user_id: string;
}

// "7 netflix signup" -> expiry 7, note "netflix signup". Same parsing as
// Telegram's plain-text commands, since Slack hands over "everything after
// the command name" as one string (`text`) too, just already split from the
// command token itself.
function splitLeadingExpiry(remainder: string): { expiryDays: number | undefined; rest: string } {
  const nextSpace = remainder.indexOf(" ");
  const firstWord = nextSpace === -1 ? remainder : remainder.slice(0, nextSpace);
  if (firstWord === "" || !/^-?\d+$/.test(firstWord)) {
    return { expiryDays: undefined, rest: remainder };
  }
  return {
    expiryDays: Number.parseInt(firstWord, 10),
    rest: nextSpace === -1 ? "" : remainder.slice(nextSpace + 1).trim(),
  };
}

function splitAddressAndTrailingExpiry(remainder: string): { address: string; expiryDays: number | undefined } {
  const parts = remainder.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { address: "", expiryDays: undefined };
  }
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && /^-?\d+$/.test(last)) {
    return { address: parts.slice(0, -1).join(" ").toLowerCase(), expiryDays: Number.parseInt(last, 10) };
  }
  return { address: parts.join(" ").toLowerCase(), expiryDays: undefined };
}

function parseBooleanArg(word: string): boolean | undefined {
  const w = word.toLowerCase();
  if (["true", "on", "yes", "1", "enable", "enabled"].includes(w)) return true;
  if (["false", "off", "no", "0", "disable", "disabled"].includes(w)) return false;
  return undefined;
}

export async function handleSlashCommand(
  payload: SlackSlashCommandPayload,
  db: SqlExecutor,
  createAddressFn: CreateAddressFn,
  config: CommandConfig
): Promise<string> {
  const rawCommand = payload.command.replace(/^\//, "").toLowerCase();
  const command = rawCommand.startsWith(COMMAND_PREFIX) ? rawCommand.slice(COMMAND_PREFIX.length) : rawCommand;
  const remainder = payload.text.trim();
  const owner: OwnerRef = { type: "slack", id: payload.user_id };

  const limit = config.rateLimits[command];
  if (limit) {
    const allowed = await checkAndIncrement(db, owner.type, owner.id, command, limit.windowSeconds, limit.maxCount);
    if (!allowed) {
      return RATE_LIMIT_MESSAGE;
    }
  }

  switch (command) {
    case "new":
      return handleNew(db, owner, createAddressFn, config, remainder);
    case "list":
      return handleList(db, owner, config);
    case "note":
      return handleNote(db, owner, remainder);
    case "extend":
      return handleExtend(db, owner, config, remainder);
    case "torch":
      return handleTorch(db, owner, remainder);
    case "remind":
      return handleRemind(db, owner, remainder);
    default:
      return "Unknown command.";
  }
}

async function handleNew(
  db: SqlExecutor,
  owner: OwnerRef,
  createAddressFn: CreateAddressFn,
  config: CommandConfig,
  remainder: string
): Promise<string> {
  const { expiryDays, rest: note } = splitLeadingExpiry(remainder);
  const expiry =
    expiryDays === undefined
      ? { ttlSeconds: config.addressTtlSeconds, permanent: true }
      : parseExpiry(expiryDays, config.addressTtlSeconds);
  if (!expiry) {
    return BAD_EXPIRY_MESSAGE;
  }

  const activeCount = await countActiveAddresses(db, owner);
  if (activeCount >= config.maxActiveAddresses) {
    return `You already have ${activeCount}/${config.maxActiveAddresses} active addresses. Torch one before creating another.`;
  }

  const trimmedNote = note.trim().slice(0, MAX_NOTE_LENGTH) || null;
  const address = await createAddressFn(db, owner, expiry.ttlSeconds, expiry.permanent, trimmedNote);
  const label = trimmedNote ? ` (${trimmedNote})` : "";
  return `Your new disposable address: ${address}${label}\n${describeExpiry(expiry)}`;
}

async function handleList(db: SqlExecutor, owner: OwnerRef, config: CommandConfig): Promise<string> {
  const addresses = await listActiveAddresses(db, owner);
  const quota = `${addresses.length}/${config.maxActiveAddresses} active addresses`;
  if (addresses.length === 0) {
    return `${quota}.`;
  }
  const lines = addresses.map((a) => {
    const when = a.permanent === 1 ? "permanent" : `expires ${new Date(a.expires_at * 1000).toISOString().slice(0, 10)}`;
    const label = a.note ? ` ${a.note} ` : " ";
    const id = a.short_id ? `#${a.short_id} ` : "";
    return `${id}${a.address}${label}(${when})`;
  });
  return [`${quota}:`, ...lines].join("\n");
}

async function handleNote(db: SqlExecutor, owner: OwnerRef, remainder: string): Promise<string> {
  const nextSpace = remainder.indexOf(" ");
  const addressOrId = (nextSpace === -1 ? remainder : remainder.slice(0, nextSpace)).trim().toLowerCase();
  const note = (nextSpace === -1 ? "" : remainder.slice(nextSpace + 1)).trim().slice(0, MAX_NOTE_LENGTH);
  if (!addressOrId) {
    return "Usage: /cm-note <address/id> [note]";
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return "Not found or not yours.";
  }
  const updated = await setAddressNote(db, owner, address, note);
  if (!updated) {
    return "Not found or not yours.";
  }
  return note ? `${address} is now labelled "${note}".` : `Cleared the note on ${address}.`;
}

async function handleExtend(
  db: SqlExecutor,
  owner: OwnerRef,
  config: CommandConfig,
  remainder: string
): Promise<string> {
  const { address: addressOrId, expiryDays } = splitAddressAndTrailingExpiry(remainder);
  if (!addressOrId) {
    return "Usage: /cm-extend <address/id> [expiry]";
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return "Not found or not yours.";
  }

  const expiry =
    expiryDays === undefined
      ? { ttlSeconds: config.addressTtlSeconds, permanent: false }
      : parseExpiry(expiryDays, config.addressTtlSeconds);
  if (!expiry) {
    return BAD_EXPIRY_MESSAGE;
  }

  const updated = await extendAddress(db, owner, address, expiry.ttlSeconds, expiry.permanent);
  if (!updated) {
    return "Not found or not yours.";
  }
  if (expiry.permanent) {
    return `${address} is now permanent, good until you torch it.`;
  }
  const days = Math.round(expiry.ttlSeconds / 86400);
  return `${address} now expires in ${days} day${days === 1 ? "" : "s"}.`;
}

async function handleTorch(db: SqlExecutor, owner: OwnerRef, remainder: string): Promise<string> {
  const addressOrId = remainder.trim().toLowerCase();
  if (!addressOrId) {
    return "Usage: /cm-torch <address/id>";
  }
  const address = await resolveAddressIdentifier(db, owner, addressOrId);
  if (!address) {
    return "Not found or not yours.";
  }
  const updated = await revokeAddress(db, owner, address);
  if (!updated) {
    return "Not found or not yours.";
  }
  return `Torched ${address}.`;
}

async function handleRemind(db: SqlExecutor, owner: OwnerRef, remainder: string): Promise<string> {
  const word = remainder.trim();
  if (!word) {
    const current = await getExpiryReminderPreference(db, owner);
    return current
      ? "Expiry reminders are on. /cm-remind off turns them off."
      : "Expiry reminders are off. /cm-remind on turns them on.";
  }

  const enabled = parseBooleanArg(word);
  if (enabled === undefined) {
    return "Usage: /cm-remind [on|off]";
  }
  await setExpiryReminderPreference(db, owner, enabled);
  return enabled
    ? "Expiry reminders on. You'll get a message about a day before an address expires, with time to /cm-extend it. Addresses shorter-lived than that won't get one."
    : "Expiry reminders off. Addresses still expire on schedule, you just won't hear about it first.";
}
