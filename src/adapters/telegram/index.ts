import { htmlToText as coreHtmlToText } from "../../core/html-to-text.ts";
import type { DeliveryResult, MailAdapter, OwnerRef, ParsedMail } from "../../core/types.ts";
import { sendDocument, sendMessage, TelegramApiError, type TelegramFile } from "./telegram-rest.ts";

// Telegram's hard cap per sendMessage call. Anything longer gets sent as a
// message.txt attachment instead, same shape as Discord's inline-body cap.
const TELEGRAM_MESSAGE_CAP = 4096;
const INLINE_BODY_CAP = 3500;
// Telegram's own limit for bot-uploaded documents.
const TELEGRAM_FILE_CAP = 50 * 1024 * 1024;

const MAX_HTML_LENGTH = 256 * 1024;
const SPARSE_TEXT_THRESHOLD = 200;
const SUBSTANTIAL_HTML_THRESHOLD = 1500;

function htmlToText(html: string): string {
  return coreHtmlToText(html, {
    // Sent as plain text (no parse_mode), so nothing needs escaping -- unlike
    // Discord, there's no markdown for attacker-controlled mail to abuse.
    escape: (text) => text,
    // Link previews are disabled per-message via the API instead of by
    // obscuring the URL's syntax, so it can just be printed plainly.
    formatLink: (url) => `(${url})`,
  });
}

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

export function createTelegramAdapter(botToken: string): MailAdapter {
  return {
    name: "telegram",
    async deliver(owner: OwnerRef, mail: ParsedMail): Promise<DeliveryResult> {
      try {
        const header = `From: ${mail.from}\nTo: ${mail.to}\nSubject: ${mail.subject}\n`;
        const files: TelegramFile[] = [];
        const notes: string[] = [];

        const html = mail.html && mail.html.length > MAX_HTML_LENGTH ? mail.html.slice(0, MAX_HTML_LENGTH) : mail.html;
        const readableText = html ? htmlToText(html) : mail.text;
        let bodyText = readableText;

        if (readableText.length > INLINE_BODY_CAP) {
          bodyText = `${truncateAtLineBoundary(readableText, INLINE_BODY_CAP - 1)}…`;
          notes.push("(full message attached)");
          files.push({
            filename: "message.txt",
            contentType: "text/plain; charset=utf-8",
            content: new TextEncoder().encode(readableText).buffer as ArrayBuffer,
          });
        } else if (readableText.length === 0) {
          bodyText = "(no readable content)";
        }

        if (html && readableText.trim().length < SPARSE_TEXT_THRESHOLD && html.length > SUBSTANTIAL_HTML_THRESHOLD) {
          notes.push("(mostly images, original HTML attached. It is the sender's markup, so only open it if you trust them)");
          files.push({
            filename: "message.html",
            contentType: "text/html; charset=utf-8",
            content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          });
        }

        // Telegram documents are sent one at a time (no multi-attachment
        // payload the way Discord bundles files with a message), so budget
        // and skip per file against its own cap rather than a combined one.
        let skipped = 0;
        const toSend: TelegramFile[] = [];
        for (const a of mail.attachments) {
          if (a.size <= TELEGRAM_FILE_CAP) {
            toSend.push({ filename: a.filename, contentType: a.contentType, content: a.content });
          } else {
            skipped++;
          }
        }
        if (skipped > 0) {
          notes.push(`(${skipped} attachment${skipped === 1 ? "" : "s"} too large, discarded)`);
        }

        let content = `${header}\n${bodyText}`;
        if (notes.length > 0) {
          content += `\n\n${notes.join("\n")}`;
        }
        if (content.length > TELEGRAM_MESSAGE_CAP) {
          content = truncateAtLineBoundary(content, TELEGRAM_MESSAGE_CAP - 1) + "…";
        }

        await sendMessage(botToken, owner.id, content);
        for (const file of [...files, ...toSend]) {
          await sendDocument(botToken, owner.id, file);
        }
        return { success: true };
      } catch (err) {
        if (err instanceof TelegramApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async notify(owner: OwnerRef, message: string): Promise<DeliveryResult> {
      try {
        const content =
          message.length > TELEGRAM_MESSAGE_CAP
            ? truncateAtLineBoundary(message, TELEGRAM_MESSAGE_CAP - 1) + "…"
            : message;
        await sendMessage(botToken, owner.id, content);
        return { success: true };
      } catch (err) {
        if (err instanceof TelegramApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
