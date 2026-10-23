import PostalMime, { type RawEmail } from "postal-mime";
import { getAddress, incrementReceivedCounter } from "./db.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { SqlExecutor } from "./storage.ts";
import type { OwnerRef, ParsedMail } from "./types.ts";

// Deliberately not Cloudflare's ForwardableEmailMessage: postal-mime accepts
// every raw format either mode hands it (a ReadableStream from Email Routing,
// a string from mail.tm's API), so this is the only shape core needs.
export interface InboundMessage {
  to: string;
  from: string;
  raw: RawEmail;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u0085\u2028\u2029]+/g, " ");
}

export async function handleInboundEmail(
  message: InboundMessage,
  db: SqlExecutor,
  dispatcher: Dispatcher
): Promise<void> {
  const recipient = message.to.toLowerCase();
  const row = await getAddress(db, recipient);

  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked !== 0 || (row.permanent !== 1 && row.expires_at <= now)) {
    return;
  }

  const owner: OwnerRef = { type: row.owner_type, id: row.owner_id };

  const parsed = await PostalMime.parse(message.raw, { attachmentEncoding: "arraybuffer" });
  // Counted only once the message actually parsed, so a message that can't
  // be (and gets retried, or bounced) doesn't inflate the public counter.
  await incrementReceivedCounter(db);
  const mail: ParsedMail = {
    // Decoded header values can contain line breaks (RFC 2047), which would
    // let a sender forge extra From:/To: lines in every adapter's header.
    from: oneLine(parsed.from?.address ?? message.from),
    to: row.address,
    subject: oneLine(parsed.subject ?? "(no subject)"),
    text: parsed.text ?? "",
    html: parsed.html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.mimeType,
      size: a.content instanceof ArrayBuffer ? a.content.byteLength : 0,
      content: a.content as ArrayBuffer,
    })),
  };

  const result = await dispatcher.deliverMail(owner, mail);

  // A failed delivery (most often the recipient having DMs closed) must not
  // throw. The mail is already accepted at this point and retrying would
  // just redeliver. But failing silently makes it impossible to tell a
  // broken adapter from an empty inbox, so record that it happened. Only the
  // adapter type and error are logged: never message content, addresses, or
  // owner ids.
  if (!result.success) {
    console.warn(`delivery failed via adapter "${owner.type}": ${result.error ?? "unknown error"}`);
  }
}
