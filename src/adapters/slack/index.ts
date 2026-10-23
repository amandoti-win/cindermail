import { htmlToText as coreHtmlToText } from "../../core/html-to-text.ts";
import type { DeliveryResult, MailAdapter, OwnerRef, ParsedMail } from "../../core/types.ts";
import { postMessage, uploadFile, SlackApiError, type SlackFile } from "./slack-rest.ts";

// Conservative caps, not Slack's actual platform maximums -- chosen the
// same way Discord's and Telegram's adapters picked theirs: a point past
// which a message stops being a quick DM to skim and should be an
// attachment instead.
const INLINE_BODY_CAP = 3500;
const SLACK_FILE_CAP = 50 * 1024 * 1024;

const MAX_HTML_LENGTH = 256 * 1024;
const SPARSE_TEXT_THRESHOLD = 200;
const SUBSTANTIAL_HTML_THRESHOLD = 1500;

// Slack parses <...> in message text as control syntax: masked links
// (<url|label>), mentions (<@U123>, <!channel>) and dates. It requires &, <
// and > to be sent as entities to display literally. Applied once to the
// composed message rather than inside htmlToText, so the message.txt
// attachment keeps the raw text.
function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlToText(html: string): string {
  return coreHtmlToText(html, {
    // mrkdwn has its own small set of special characters (*_~`), but
    // escaping them would mangle legitimate-looking formatting in
    // forwarded mail worse than just leaving it plain -- same tradeoff
    // Telegram's plain-text send makes, just for a different syntax.
    escape: (text) => text,
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

export function createSlackAdapter(botToken: string): MailAdapter {
  return {
    name: "slack",
    async deliver(owner: OwnerRef, mail: ParsedMail): Promise<DeliveryResult> {
      try {
        const header = `From: ${mail.from}\nTo: ${mail.to}\nSubject: ${mail.subject}\n`;
        const files: SlackFile[] = [];
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
          notes.push("(mostly images, original HTML attached; open it in a browser to view)");
          files.push({
            filename: "message.html",
            contentType: "text/html; charset=utf-8",
            content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          });
        }

        // Slack files are uploaded one at a time via the external-upload
        // flow (no bundled multi-attachment payload the way Discord sends
        // files alongside a message), so budget and skip per file against
        // its own cap rather than a combined one.
        let skipped = 0;
        const toSend: SlackFile[] = [];
        for (const a of mail.attachments) {
          if (a.size <= SLACK_FILE_CAP) {
            toSend.push({ filename: a.filename, contentType: a.contentType, content: a.content });
          } else {
            skipped++;
          }
        }
        if (skipped > 0) {
          notes.push(`(${skipped} attachment${skipped === 1 ? "" : "s"} too large, discarded)`);
        }

        let content = slackEscape(`${header}\n${bodyText}`);
        if (notes.length > 0) {
          content += `\n\n${notes.join("\n")}`;
        }

        await postMessage(botToken, owner.id, content);
        for (const file of [...files, ...toSend]) {
          await uploadFile(botToken, owner.id, file);
        }
        return { success: true };
      } catch (err) {
        if (err instanceof SlackApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async notify(owner: OwnerRef, message: string): Promise<DeliveryResult> {
      try {
        await postMessage(botToken, owner.id, message);
        return { success: true };
      } catch (err) {
        if (err instanceof SlackApiError) {
          return { success: false, error: err.message };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
