import { countActiveAddresses, getAddressByShortId, revokeAllAddresses } from "./db.ts";
import type { SqlExecutor } from "./storage.ts";
import type { OwnerRef } from "./types.ts";

// How a new address actually gets created differs by mode: a domain you own
// means inventing a random local part, mail.tm means calling their API and
// getting an address back. Injecting this keeps command handling identical
// across both instead of each needing its own copy of /new, /list, /extend,
// /torch, and identical again across every chat platform adapter.
export type CreateAddressFn = (
  db: SqlExecutor,
  owner: OwnerRef,
  ttlSeconds: number,
  permanent: boolean,
  note: string | null
) => Promise<string>;

// Also applied by Discord itself via max_length/max_value on the registered
// commands, so out-of-range input is normally rejected in its UI before
// reaching the Worker. Enforced here too for anything that arrives another
// way, and for adapters (like Telegram) with no equivalent client-side
// enforcement at all.
//
// A note is long enough to be a useful label, short enough that /list stays
// scannable. Past MAX_EXPIRY_DAYS an expiry stops being a meaningful date,
// and anyone wanting longer wants a permanent address anyway.
export const MAX_NOTE_LENGTH = 80;
export const MAX_EXPIRY_DAYS = 3650;

export interface Expiry {
  ttlSeconds: number;
  permanent: boolean;
}

// `expiry` is in days, 0 meaning permanent.
//
// Permanent still carries the default TTL rather than 0: core/db.ts keeps
// expires_at fresh even on permanent rows deliberately, so that dropping the
// flag later leaves a usable expiry instead of one that lapsed while the
// address was permanent.
export function parseExpiry(days: number, defaultTtlSeconds: number): Expiry | null {
  if (days < 0 || days > MAX_EXPIRY_DAYS) {
    return null;
  }
  return days === 0
    ? { ttlSeconds: defaultTtlSeconds, permanent: true }
    : { ttlSeconds: days * 86400, permanent: false };
}

export function describeExpiry(expiry: Expiry): string {
  if (expiry.permanent) {
    return "Permanent, good until you torch it.";
  }
  const days = Math.round(expiry.ttlSeconds / 86400);
  return `Expires in ${days} day${days === 1 ? "" : "s"}.`;
}

export const BAD_EXPIRY_MESSAGE = `\`expiry\` must be a whole number of days between 0 and ${MAX_EXPIRY_DAYS}. Use 0 for permanent.`;

const SHORT_ID_PATTERN = /^\d{5}$/;

// /note, /extend, and /torch all accept either the full address or its
// short id, identical across every adapter. Anything that isn't exactly 5
// digits is assumed to already be an address and passed through unchanged;
// the db call it feeds into fails with the same "not found" either way.
export async function resolveAddressIdentifier(
  db: SqlExecutor,
  owner: OwnerRef,
  identifier: string
): Promise<string | null> {
  if (!SHORT_ID_PATTERN.test(identifier)) {
    return identifier;
  }
  const row = await getAddressByShortId(db, owner, identifier);
  return row?.address ?? null;
}

// `/torch all` ends every live address the owner has. "all" can never collide
// with a real argument: addresses contain "@" and short ids are 5 digits.
export const TORCH_ALL_KEYWORD = "all";

export function describeTorchAll(count: number): string {
  if (count === 0) {
    return "You have no active addresses to torch.";
  }
  return `Torched all ${count} address${count === 1 ? "" : "es"}.`;
}

// What the confirm/cancel buttons carry back. Discord's custom_id, Telegram's
// callback_data and Slack's button value are all opaque strings the platform
// echoes on click, so the same two shapes work everywhere: "confirm:<count>"
// and "cancel". The count is how many addresses the preview showed.
export const TORCH_ALL_CONFIRM = "confirm";
export const TORCH_ALL_CANCEL = "cancel";

export interface TorchAllPreview {
  text: string;
  // 0 means there is nothing to torch, so no buttons should be offered.
  count: number;
}

// `/torch all` itself never deletes anything: it only reports how many live
// addresses a confirm would end.
export async function previewTorchAll(db: SqlExecutor, owner: OwnerRef): Promise<TorchAllPreview> {
  const count = await countActiveAddresses(db, owner);
  if (count === 0) {
    return { text: describeTorchAll(0), count };
  }
  return {
    text: `This will torch all ${count} address${count === 1 ? "" : "es"} and can't be undone.`,
    count,
  };
}

export function torchAllConfirmValue(count: number): string {
  return `${TORCH_ALL_CONFIRM}:${count}`;
}

// A click is always acted on for whoever clicked, never for an owner named
// in the button, so a forwarded or replayed button can only ever torch the
// clicker's own addresses. The embedded count is a staleness check: if the
// addresses changed between the preview and the click, nothing is torched
// and the owner is sent back to review again.
export async function resolveTorchAllClick(db: SqlExecutor, owner: OwnerRef, value: string): Promise<string> {
  if (value === TORCH_ALL_CANCEL) {
    return "Cancelled. Nothing was torched.";
  }
  const [action, expected] = value.split(":");
  if (action !== TORCH_ALL_CONFIRM || !/^\d+$/.test(expected ?? "")) {
    return "That button isn't valid anymore.";
  }
  if ((await countActiveAddresses(db, owner)) !== Number(expected)) {
    return "Your addresses changed since this was shown, so nothing was torched. Run torch all again to review.";
  }
  return describeTorchAll(await revokeAllAddresses(db, owner));
}
