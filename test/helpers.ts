import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlExecutor } from "../src/core/storage.ts";
import type { OwnerRef } from "../src/core/types.ts";
import type { DiscordInteraction } from "../src/adapters/discord/interactions.ts";
import type { TelegramUpdate } from "../src/adapters/telegram/commands.ts";
import type { SlackSlashCommandPayload } from "../src/adapters/slack/commands.ts";

// Resolved against this file rather than the working directory, so the tests
// pass no matter where they're invoked from.
const repoFile = (name: string) => join(import.meta.dirname, "..", name);

// A real SQLite database rather than a stub: these tests are mostly about
// whether the SQL is right, which a hand-rolled fake would never catch. D1
// speaks the same dialect, and src/storage/d1.ts implements this same
// interface against it.
export function testDb(): { db: SqlExecutor; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(repoFile("schema.sql"), "utf8"));
  const db: SqlExecutor = {
    async run(sql, ...params) {
      const result = raw.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (raw.prepare(sql).get(...(params as never[])) as T) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  return { db, raw };
}

export const owner = (id: string): OwnerRef => ({ type: "discord", id });

export function command(
  userId: string,
  name: string,
  options: { name: string; value: string | number | boolean }[] = []
): DiscordInteraction {
  return { type: 2, member: { user: { id: userId } }, data: { name, options } };
}

export const replyText = (reply: unknown): string => (reply as { data: { content: string } }).data.content;

// The address in a reply, pulled out of the code span it's wrapped in.
export const replyAddress = (reply: unknown): string => (replyText(reply).match(/`([^`]+)`/) ?? [])[1] ?? "";

export const telegramOwner = (id: string) => ({ type: "telegram", id });

export function telegramUpdate(
  userId: string,
  text: string,
  chatType: string = "private",
  chatId: number = Number(userId)
): TelegramUpdate {
  return { message: { text, chat: { id: chatId, type: chatType }, from: { id: Number(userId) } } };
}

// Telegram replies are plain text, no wrapper object the way a Discord
// interaction response has -- this only exists so tests can call the same
// replyText-style helper name for both.
export const telegramReplyText = (reply: { chatId: string; text: string } | null): string => reply?.text ?? "";

// The address in a reply, plain text with no code-span wrapper to pull it
// out of.
export const telegramReplyAddress = (reply: { chatId: string; text: string } | null): string =>
  (telegramReplyText(reply).match(/address: (?:#\d+ )?(\S+)/) ?? [])[1] ?? "";

export const slackOwner = (id: string): OwnerRef => ({ type: "slack", id });

export function slackPayload(userId: string, command: string, text: string = ""): SlackSlashCommandPayload {
  return { command, text, user_id: userId };
}

export const migrationFile = (name: string) => readFileSync(repoFile(`migrations/${name}`), "utf8");
export const schemaSql = () => readFileSync(repoFile("schema.sql"), "utf8");
