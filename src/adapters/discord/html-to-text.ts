import { htmlToText as coreHtmlToText } from "../../core/html-to-text.ts";

// Discord renders markdown in bot messages, and every part of an email is
// attacker-controlled: anyone who learns an address can send to it. Without
// this, a body (or an anchor's own label) containing
// `[www.yourbank.com](https://evil.example)` arrives as a clickable link
// whose visible text lies about its destination.
//
// Escaping [ and ] alone is what defeats that, since a masked link needs
// both. The formatting characters are escaped too so a sender can't mangle
// the message's presentation. Deliberately left alone: parentheses, hyphens,
// # and >, which are common in ordinary prose and at worst cosmetic here.
// Backslash goes first so it can't be used to undo the rest.
const MARKDOWN_SPECIALS = /([\\`*_~|[\]])/g;

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, "\\$1");
}

function isSafeLink(url: string): boolean {
  if (/[\s\u0000-\u001f\u007f<>]/.test(url)) {
    return false;
  }
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function htmlToText(html: string): string {
  return coreHtmlToText(html, {
    escape: escapeMarkdown,
    // Wrapped in <> to suppress Discord's auto-embed preview card.
    // The URL is spliced in unescaped, so it must not be able to close the
    // <...> early or start a new line: one containing whitespace, a control
    // character or an angle bracket, or that isn't a web/mail link at all,
    // is dropped (its label is still shown).
    formatLink: (url) => (isSafeLink(url) ? `(<${url}>)` : ""),
  });
}
