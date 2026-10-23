import { deleteExpiredAndRevoked, deleteStaleRateLimits, listExpiredAndRevoked } from "../../core/db.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import { deleteAccount, getToken } from "./client.ts";
import type { MailtmReceiverData } from "./address.ts";

const CLEANUP_GRACE_SECONDS = 24 * 60 * 60;
const STALE_RATE_LIMIT_SECONDS = 30 * 24 * 60 * 60;

// Rows about to be hard-deleted here are the only chance to also delete the
// mailbox on mail.tm's side. Miss this window and the account just sits on
// their server forever, still counting against whatever account limits they
// enforce, for no benefit to anyone.
export async function runMailtmCleanup(db: SqlExecutor): Promise<void> {
  const expiring = await listExpiredAndRevoked(db, CLEANUP_GRACE_SECONDS);

  for (const row of expiring) {
    if (!row.receiver_data) {
      continue;
    }
    try {
      const receiverData = JSON.parse(row.receiver_data) as Partial<MailtmReceiverData>;
      if (receiverData.provider !== "mailtm" || !receiverData.password || !receiverData.accountId) {
        continue;
      }
      const token = await getToken(row.address, receiverData.password);
      await deleteAccount(token, receiverData.accountId);
    } catch (err) {
      // Don't let one account's cleanup failure (already deleted, mail.tm
      // briefly down, whatever) block the row from being dropped here too.
      console.error(`mail.tm account cleanup failed for #${row.short_id ?? "?"}:`, err instanceof Error ? err.message : err);
    }
  }

  await deleteExpiredAndRevoked(db, CLEANUP_GRACE_SECONDS);
  await deleteStaleRateLimits(db, STALE_RATE_LIMIT_SECONDS);
}
