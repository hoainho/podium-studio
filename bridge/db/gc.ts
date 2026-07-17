import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { PrimaryStore } from "./primary-store.ts";

/**
 * Retention / GC policy over the artifacts directory (E9 AC7). Reads the primary store's
 * `artifacts_index` (Tier 2 — see primary-store.ts) as the source of truth for what exists and
 * how old it is, rather than re-scanning the filesystem, so pruning decisions are consistent
 * with the same row-level bookkeeping the rest of the primary store uses.
 */

export interface ArtifactRow {
  path: string;
  runId: string;
  kind: string;
  sizeBytes: number;
  createdAt: number;
}

export interface GcPlan {
  totalBytes: number;
  quotaBytes: number;
  /** How far over quota the directory currently is (0 if under quota). */
  overBy: number;
  /** Oldest-first artifacts that would be pruned to bring the directory back under quota. */
  candidates: ArtifactRow[];
}

/** Read-only: compute which artifacts WOULD be pruned (oldest-first) to bring the artifact
 * directory back under quota. Touches nothing — safe to call at any time to check status. */
export function planGc(store: PrimaryStore, quotaBytes: number): GcPlan {
  const all = store.listArtifacts(); // already ordered oldest-first (created_at ASC)
  const totalBytes = all.reduce((sum, a) => sum + a.sizeBytes, 0);
  const overBy = Math.max(0, totalBytes - quotaBytes);
  if (overBy === 0) return { totalBytes, quotaBytes, overBy: 0, candidates: [] };

  const candidates: ArtifactRow[] = [];
  let freed = 0;
  for (const a of all) {
    if (freed >= overBy) break;
    candidates.push(a);
    freed += a.sizeBytes;
  }
  return { totalBytes, quotaBytes, overBy, candidates };
}

export interface GcOptions {
  /** Copy each pruned artifact here before deleting it (the "export" in export-before-delete). */
  exportDir?: string;
  /** Explicitly skip the export step because the caller already offered it and the user
   * declined. Required when `exportDir` isn't given and the plan is non-empty. */
  force?: boolean;
}

export interface GcResult {
  /** How many artifacts were actually deleted (excludes anything in `failedExports`). */
  prunedCount: number;
  freedBytes: number;
  exportedPaths: string[];
  /** Artifacts whose export copy FAILED and were therefore intentionally left in place — never
   * deleted (E9 review-fix, MAJOR: "export-fail-then-delete"). The caller must surface these so
   * a QA who asked for export-before-delete never discovers, only after the fact, that some
   * "exported" artifacts were actually just deleted with no copy ever made. */
  failedExports: string[];
}

/**
 * Execute a GC plan: for each candidate, optionally export (copy) it, then delete the file and
 * its `artifacts_index` row. NEVER deletes anything without either `exportDir` or an explicit
 * `force: true` — AC7's "oldest artifacts are pruned only after an export-before-delete option
 * is offered" is enforced HERE, in the function's own contract, not left for a UI to remember to
 * ask.
 *
 * E9 review-fix (MAJOR): when `exportDir` IS given but the copy for a specific artifact fails
 * (disk full, permission error, ...), that artifact is now SKIPPED rather than still deleted —
 * the old code caught the copy failure, discarded it, and fell through to delete anyway ("export
 * is best-effort; still proceed to prune... so quota is genuinely enforced"), which meant a
 * failed export silently became a real, uncopied, unrecoverable deletion. Enforcing the quota is
 * not worth losing data the caller explicitly asked to preserve first.
 */
export async function runGc(store: PrimaryStore, plan: GcPlan, opts: GcOptions = {}): Promise<GcResult> {
  if (plan.candidates.length > 0 && !opts.exportDir && !opts.force) {
    throw new Error(
      "runGc refuses to delete artifacts without an export-before-delete option: pass `exportDir` " +
        "to auto-export pruned artifacts first, or `force: true` if the caller already offered " +
        "export and the user declined (E9 AC7).",
    );
  }
  if (opts.exportDir) mkdirSync(opts.exportDir, { recursive: true });

  const exportedPaths: string[] = [];
  const failedExports: string[] = [];
  let prunedCount = 0;
  let freedBytes = 0;
  for (const a of plan.candidates) {
    if (opts.exportDir) {
      const dest = join(opts.exportDir, basename(a.path));
      let exportOk = true;
      try {
        if (existsSync(a.path)) {
          copyFileSync(a.path, dest);
          exportedPaths.push(dest);
        }
      } catch {
        exportOk = false;
      }
      if (!exportOk) {
        failedExports.push(a.path);
        continue; // never delete something we couldn't actually preserve first
      }
    }
    try {
      rmSync(a.path, { force: true });
    } catch {
      /* file may already be gone */
    }
    await store.deleteArtifact(a.path);
    prunedCount += 1;
    freedBytes += a.sizeBytes;
  }
  return { prunedCount, freedBytes, exportedPaths, failedExports };
}
