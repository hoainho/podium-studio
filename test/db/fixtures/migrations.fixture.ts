import { DatabaseSync } from "node:sqlite";
import { runMigrations, getSchemaVersion, PRIMARY_MIGRATIONS, CACHE_MIGRATIONS, type Migration } from "../../../bridge/db/schema.ts";
import { rowCounts } from "../../../bridge/db/checksum.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

main((h) => {
  const dir = tempDir("podium-studio-migrations-");
  try {
    // ── applies in order + resulting schema_version ──────────────────────────────────────
    {
      const db = new DatabaseSync(`${dir}/a.sqlite`);
      const migrations: Migration[] = [
        { version: 1, description: "create widgets", up: (d) => d.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT) STRICT") },
        { version: 2, description: "add color column", up: (d) => d.exec("ALTER TABLE widgets ADD COLUMN color TEXT") },
      ];
      const applied = runMigrations(db, migrations);
      h.equal("applies-in-order", applied, [1, 2]);
      h.equal("schema-version-after-apply", getSchemaVersion(db), 2);
      db.prepare("INSERT INTO widgets (id, name, color) VALUES (1, 'gear', 'red')").run();
      h.equal("v2-column-usable", db.prepare("SELECT name, color FROM widgets WHERE id = 1").get(), { name: "gear", color: "red" });
      db.close();
    }

    // ── idempotent re-run ─────────────────────────────────────────────────────────────────
    {
      const db = new DatabaseSync(`${dir}/b.sqlite`);
      const migrations: Migration[] = [{ version: 1, description: "init", up: (d) => d.exec("CREATE TABLE t (x INTEGER) STRICT") }];
      h.equal("first-run-applies", runMigrations(db, migrations), [1]);
      h.equal("second-run-applies-nothing", runMigrations(db, migrations), []);
      h.equal("schema-version-stable", getSchemaVersion(db), 1);
      db.close();
    }

    // ── AC4 core claim: 100% row preservation across a schema bump ──────────────────────
    {
      const db = new DatabaseSync(`${dir}/c.sqlite`);
      const v1: Migration[] = [{ version: 1, description: "init widgets", up: (d) => d.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT) STRICT") }];
      runMigrations(db, v1);
      const insert = db.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)");
      for (let i = 1; i <= 50; i++) insert.run(i, `widget-${i}`);
      const beforeCounts = rowCounts(db, ["widgets"]);
      const beforeSpot = db.prepare("SELECT id, name FROM widgets WHERE id = 25").get();

      const v2: Migration[] = [...v1, { version: 2, description: "add nullable priority", up: (d) => d.exec("ALTER TABLE widgets ADD COLUMN priority INTEGER") }];
      const applied = runMigrations(db, v2);
      h.equal("v2-only-new-migration-applied", applied, [2]);
      h.equal("row-count-preserved", rowCounts(db, ["widgets"]), beforeCounts);
      h.equal("spot-check-content-unchanged", db.prepare("SELECT id, name FROM widgets WHERE id = 25").get(), beforeSpot);
      db.close();
    }

    // ── rollback on a broken migration ────────────────────────────────────────────────────
    {
      const db = new DatabaseSync(`${dir}/d.sqlite`);
      const step1: Migration = { version: 1, description: "init", up: (d) => d.exec("CREATE TABLE t (x INTEGER) STRICT") };
      const step2Broken: Migration = {
        version: 2,
        description: "broken migration",
        up: (d) => {
          d.exec("CREATE TABLE t2 (y INTEGER) STRICT");
          throw new Error("simulated migration bug");
        },
      };
      runMigrations(db, [step1]);
      h.throws("broken-migration-throws", () => runMigrations(db, [step1, step2Broken]), (m) => m.includes("simulated migration bug"));
      h.equal("schema-version-not-advanced", getSchemaVersion(db), 1);
      h.throws("rolled-back-ddl-not-committed", () => db.prepare("SELECT * FROM t2").all());
      db.close();
    }

    // ── E19 code-review MINOR: the v1->v2 upgrade preserves REAL pre-existing runs/run_results
    // rows, not just a synthetic `widgets` table — this is the actual production shape (E9 AC4
    // applied to the exact tables a real user's primary store would already have data in before
    // updating to the build that ships E19's schema bump) ───────────────────────────────────
    {
      const db = new DatabaseSync(`${dir}/upgrade.sqlite`);
      const v1Only = PRIMARY_MIGRATIONS.filter((m) => m.version === 1);
      runMigrations(db, v1Only);
      h.equal("upgrade-v1-schema-version", getSchemaVersion(db), 1);

      const now = Date.now();
      db.prepare(
        `INSERT INTO runs (run_id, flow_name, udid, bundle_id, passed, status, total, passed_count,
           failed_count, soft_failed_count, duration_ms, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("run-1", "Login Flow", "udid-1", "com.example.app", 1, "passed", 3, 3, 0, 0, 1200, now, now);
      db.prepare(
        `INSERT INTO run_results (run_id, step_index, step_id, action, status, ok, detail, error,
           backend, screenshot, started_at, finished_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("run-1", 0, "s1", "tapText", "passed", 1, "tapped", null, "native", null, now, now + 100, 1);

      const beforeRun = db.prepare("SELECT * FROM runs WHERE run_id = 'run-1'").get();
      const beforeResults = db.prepare("SELECT * FROM run_results WHERE run_id = 'run-1'").all();

      // v1 already applied -> every version AFTER it runs (computed from PRIMARY_MIGRATIONS
      // itself, not hardcoded, so this test doesn't need updating every time a new migration is
      // added — E24's v3 already broke a hardcoded "[2]"/"2" expectation here once).
      const expectedRemaining = PRIMARY_MIGRATIONS.map((m) => m.version).filter((v) => v > 1);
      const applied = runMigrations(db, PRIMARY_MIGRATIONS);
      h.equal("upgrade-only-new-migrations-applied", applied, expectedRemaining);
      h.equal("upgrade-schema-version-after", getSchemaVersion(db), Math.max(...PRIMARY_MIGRATIONS.map((m) => m.version)));
      h.equal("upgrade-runs-row-preserved", db.prepare("SELECT * FROM runs WHERE run_id = 'run-1'").get(), beforeRun);
      h.equal("upgrade-run_results-rows-preserved", db.prepare("SELECT * FROM run_results WHERE run_id = 'run-1'").all(), beforeResults);
      h.equal("upgrade-runs-row-count", rowCounts(db, ["runs"]).runs, 1);
      h.equal("upgrade-run_results-row-count", rowCounts(db, ["run_results"]).run_results, 1);
      db.close();
    }

    // ── real shipped schemas apply cleanly ────────────────────────────────────────────────
    {
      const db = new DatabaseSync(`${dir}/primary.sqlite`);
      runMigrations(db, PRIMARY_MIGRATIONS);
      // v2 (E19 learning store) bumped this from 1 to 2, v3 (E24 AI provider registry) to 3 —
      // legitimate schema-version bumps this migration framework was built to support, not a
      // regression of E9's own test.
      h.equal("primary-schema-version", getSchemaVersion(db), 3);
      for (const table of [
        "runs", "run_results", "artifacts_index", "learning_store",
        "lessons", "selector_memory", "interstitial_catalog", "heal_outcomes",
        "ai_providers", "ai_routing", "ai_call_log",
      ]) {
        h.equal(`primary-table-${table}-empty`, rowCounts(db, [table])[table], 0);
      }
      db.close();
    }
    {
      const db = new DatabaseSync(`${dir}/cache.sqlite`);
      runMigrations(db, CACHE_MIGRATIONS);
      h.equal("cache-schema-version", getSchemaVersion(db), 1);
      h.equal("cache-table-flow_index-empty", rowCounts(db, ["flow_index"]).flow_index, 0);
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
