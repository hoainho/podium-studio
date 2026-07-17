import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned migration framework (E9 AC4: "a schema-version bump runs an automatic migration
 * that preserves 100% of pre-migration primary-store rows"). Each migration is additive by
 * default (new tables/columns) and runs inside its own transaction — if a migration's `up()`
 * throws, the transaction rolls back and `schema_meta.schema_version` is left unchanged, so a
 * failed migration never leaves the database in a half-migrated state.
 */
export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

function ensureSchemaMeta(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
}

export function getSchemaVersion(db: DatabaseSync): number {
  ensureSchemaMeta(db);
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

/** Apply every migration with version > the database's current schema_version, in order,
 * each in its own transaction. Returns the list of versions actually applied (empty if the
 * database was already current — the common case on every normal startup). */
export function runMigrations(db: DatabaseSync, migrations: Migration[]): number[] {
  ensureSchemaMeta(db);
  const current = getSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  const applied: number[] = [];
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      setSchemaVersion(db, m.version);
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration v${m.version} ("${m.description}") failed and was rolled back: ${(err as Error).message}`);
    }
  }
  return applied;
}

// ─── Tier 2 — primary store (NOT rebuildable) ─────────────────────────────────────────────────

export const PRIMARY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial primary-store schema: runs, run_results, artifacts_index, learning_store",
    up(db) {
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          flow_name TEXT NOT NULL,
          udid TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          passed INTEGER NOT NULL,
          status TEXT NOT NULL,
          total INTEGER NOT NULL,
          passed_count INTEGER NOT NULL,
          failed_count INTEGER NOT NULL,
          soft_failed_count INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE run_results (
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          step_index INTEGER NOT NULL,
          step_id TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          ok INTEGER NOT NULL,
          detail TEXT,
          error TEXT,
          backend TEXT,
          screenshot TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          attempts INTEGER,
          PRIMARY KEY (run_id, step_index)
        ) STRICT;

        CREATE TABLE artifacts_index (
          path TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          kind TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        -- Learning-store schema placeholder: E9's scope is reserving the primary-store table so
        -- the tier boundary is settled now; the actual heal/lesson content and logic is E19's job
        -- (out of scope here, per this epic's own "Out" list).
        CREATE TABLE learning_store (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    description: "E19 learning store: lessons, selector_memory, interstitial_catalog, heal_outcomes",
    up(db) {
      // v1's generic `learning_store` (id/kind/JSON-payload) placeholder is superseded by these
      // structured, indexed tables — proper relational tables are what rungs 1–3's lookups
      // actually need (fingerprint / error-class keyed queries, ranking by success count), not a
      // single blob table requiring JSON-parse-per-row. Migrations are additive-only (schema.ts's
      // own contract), so `learning_store` is left in place, unused, rather than dropped.
      db.exec(`
        -- One row per observed failure (Pillar 9 §3 "lesson record"). "pinned" is the Strict-mode
        -- gate (E19 AC6): rungs 1–3 may only replay a lesson where pinned = 1 — an unpinned
        -- candidate must never auto-apply, in Strict OR (per this epic's scope) at all, since
        -- Adaptive's "replay not-yet-pinned" behavior is explicitly deferred to E24.
        CREATE TABLE lessons (
          id TEXT PRIMARY KEY,
          screen_fingerprint TEXT NOT NULL,
          error_class TEXT NOT NULL,
          step_intent TEXT NOT NULL,
          heal_type TEXT NOT NULL, -- 'locator' | 'assertion' | 'interstitial' | 'other'
          rung INTEGER, -- which rung produced the recovery (1|2|3), NULL if never recovered
          recovery_json TEXT, -- the recovery action, if any (NULL = "recorded, unresolved")
          top_labels_json TEXT NOT NULL, -- on-screen labels at failure time (context, not a locator)
          screenshot_path TEXT,
          app_version TEXT,
          flow_id TEXT,
          pinned INTEGER NOT NULL DEFAULT 0, -- 0/1 — the Strict-replay gate (AC6)
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_lessons_fingerprint_error ON lessons (screen_fingerprint, error_class);

        -- Every stable locator ever observed for one logical element on one screen (rung 1's
        -- re-resolution source). Multiple rows per (screen, element) as different locator kinds
        -- are observed/confirmed over time; times_resolved ranks which kind is most reliable.
        CREATE TABLE selector_memory (
          id TEXT PRIMARY KEY,
          screen_fingerprint TEXT NOT NULL,
          element_key TEXT NOT NULL, -- a stable label the QA/author would recognize (e.g. original text)
          locator_kind TEXT NOT NULL, -- 'targetId' | 'text' | 'role' | 'nearbyLabel' | 'position'
          locator_value TEXT NOT NULL,
          times_resolved INTEGER NOT NULL DEFAULT 0,
          last_resolved_at INTEGER,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_selector_memory_screen_element ON selector_memory (screen_fingerprint, element_key);

        -- Known popups/dialogs + the dismiss action that worked (rung 2's source).
        CREATE TABLE interstitial_catalog (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          dismiss_action_json TEXT NOT NULL,
          times_seen INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER,
          created_at INTEGER NOT NULL
        ) STRICT;

        -- Aggregated (screen, error-class) -> which rung/strategy succeeds, and how often (rung
        -- 3's ranking source — "try the most-likely fix first").
        CREATE TABLE heal_outcomes (
          id TEXT PRIMARY KEY,
          screen_fingerprint TEXT NOT NULL,
          error_class TEXT NOT NULL,
          rung INTEGER NOT NULL,
          strategy TEXT NOT NULL,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_heal_outcomes_screen_error ON heal_outcomes (screen_fingerprint, error_class);
      `);
    },
  },
  {
    version: 3,
    description: "E24: ai_providers (registry rows), ai_routing (per-role fallback chain), ai_call_log (rung-4/co-pilot audit trail)",
    up(db) {
      db.exec(`
        -- One row per configured provider (Pillar 9 §5.2's "provider registry... a config row,
        -- not a code change"). NEVER stores a resolved API key — api_key_ref is always an
        -- unresolved "env:NAME"/"keychain:service" reference (bridge/ai-key-resolver.ts resolves
        -- it at call time, never at rest).
        CREATE TABLE ai_providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL, -- 'openai-compatible' | 'agent-cli'
          base_url TEXT,      -- openai-compatible only
          model TEXT,         -- openai-compatible only
          command TEXT,       -- agent-cli only
          args_json TEXT,     -- agent-cli only
          api_key_ref TEXT,   -- "env:NAME" | "keychain:service" | NULL (no key needed)
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        ) STRICT;

        -- Exactly 2 rows ("authoring", "recovery") — the ordered fallback chain per role
        -- (free/local-first). bridge/ai-registry.ts's validateProviderRegistry is the ONLY gate
        -- that may write an agent-cli provider id into the "recovery" row's chain — it never is,
        -- by construction (AC5).
        CREATE TABLE ai_routing (
          role TEXT PRIMARY KEY, -- 'authoring' | 'recovery'
          provider_ids_json TEXT NOT NULL
        ) STRICT;

        -- Every rung-4/co-pilot AI call, logged regardless of outcome (AC3: "every rung-4 heal is
        -- logged locally"). Sensitive-at-rest (Pillar 9 §5.4/spec AC9: this can contain real
        -- logged-in screen content) — mitigated the SAME way the rest of the primary store already
        -- is (0600 file permission on primary.sqlite, E9/E12 review fix), plus a dedicated purge
        -- endpoint (bridge/db/primary-store.ts's purgeAiCallLog) for the "opt-in + purgeable" plan
        -- option, rather than a new, separate encryption mechanism for one table.
        CREATE TABLE ai_call_log (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL, -- 'authoring' | 'recovery'
          provider_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          response TEXT NOT NULL,
          tokens_used INTEGER,
          cost_usd REAL,
          latency_ms INTEGER NOT NULL,
          screen_fingerprint TEXT, -- present for a recovery call, absent for authoring (no single screen)
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_ai_call_log_created_at ON ai_call_log (created_at);
      `);
    },
  },
];

// ─── Tier 1 — derived cache (fully rebuildable from qa/flows/*.flow.json) ─────────────────────

export const CACHE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial derived-cache schema: flow_index (search/tags/index over flows)",
    up(db) {
      db.exec(`
        CREATE TABLE flow_index (
          file TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          step_count INTEGER NOT NULL,
          search_text TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
];
