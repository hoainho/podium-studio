import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * A deterministic content checksum over a set of tables, for E9 AC3 ("backup, simulated
 * loss/corruption, restore, yields identical row counts and a MATCHING CONTENT CHECKSUM to the
 * pre-loss state"). Dumps every row of every named table and hashes the canonical JSON — this
 * catches content drift that a bare row-count comparison would miss.
 *
 * E9 review-fix (MAJOR — order-determinism): this used to `ORDER BY 1` (the first column) only,
 * on the assumption every table's first column is its unique row-identity key. That's true for
 * `runs`/`artifacts_index`/`learning_store` (single-column PK), but `run_results`' PK is the
 * COMPOSITE `(run_id, step_index)` — many rows share the same `run_id`, so ordering by column 1
 * alone leaves ties whose relative order SQLite doesn't guarantee across two otherwise-identical
 * databases (e.g. one physically compacted by a page-level `backup()` copy vs. the live file) —
 * two databases with byte-identical CONTENT could hash differently, or worse, two databases with
 * DIFFERENT content could tie-break into the same order and hash the same. Ordering by EVERY
 * column (in table-definition order) makes the row order a total order over the actual row
 * values themselves, so the hash is a true function of content, never of physical/insertion order.
 */
export function contentChecksum(db: DatabaseSync, tables: string[]): string {
  const hash = createHash("sha256");
  for (const table of tables) {
    const columnCount = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length;
    const orderBy = Array.from({ length: columnCount }, (_, i) => i + 1).join(", ");
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    hash.update(table);
    hash.update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}

/** Row counts per table, for the row-count-equality half of AC3/AC4. */
export function rowCounts(db: DatabaseSync, tables: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get();
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}
