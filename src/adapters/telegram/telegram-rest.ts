const API_BASE = "https://api.telegram.org";

export interface TelegramFile {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
}

class TelegramApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function telegramFetch(botToken: string, method: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE}/bot${botToken}/${method}`, init);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new TelegramApiError(response.status, `Telegram API ${method} failed: ${response.status} ${body}`);
  }

  return response;
}

export interface TelegramButton {
  text: string;
  data: string;
}

// Telegram has no separate "create a DM channel" step the way Discord does:
// a chat_id is just the user's numeric id, already known from whatever
// update (a command message) established the owner in the first place.
export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  buttons?: TelegramButton[]
): Promise<void> {
  await telegramFetch(botToken, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // No parse_mode: sent as plain text. Delivered mail is attacker-controlled,
    // and Telegram's MarkdownV2 requires escaping a long list of characters
    // that plain text sidesteps entirely -- same tradeoff Discord's adapter
    // makes by escaping rather than risking a missed character.
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons && {
        reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
      }),
    }),
  });
}

// Telegram shows a spinner on a tapped button until this is called.
export async function answerCallbackQuery(botToken: string, callbackQueryId: string): Promise<void> {
  await telegramFetch(botToken, "answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// Replaces the message the button was on. Sending no reply_markup is what
// removes the keyboard, so it can't be tapped a second time.
export async function editMessageText(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string
): Promise<void> {
  await telegramFetch(botToken, "editMessageText", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

export async function sendDocument(
  botToken: string,
  chatId: string,
  file: TelegramFile,
  caption?: string
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
  }
  form.append("document", new Blob([file.content], { type: file.contentType }), file.filename);

  await telegramFetch(botToken, "sendDocument", { method: "POST", body: form });
}

export { TelegramApiError };
