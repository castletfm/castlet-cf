/**
 * Atomic storage-quota accounting against the account_usage singleton row
 * (mvp-design.md sections 9.1 and 17, items 1-3).
 *
 * Every mutation is a single conditional UPDATE so concurrent requests can
 * never overshoot the ceiling through a read-modify-write race: the quota
 * condition is evaluated by SQLite inside the same statement that applies
 * the change, and a false condition simply matches zero rows.
 */

export interface AccountUsage {
  activeBytes: number;
  reservedBytes: number;
}

interface AccountUsageRow {
  active_bytes: number;
  reserved_bytes: number;
}

export async function getAccountUsage(db: D1Database): Promise<AccountUsage> {
  const row = await db
    .prepare("SELECT active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1")
    .first<AccountUsageRow>();
  if (row === null) {
    throw new Error("account_usage singleton row is missing");
  }
  return { activeBytes: row.active_bytes, reservedBytes: row.reserved_bytes };
}

/**
 * Reserves `size` bytes if and only if active + reserved + size stays at or
 * below `maxTotalBytes`. Returns false (and changes nothing) when the
 * reservation would exceed the quota.
 */
export async function reserveBytes(
  db: D1Database,
  size: number,
  maxTotalBytes: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE account_usage
       SET reserved_bytes = reserved_bytes + ?1, updated_at = ?2
       WHERE singleton_id = 1 AND active_bytes + reserved_bytes + ?1 <= ?3`,
    )
    .bind(size, new Date().toISOString(), maxTotalBytes)
    .run();
  return result.meta.changes > 0;
}

/**
 * Releases a previous reservation of `size` bytes (abort, rejection, or
 * expiry). Returns false when fewer than `size` bytes are reserved, which
 * indicates quota drift for the maintenance endpoint to reconcile; nothing
 * is changed in that case so the counter can never go negative.
 */
export async function releaseReservedBytes(db: D1Database, size: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE account_usage
       SET reserved_bytes = reserved_bytes - ?1, updated_at = ?2
       WHERE singleton_id = 1 AND reserved_bytes >= ?1`,
    )
    .bind(size, new Date().toISOString())
    .run();
  return result.meta.changes > 0;
}

/**
 * Completes an upload: releases the declared reservation and adds the
 * verified actual byte count to active storage in one atomic statement
 * (actual size may be smaller than the declared reservation; larger uploads
 * are rejected before this point). Returns false on quota drift.
 */
export async function commitReservedBytes(
  db: D1Database,
  reservedSize: number,
  actualSize: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE account_usage
       SET reserved_bytes = reserved_bytes - ?1,
           active_bytes = active_bytes + ?2,
           updated_at = ?3
       WHERE singleton_id = 1 AND reserved_bytes >= ?1`,
    )
    .bind(reservedSize, actualSize, new Date().toISOString())
    .run();
  return result.meta.changes > 0;
}
