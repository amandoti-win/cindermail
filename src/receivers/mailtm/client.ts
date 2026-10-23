// Thin wrapper around mail.tm's REST API. Verified live against the real
// API while building this:
//   GET  /domains                     -> list of usable domains
//   POST /accounts                    -> create a mailbox
//   POST /token                       -> auth, get a bearer token
//   GET  /messages                    -> list messages (no reliable seen=
//                                         filter despite the API accepting
//                                         it, so the poller just deletes
//                                         each message after processing
//                                         instead of tracking seen state)
//   GET  /sources/{id}                -> { data: "<raw MIME as a string>" },
//                                         which postal-mime accepts directly
//   DELETE /messages/{id}             -> 204
//   DELETE /accounts/{id}             -> 204
const API_BASE = "https://api.mail.tm";

export class MailtmApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function mailtmFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new MailtmApiError(response.status, `mail.tm ${path} failed: ${response.status} ${body}`);
  }
  return response;
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// The active domain changes rarely; caching it per isolate drops one of the
// sequential mail.tm round trips /new makes inside Discord's and Slack's
// 3-second reply window. The fetch itself is read-only, so it's safe to
// time out.
const DOMAIN_CACHE_SECONDS = 600;
let cachedDomain: { domain: string; fetchedAt: number } | undefined;

export async function getActiveDomain(): Promise<string> {
  const now = Date.now() / 1000;
  if (cachedDomain && now - cachedDomain.fetchedAt < DOMAIN_CACHE_SECONDS) {
    return cachedDomain.domain;
  }
  const response = await mailtmFetch("/domains", { signal: AbortSignal.timeout(1500) });
  const body = (await response.json()) as { "hydra:member": { domain: string; isActive: boolean }[] };
  const active = body["hydra:member"].find((d) => d.isActive);
  if (!active) {
    throw new Error("mail.tm has no active domains available right now");
  }
  cachedDomain = { domain: active.domain, fetchedAt: now };
  return active.domain;
}

export async function createAccount(address: string, password: string): Promise<{ id: string }> {
  const response = await mailtmFetch("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  const body = (await response.json()) as { id: string };
  return { id: body.id };
}

export async function getToken(address: string, password: string): Promise<string> {
  const response = await mailtmFetch("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

export interface MailtmMessageSummary {
  id: string;
  sourceUrl: string;
  // Bytes, as reported by mail.tm. 0 if absent.
  size: number;
}

export async function listMessages(token: string): Promise<MailtmMessageSummary[]> {
  const response = await mailtmFetch("/messages", { headers: authHeader(token) });
  const body = (await response.json()) as { "hydra:member": { id: string; sourceUrl: string; size?: number }[] };
  return body["hydra:member"].map((m) => ({ id: m.id, sourceUrl: m.sourceUrl, size: Number(m.size) || 0 }));
}

export async function fetchSource(token: string, sourceUrl: string): Promise<string> {
  const response = await mailtmFetch(sourceUrl, { headers: authHeader(token) });
  const body = (await response.json()) as { data: string };
  return body.data;
}

export async function deleteMessage(token: string, messageId: string): Promise<void> {
  await mailtmFetch(`/messages/${messageId}`, { method: "DELETE", headers: authHeader(token) });
}

export async function deleteAccount(token: string, accountId: string): Promise<void> {
  await mailtmFetch(`/accounts/${accountId}`, { method: "DELETE", headers: authHeader(token) });
}
