import type { DeliveryResult, MailAdapter, OwnerRef, ParsedMail } from "../../core/types.ts";
import { createDM, DiscordApiError, sendMessage, type DiscordFile } from "./discord-rest.ts";
import { escapeMarkdown, htmlToText } from "./html-to-text.ts";

const DISCORD_MESSAGE_CAP = 2000;
const INLINE_BODY_CAP = 1500;
const DISCORD_PAYLOAD_CAP = 25 * 1024 * 1024;
// Discord rejects the whole message above 10 attachments, which would lose
// the mail body along with the extras.
const DISCORD_MAX_FILES = 10;

// Email HTML is attacker-controlled: anyone who learns an address can send
// to it, and the tag-matching in htmlToText scales quadratically with input
// size. Cloudflare accepts messages far larger than any real email body, so
// bound what gets parsed to keep worst-case CPU well inside Worker limits.
const MAX_HTML_LENGTH = 256 * 1024;

// If the extracted text is thin but the source HTML was substantial, the
// email is likely all-image content (a common marketing-email pattern) that
// htmlToText correctly has nothing to show for. Rather than leaving the
// user with an empty-looking message, fall back to attaching the raw HTML
// so it's still viewable (open it in a browser, the image URLs it
// references still resolve).
const SPARSE_TEXT_THRESHOLD = 200;
const SUBSTANTIAL_HTML_THRESHOLD = 1500;

// A hard character-count slice can land in the middle of a link's "label
// (url)" text, leaving a dangling fragment. Cut on whole-line boundaries
// instead. Every link produced by htmlToText lives entirely within a
// single line, so this never splits one.
function truncateAtLineBoundary(text: string, maxLength: number): string {
  const lines = text.split("\n");
  let result = "";
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (candidate.length > maxLength) {
      break;
    }
    result = candidate;
  }
  return result || text.slice(0, maxLength);
}

export function createDiscordAdapter(botToken: string): MailAdapter {
  return {
    name: "discord",
    async deliver(owner: OwnerRef, mail: ParsedMail): Promise<DeliveryResult> {
      try {
        const channel = await createDM(botToken, owner.id);

        // Sender and subject are attacker-controlled and go straight into a
        // markdown-rendered message, so they get the same escaping the body
        // does. mail.to is ours, generated from a fixed alphabet.
        const header = `**From:** ${escapeMarkdown(mail.from)}\n**To:** ${mail.to}\n**Subject:** ${escapeMarkdown(
          mail.subject
        )}\n`;
        const files: DiscordFile[] = [];
        const notes: string[] = [];

        // The text/plain part (if any) is not trustworthy on its own. Some senders
        // populate it with raw HTML or other markup instead of real plain text. When
        // an HTML part exists, always derive the readable body from it directly.
        //
        // htmlToText escapes markdown itself (it has to, since it splices real
        // link syntax in afterward). A plain-text part has had nothing done to
        // it at all, so it gets escaped here.
        const html = mail.html && mail.html.length > MAX_HTML_LENGTH ? mail.html.slice(0, MAX_HTML_LENGTH) : mail.html;
        const readableText = html ? htmlToText(html) : escapeMarkdown(mail.text);
        let bodyText = readableText;

        if (readableText.length > INLINE_BODY_CAP) {
          bodyText = `${truncateAtLineBoundary(readableText, INLINE_BODY_CAP - 1)}…`;
          notes.push("_(full message attached)_");
          files.push({
            filename: "message.txt",
            contentType: "text/plain; charset=utf-8",
            content: new TextEncoder().encode(readableText).buffer as ArrayBuffer,
          });
        } else if (readableText.length === 0) {
          bodyText = "(no readable content)";
        }

        if (html && readableText.trim().length < SPARSE_TEXT_THRESHOLD && html.length > SUBSTANTIAL_HTML_THRESHOLD) {
          notes.push("_(mostly images, original HTML attached. It is the sender's markup, so only open it if you trust them)_");
          files.push({
            filename: "message.html",
            contentType: "text/html; charset=utf-8",
            content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          });
        }

        // Budget the whole multipart payload, not just the mail's own
        // attachments: the generated message.txt/.html above count against the
        // same limit. Attachments are taken individually while they fit, so one
        // oversized file no longer discards the small ones alongside it.
        let payloadBudget = DISCORD_PAYLOAD_CAP - files.reduce((sum, f) => sum + f.content.byteLength, 0);
        let skipped = 0;
        for (const a of mail.attachments) {
          if (files.length < DISCORD_MAX_FILES && a.size <= payloadBudget) {
            files.push({ filename: a.filename, contentType: a.contentType, content: a.content });
            payloadBudget -= a.size;
          } else {
            skipped++;
          }
        }
        if (skipped > 0) {
          notes.push(`_(${skipped} attachment${skipped === 1 ? "" : "s"} over the size or count limit, discarded)_`);
        }

        // Assemble and cap exactly once, with every note already included.
        // Appending after the cap check could push the message back over
        // Discord's limit and fail the whole delivery.
        let content = `${header}\n${bodyText}`;
        if (notes.length > 0) {
          content += `\n\n${notes.join("\n")}`;
        }
        if (content.length > DISCORD_MESSAGE_CAP) {
          content = truncateAtLineBoundary(content, DISCORD_MESSAGE_CAP - 1) + "…";
        }

        await sendMessage(botToken, channel.id, { content, files });
        return { success: true };
      } catch (err) {
        if (err instanceof DiscordApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    // A message from the bot itself, not a forwarded email, so it skips the
    // From/To/Subject header and the attachment handling entirely. The
    // message is composed by us rather than by a sender, so it isn't escaped:
    // the only external text in it is an address note, which core escapes
    // before it gets here.
    async notify(owner: OwnerRef, message: string): Promise<DeliveryResult> {
      try {
        const channel = await createDM(botToken, owner.id);
        const content =
          message.length > DISCORD_MESSAGE_CAP
            ? truncateAtLineBoundary(message, DISCORD_MESSAGE_CAP - 1) + "…"
            : message;
        await sendMessage(botToken, channel.id, { content });
        return { success: true };
      } catch (err) {
        if (err instanceof DiscordApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
