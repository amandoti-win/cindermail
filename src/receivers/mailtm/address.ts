import { randomAlphanumeric, registerAddress } from "../../core/db.ts";
import type { SqlExecutor } from "../../core/storage.ts";
import type { OwnerRef } from "../../core/types.ts";
import { createAccount, deleteAccount, getActiveDomain, getToken, MailtmApiError } from "./client.ts";

const LOCAL_PART_LENGTH = 10;
const PASSWORD_LENGTH = 24;
// Kept low: every attempt is a sequential mail.tm round trip inside the
// platform's 3-second synchronous reply window, and a 422 on a random
// 10-char local part is rare.
const MAX_CREATE_ATTEMPTS = 3;

export interface MailtmReceiverData {
  provider: "mailtm";
  password: string;
  accountId: string;
}

// Unlike createAddress (core/db.ts), which invents a local part on a domain
// you own and just inserts a row, this has to actually provision a mailbox
// on mail.tm's side first, then persist whatever it gave back plus enough
// to authenticate as that mailbox later (the poller needs to log back in on
// every cycle, and cleanup needs the account id to delete it).
export async function createMailtmAddress(
  db: SqlExecutor,
  owner: OwnerRef,
  ttlSeconds: number,
  permanent = false,
  note: string | null = null
): Promise<string> {
  const domain = await getActiveDomain();

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const address = `${randomAlphanumeric(LOCAL_PART_LENGTH)}@${domain}`;
    const password = randomAlphanumeric(PASSWORD_LENGTH);

    try {
      const account = await createAccount(address, password);
      const receiverData: MailtmReceiverData = { provider: "mailtm", password, accountId: account.id };
      try {
        await registerAddress(db, address, owner, ttlSeconds, JSON.stringify(receiverData), permanent, note);
      } catch (err) {
        // The row (and with it the only copy of the password) never landed,
        // so this is the last chance to remove the mailbox on mail.tm's side.
        await getToken(address, password)
          .then((token) => deleteAccount(token, account.id))
          .catch(() => {});
        throw err;
      }
      return address;
    } catch (err) {
      // 422 means the address is already taken on mail.tm's side (or, once
      // in a while, a local part that collides with an existing row here
      // too) -- retry with a fresh random local part rather than failing.
      if (err instanceof MailtmApiError && err.status === 422 && attempt < MAX_CREATE_ATTEMPTS - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("failed to allocate a unique mail.tm address after several attempts");
}
