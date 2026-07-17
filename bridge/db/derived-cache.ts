import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Flow } from "../../shared/ir.ts";
import { BUSY_TIMEOUT_MS } from "./constants.ts";
import { CACHE_MIGRATIONS, runMigrations } from "./schema.ts";
import { createSerializer, type WithLock } from "./serializer.ts";

export interface FlowListingEntry {
  file: string;
  name: string;
  bundleId: string;
  steps: number;
}

/**
 * Tier 1 — the derived cache (E9). Search/tags/index over the canonical JSON flows in
 * `qa/flows/`. Fully rebuildable at any time via `rebuildFromFlows()` (E9 AC1) — deleting this
 * file and calling `open()` + `rebuildFromFlows()` again produces an identical, fully-functional
 * cache with zero loss to the flows themselves (they were never stored here — only derived
 * search text pointing back at them).
 */
export class DerivedCache {
  readonly path: string;
  private db!: DatabaseSync;
  private readonly lock: WithLock = createSerializer();

  constructor(path: string) {
    this.path = path;
  }

  open(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = this.tryOpenOrRecreate();
    runMigrations(this.db, CACHE_MIGRATIONS);
  }

  /**
   * Corruption self-heal (E9 review-fix, D4). Unlike the primary store (Tier 2, real data —
   * see primary-store.ts's quarantine-before-restore dance), this cache is Tier 1: FULLY
   * REBUILDABLE from the canonical JSON flows at any time (`rebuildFromFlows()`, spec AC1). A
   * corrupt cache file must never brick the whole app the way a corrupt PRIMARY store would —
   * so instead of a careful backup/restore, the whole point is that dropping it and starting
   * clean is always safe. `bridge/server.ts` already calls `rebuildFromFlows()` separately (on
   * demand / at startup), so an empty-but-healthy cache here is a fully recoverable, non-fatal
   * state, not data loss.
   */
  private tryOpenOrRecreate(): DatabaseSync {
    try {
      const db = new DatabaseSync(this.path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const rows = db.prepare("PRAGMA quick_check").all();
      const ok = rows.length === 1 && String(Object.values(rows[0])[0]).toLowerCase() === "ok";
      if (!ok) {
        db.close();
        throw new Error("derived cache failed quick_check");
      }
      return db;
    } catch {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(this.path + suffix, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      const db = new DatabaseSync(this.path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return db;
    }
  }

  close(): void {
    if (this.db?.isOpen) this.db.close();
  }

  isOpen(): boolean {
    return !!this.db?.isOpen;
  }

  /**
   * Fully rebuild the cache from the canonical JSON flows (E9 AC1). Safe to call any time,
   * including right after the cache DB file was deleted out from under a running process —
   * `open()` always (re)creates the schema, and this always starts from a clean slate
   * (`DELETE FROM flow_index`) rather than trying to diff against stale rows.
   */
  rebuildFromFlows(entries: Array<{ file: string; flow: Flow }>): Promise<void> {
    return this.lock(() => {
      this.db.exec("BEGIN");
      try {
        this.db.exec("DELETE FROM flow_index");
        const insert = this.db.prepare(
          `INSERT INTO flow_index (file, name, bundle_id, step_count, search_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        for (const { file, flow } of entries) {
          const searchText = [flow.name, flow.app.bundleId, ...flow.steps.map((s) => `${s.action} ${s.label ?? ""}`)]
            .join(" ")
            .toLowerCase();
          insert.run(file, flow.name, flow.app.bundleId, flow.steps.length, searchText, now);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /** Case-insensitive substring search over flow name / bundleId / step actions+labels. */
  search(query: string): FlowListingEntry[] {
    const needle = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare("SELECT file, name, bundle_id, step_count FROM flow_index WHERE search_text LIKE ? ORDER BY name")
      .all(needle);
    return rows.map((r) => ({ file: String(r.file), name: String(r.name), bundleId: String(r.bundle_id), steps: Number(r.step_count) }));
  }

  list(): FlowListingEntry[] {
    const rows = this.db.prepare("SELECT file, name, bundle_id, step_count FROM flow_index ORDER BY name").all();
    return rows.map((r) => ({ file: String(r.file), name: String(r.name), bundleId: String(r.bundle_id), steps: Number(r.step_count) }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM flow_index").get();
    return Number(row?.n ?? 0);
  }
}
