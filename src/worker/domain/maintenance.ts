import { MAINTENANCE_SWEEP_LIMIT } from "../../shared/constants";
import type { MaintenanceRunResponse } from "../../shared/contracts";
import { sumCommittedStorageBytes, sumInitiatedIntentBytes } from "../services/db";
import { getAccountUsage, reconcileAccountUsage } from "../services/quota";
import { sweepExpiredUploadIntents, type UploadDeps } from "./storage";

/**
 * POST /api/maintenance/run.
 *
 * 1. Expire overdue upload intents with a larger cap than the opportunistic
 *    sweeps: release reservations and delete pending R2 objects.
 * 2. Reconcile account_usage against D1-derived truth: active_bytes from
 *    SUM(byte_length) of active+orphaned storage objects, reserved_bytes
 *    from intents still 'initiated'. Corrections are applied only for this
 *    D1-derived drift, behind a guard that skips the write if the counters
 *    moved concurrently.
 * 3. Discrepancies that would need a full R2 listing (objects in the bucket
 *    unknown to D1, or missing despite D1 records) are reported as unchecked,
 *    never guessed at or silently "fixed" (section 11.6).
 */
export async function runMaintenance(deps: UploadDeps): Promise<MaintenanceRunResponse> {
  const sweep = await sweepExpiredUploadIntents(deps, MAINTENANCE_SWEEP_LIMIT);

  const usage = await getAccountUsage(deps.db);
  const computedActiveBytes = await sumCommittedStorageBytes(deps.db);
  const computedReservedBytes = await sumInitiatedIntentBytes(deps.db);
  const activeBytesDrift = usage.activeBytes - computedActiveBytes;
  const reservedBytesDrift = usage.reservedBytes - computedReservedBytes;

  const notes: string[] = [
    "R2 was not listed: objects in the bucket unknown to D1, or missing " +
      "despite D1 records, are not detected by this run.",
  ];

  let corrected = false;
  if (activeBytesDrift !== 0 || reservedBytesDrift !== 0) {
    corrected = await reconcileAccountUsage(deps.db, usage, {
      activeBytes: computedActiveBytes,
      reservedBytes: computedReservedBytes,
    });
    if (!corrected) {
      notes.push(
        "Usage counters changed while reconciling; the reported drift was " +
          "not corrected this run. Run maintenance again.",
      );
    }
  }

  return {
    expiredIntents: sweep.expiredIntents,
    releasedBytes: sweep.releasedBytes,
    deletedObjects: sweep.deletedObjects,
    drift: {
      recordedActiveBytes: usage.activeBytes,
      computedActiveBytes,
      activeBytesDrift,
      recordedReservedBytes: usage.reservedBytes,
      computedReservedBytes,
      reservedBytesDrift,
    },
    corrected,
    notes,
  };
}
