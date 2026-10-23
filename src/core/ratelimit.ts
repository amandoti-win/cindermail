import type { SqlExecutor } from "./storage.ts";

// One conditional upsert rather than SELECT-then-write, so concurrent
// requests from the same owner can't all read the same stale count and all
// pass. SQLite evaluates every SET expression and the WHERE against the row
// as it was before the update, and D1 serializes writes, so exactly one
// statement observes each count value. changes = 0 means the WHERE refused
// the update: the window is still open and already at maxCount.
export async function checkAndIncrement(
  db: SqlExecutor,
  ownerType: string,
  ownerId: string,
  action: string,
  windowSeconds: number,
  maxCount: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db.run(
    `INSERT INTO rate_limits (owner_type, owner_id, action, window_start, count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(owner_type, owner_id, action) DO UPDATE SET
       count = CASE WHEN ? - rate_limits.window_start > ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN ? - rate_limits.window_start > ? THEN ? ELSE rate_limits.window_start END
     WHERE ? - rate_limits.window_start > ? OR rate_limits.count < ?`,
    ownerType,
    ownerId,
    action,
    now,
    now,
    windowSeconds,
    now,
    windowSeconds,
    now,
    now,
    windowSeconds,
    maxCount
  );
  return result.changes > 0;
}
