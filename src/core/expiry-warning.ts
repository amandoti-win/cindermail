import { listAddressesNeedingExpiryWarning, markExpiryWarned } from "./db.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { SqlExecutor } from "./storage.ts";
import type { AddressRow, OwnerRef } from "./types.ts";

// The reminder window, driven by the cleanup cron running once a day.
//
// Warning anything inside [24h, 48h] means every address gets seen by a run
// while it still has at least a day left. Using [0h, 24h] instead would let
// an address expiring 25 hours from now slip past today's run and only get
// warned at tomorrow's, an hour before it goes.
//
// The tradeoff: an address whose whole life is under ~48h may never be
// warned, because no run ever catches it inside the window. That's
// deliberate. "Expires in 24 hours" seconds after someone made a 24-hour
// address is noise, not a service.
const WARN_AFTER_SECONDS = 24 * 60 * 60;
const WARN_BEFORE_SECONDS = 48 * 60 * 60;

function groupByOwner(rows: AddressRow[]): Map<string, { owner: OwnerRef; rows: AddressRow[] }> {
  const groups = new Map<string, { owner: OwnerRef; rows: AddressRow[] }>();
  for (const row of rows) {
    const key = `${row.owner_type}:${row.owner_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { owner: { type: row.owner_type, id: row.owner_id }, rows: [row] });
    }
  }
  return groups;
}

// Discord renders <t:...:R> as "in 20 hours" in the reader's own locale and
// timezone. Telegram and Slack get plain text and an explicit UTC time, plus
// their own spelling of the opt-out command.
const OPT_OUT: Record<string, string> = {
  discord: "`/remind enabled: false`",
  telegram: "/remind off",
  slack: "/cm-remind off",
};

function buildMessage(rows: AddressRow[], ownerType: string): string {
  const discord = ownerType === "discord";
  const lines = rows.map((row) => {
    const label = row.note ? ` (${row.note.replaceAll("`", "")})` : "";
    const when = discord
      ? `<t:${row.expires_at}:R>`
      : `at ${new Date(row.expires_at * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
    return discord ? `\`${row.address}\`${label}, expires ${when}` : `${row.address}${label}, expires ${when}`;
  });
  const title = rows.length === 1 ? "One of your addresses expires soon." : `${rows.length} of your addresses expire soon.`;
  const heading = discord ? `**${title}**` : title;
  const extend = ownerType === "slack" ? "/cm-extend" : discord ? "`/extend`" : "/extend";
  const optOut = OPT_OUT[ownerType] ?? "/remind off";
  return `${heading}\n${lines.join("\n")}\n\n${extend} any you still need. Anything you don't will be torched automatically. ${optOut} turns these off.`;
}

// Bounds the per-run fan-out. Each owner costs up to two outbound
// subrequests and one D1 write, all sharing one invocation's budget with the
// cleanup that follows. Owners past the cap are skipped this run (and, since
// the window is a day wide, usually miss their reminder) -- an acceptable
// loss next to cleanup failing outright.
const MAX_OWNERS_PER_RUN = 20;

// Sent from the daily cleanup cron, immediately before the cleanup itself, so
// an address can't be deleted in the same run that was about to warn about
// it.
//
// That ordering is also why this swallows everything. Reminders are a
// convenience; deleting expired addresses is not. Anything escaping here
// would take out the cleanup running behind it, and the most likely cause is
// mundane: a deployment that hasn't applied migration 0007 has no
// owner_preferences table, so the very first query throws. A missing table
// silently breaking mail delivery has bitten this project once already.
export async function sendExpiryWarnings(db: SqlExecutor, dispatcher: Dispatcher): Promise<number> {
  let due: AddressRow[];
  try {
    due = await listAddressesNeedingExpiryWarning(db, WARN_AFTER_SECONDS, WARN_BEFORE_SECONDS);
  } catch (err) {
    console.warn(`expiry reminders skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  let notified = 0;
  let processed = 0;
  for (const { owner, rows } of groupByOwner(due).values()) {
    if (processed++ >= MAX_OWNERS_PER_RUN) {
      console.warn("expiry reminders capped for this run; the rest wait for the next one");
      break;
    }
    try {
      // One DM per owner listing everything, rather than one per address.
      const result = await dispatcher.notifyOwner(owner, buildMessage(rows, owner.type));
      if (result.success) {
        notified++;
      } else {
        console.warn(`expiry reminder failed via adapter "${owner.type}": ${result.error ?? "unknown error"}`);
      }

      // Marked warned whether or not the DM landed. Someone with closed DMs
      // would otherwise be retried every run until the address expired, and a
      // reminder isn't worth that. Same reasoning as a failed delivery in
      // core/email.ts.
      await markExpiryWarned(
        db,
        rows.map((row) => row.address)
      );
    } catch (err) {
      // An adapter that throws is breaking its own contract, but one bad
      // owner must not cost everyone else their reminder, let alone the
      // cleanup.
      console.warn(`expiry reminder threw for owner type "${owner.type}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return notified;
}
