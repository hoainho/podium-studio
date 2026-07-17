import { join } from "node:path";
import { workspaceRoot } from "../workspace.ts";

/**
 * E9 — SQLite two-tier storage (janus-specs/R2-desktop-android/E9-sqlite-two-tier.md).
 *
 * Two explicit, physically separate SQLite files enforce the derived-cache vs primary-store
 * line IN CODE, not just in docs (per the epic's mandatory review-gate requirement): deleting
 * `cache.sqlite` is always safe (rebuildable from the canonical JSON flows in `qa/flows/`);
 * deleting `primary.sqlite` loses real data (run history, JUnit-shaped results, artifacts
 * index) unless restored from a backup. No code path in this module ever treats the primary
 * store as regenerable, and no code path ever treats the cache as needing a backup.
 */

export const DATA_DIR = process.env.PODIUM_STUDIO_DATA_DIR ?? join(workspaceRoot(), "data");

/** Tier 1 — derived cache: search/tags/index over flows. Fully rebuildable; never backed up. */
export const CACHE_DB_PATH = join(DATA_DIR, "cache.sqlite");

/** Tier 2 — primary store: run history, JUnit-shaped results, artifacts index, learning-store
 * placeholder. NOT rebuildable — requires backup/restore. */
export const PRIMARY_DB_PATH = join(DATA_DIR, "primary.sqlite");

export const BACKUPS_DIR = join(DATA_DIR, "backups");

/** How many primary-store backups to retain (oldest pruned beyond this count). */
export const BACKUP_RETENTION_COUNT = 5;

/** SQLite busy-timeout (ms): how long a connection waits for another writer's lock before
 * giving up, rather than failing immediately with SQLITE_BUSY (E9 AC5). Generous because the
 * write-serializer (serializer.ts) already minimizes real contention within one process; this
 * timeout is the safety net for the remaining CROSS-process contention (N workers + CLI + app
 * each holding their own connection to the same file). */
export const BUSY_TIMEOUT_MS = 5000;
