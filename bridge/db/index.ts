/** Barrel export for the E9 two-tier SQLite storage module. */
export { CACHE_DB_PATH, PRIMARY_DB_PATH, BACKUPS_DIR, BACKUP_RETENTION_COUNT, BUSY_TIMEOUT_MS, DATA_DIR } from "./constants.ts";
export { PrimaryStore, PrimaryStoreCorruptedError } from "./primary-store.ts";
export { DerivedCache, type FlowListingEntry } from "./derived-cache.ts";
export { planGc, runGc, type GcPlan, type GcOptions, type GcResult, type ArtifactRow } from "./gc.ts";
export { contentChecksum, rowCounts } from "./checksum.ts";
export { runMigrations, getSchemaVersion, PRIMARY_MIGRATIONS, CACHE_MIGRATIONS, type Migration } from "./schema.ts";
export { createSerializer, type WithLock } from "./serializer.ts";

import { CACHE_DB_PATH, PRIMARY_DB_PATH } from "./constants.ts";
import { DerivedCache } from "./derived-cache.ts";
import { PrimaryStore } from "./primary-store.ts";

/**
 * Process-wide singletons for the bridge server (bridge/server.ts), mirroring how
 * `bridge/podium.ts` exports one `engine` instance. Tests should NOT import these — they
 * construct their own `PrimaryStore`/`DerivedCache` instances pointed at temp paths so tests
 * never share state or fight over the real `data/` directory.
 */
export const primaryStore = new PrimaryStore(PRIMARY_DB_PATH);
export const derivedCache = new DerivedCache(CACHE_DB_PATH);

let opened = false;

/**
 * Idempotent: safe to call multiple times (e.g. once at server startup).
 *
 * E9 review-fix (D5): the two tiers are opened INDEPENDENTLY — a primary-store failure (e.g. an
 * unrecoverable `PrimaryStoreCorruptedError`) must never also skip opening the derived cache;
 * they have nothing to do with each other, and the cache is fully rebuildable/self-healing on
 * its own (see derived-cache.ts's D4 fix) regardless of what happened to the primary store. Any
 * primary-store error is still re-thrown afterward, unchanged from before, so existing callers
 * (bridge/server.ts logs it and continues) see the same behavior they always did.
 */
export function openStores(): void {
  if (opened) return;
  let primaryError: unknown;
  try {
    primaryStore.open();
  } catch (err) {
    primaryError = err;
  }
  derivedCache.open();
  opened = true;
  if (primaryError) throw primaryError;
}
