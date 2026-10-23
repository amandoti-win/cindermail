import { listActiveAddressesWithReceiverData } from "../../core/db.ts";
import type { Dispatcher } from "../../core/dispatch.ts";
import { handleInboundEmail } from "../../core/email.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import { deleteMessage, fetchSource, getToken, listMessages } from "./client.ts";
import type { MailtmReceiverData } from "./address.ts";

function parseReceiverData(receiverData: string | null): MailtmReceiverData | null {
  if (!receiverData) {
    return null;
  }
  try {
    const parsed = JSON.parse(receiverData) as { provider?: string };
    return parsed.provider === "mailtm" ? (parsed as MailtmReceiverData) : null;
  } catch {
    return null;
  }
}

// Far above any real mail, well below what risks the isolate's memory once
// the JSON-wrapped source, its parse, and decoded attachments coexist.
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

// mail.tm has no push mechanism worth relying on for a simple poller, so
// this just checks every mail.tm-backed address on an interval. There's no
// reliable seen= filter on their /messages endpoint (verified live: it
// accepts the query param but doesn't actually filter), so instead of
// tracking seen state, each message is deleted from mail.tm right after
// it's been handed to the core, keeping every future poll's list small and
// made only of genuinely unprocessed mail.
export async function pollOnce(db: SqlExecutor, dispatcher: Dispatcher): Promise<void> {
  // Shuffled: one run that dies partway (CPU/memory limit) would otherwise
  // always die at the same mailbox and never reach the ones after it.
  const addresses = shuffle(await listActiveAddressesWithReceiverData(db));

  for (const row of addresses) {
    const receiverData = parseReceiverData(row.receiver_data);
    if (!receiverData) {
      continue;
    }

    try {
      const token = await getToken(row.address, receiverData.password);
      const messages = await listMessages(token);

      for (const message of messages) {
        // Deleted before it's handled, so delivery is at-most-once: a
        // message that throws while parsing, or kills the whole invocation,
        // is gone after one attempt instead of being fetched and retried
        // every minute forever. A failed delete also means an overlapping
        // run already claimed it, so it's skipped rather than delivered twice.
        const raw = message.size > MAX_SOURCE_BYTES ? null : await fetchSource(token, message.sourceUrl);
        try {
          await deleteMessage(token, message.id);
        } catch (err) {
          console.warn(`mail.tm message not claimed, skipping: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (raw === null) {
          console.warn("mail.tm message over the size cap, dropped unread");
          continue;
        }
        try {
          await handleInboundEmail({ to: row.address, from: "unknown", raw }, db, dispatcher);
        } catch (err) {
          console.error(`mail.tm message dropped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      console.error(`mail.tm poll failed for #${row.short_id ?? "?"}:`, err instanceof Error ? err.message : err);
    }
  }
}

