import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PrimaryStore, PrimaryStoreCorruptedError } from "../../../bridge/db/primary-store.ts";
import { contentChecksum, rowCounts } from "../../../bridge/db/checksum.ts";
import type { RunSummary } from "../../../shared/protocol.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

const PRIMARY_TABLES = ["runs", "run_results", "artifacts_index", "learning_store"];

function makeSummary(runId: string): RunSummary {
  return {
    runId,
    flowName: "Sample flow",
    udid: "udid-1",
    bundleId: "com.example.app",
    passed: true,
    status: "passed",
    total: 2,
    passedCount: 2,
    failedCount: 0,
    softFailedCount: 0,
    durationMs: 1234,
    startedAt: Date.now(),
    results: [
      { index: 0, stepId: "s1", action: "tap", status: "passed", ok: true, attempts: 1 },
      { index: 1, stepId: "s2", action: "screenshot", status: "passed", ok: true, attempts: 1, screenshot: "artifacts/r1/shot.png" },
    ],
  };
}

main(async (h) => {
  const dir = tempDir("podium-studio-primary-");
  try {
    // ── AC2: deleting the primary file with NO backup loses history for real ──────────────
    {
      const dbPath = `${dir}/ac2.sqlite`;
      const backupsDir = `${dir}/ac2-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      await store.insertRun(makeSummary("run-1"));
      h.equal("ac2-run-present-before-delete", store.countRuns(), 1);
      store.close();

      rmSync(dbPath, { force: true });
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });

      const reopened = new PrimaryStore(dbPath, backupsDir);
      reopened.open(); // fresh empty file, no corruption to detect
      h.equal("ac2-run-history-genuinely-gone", reopened.countRuns(), 0);
      h.equal("ac2-not-flagged-as-recovered", reopened.recoveredFromBackup, false);
      reopened.close();
    }

    // ── AC3: backup -> simulated loss -> restore -> identical counts + checksum ───────────
    {
      const dbPath = `${dir}/ac3.sqlite`;
      const backupsDir = `${dir}/ac3-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      for (let i = 0; i < 10; i++) {
        await store.insertRun(makeSummary(`run-${i}`));
        await store.insertArtifact({ path: `artifacts/run-${i}/shot.png`, runId: `run-${i}`, kind: "screenshot", sizeBytes: 1000 + i, createdAt: Date.now() });
      }
      const beforeCounts = rowCounts(store.raw, PRIMARY_TABLES);
      const beforeChecksum = contentChecksum(store.raw, PRIMARY_TABLES);
      h.equal("ac3-seeded-10-runs", beforeCounts.runs, 10);

      const backupPath = await store.backup();
      h.ok("ac3-backup-file-exists", existsSync(backupPath));

      writeFileSync(dbPath, Buffer.from("not a sqlite file at all"));
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });

      await store.restore(backupPath);

      const afterCounts = rowCounts(store.raw, PRIMARY_TABLES);
      const afterChecksum = contentChecksum(store.raw, PRIMARY_TABLES);
      h.equal("ac3-row-counts-identical", afterCounts, beforeCounts);
      h.equal("ac3-checksum-matches", afterChecksum, beforeChecksum);
      h.equal("ac3-runs-queryable-after-restore", store.countRuns(), 10);
      store.close();
    }

    // ── Checksum order-determinism (E9 review-fix, MAJOR) ─────────────────────────────────
    // run_results' PK is COMPOSITE (run_id, step_index) — many rows share the same run_id, so
    // ordering by column 1 alone (the old bug) leaves ties whose relative order isn't
    // guaranteed. Two databases holding the exact same logical rows for run "run-x", inserted
    // in OPPOSITE order, must still produce the SAME checksum — a correct content checksum is a
    // function of row VALUES, never of insertion order.
    {
      const storeA = new PrimaryStore(`${dir}/checksum-order-a.sqlite`, `${dir}/checksum-order-a-backups`);
      storeA.open();
      await storeA.insertRun({
        ...makeSummary("run-x"),
        results: [
          { index: 0, stepId: "s1", action: "tap", status: "passed", ok: true, attempts: 1 },
          { index: 1, stepId: "s2", action: "screenshot", status: "passed", ok: true, attempts: 1 },
          { index: 2, stepId: "s3", action: "type", status: "passed", ok: true, attempts: 1 },
        ],
      });
      const checksumA = contentChecksum(storeA.raw, ["run_results"]);
      storeA.close();

      const storeB = new PrimaryStore(`${dir}/checksum-order-b.sqlite`, `${dir}/checksum-order-b-backups`);
      storeB.open();
      // SAME run_id, SAME three rows, inserted in REVERSED order.
      await storeB.insertRun({
        ...makeSummary("run-x"),
        results: [
          { index: 2, stepId: "s3", action: "type", status: "passed", ok: true, attempts: 1 },
          { index: 1, stepId: "s2", action: "screenshot", status: "passed", ok: true, attempts: 1 },
          { index: 0, stepId: "s1", action: "tap", status: "passed", ok: true, attempts: 1 },
        ],
      });
      const checksumB = contentChecksum(storeB.raw, ["run_results"]);
      storeB.close();

      h.equal("checksum-order-independent", checksumA, checksumB);
    }

    // ── backup retention: prunes beyond the configured count ──────────────────────────────
    {
      const dbPath = `${dir}/retention.sqlite`;
      const backupsDir = `${dir}/retention-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      await store.insertRun(makeSummary("run-1"));
      for (let i = 0; i < 8; i++) {
        await store.backup();
        await new Promise((r) => setTimeout(r, 5));
      }
      h.ok("retention-prunes-old-backups", store.listBackups().length <= 5, `expected <=5, got ${store.listBackups().length}`);
      store.close();
    }

    // ── AC6: corruption detected on open, auto-recovers from latest backup ────────────────
    {
      const dbPath = `${dir}/ac6-recover.sqlite`;
      const backupsDir = `${dir}/ac6-recover-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      await store.insertRun(makeSummary("safe-run"));
      await store.backup();
      store.close();

      const size = statSync(dbPath).size;
      writeFileSync(dbPath, Buffer.alloc(Math.max(16, Math.floor(size / 3)), 0xff));

      const recovered = new PrimaryStore(dbPath, backupsDir);
      let openThrew = false;
      try {
        recovered.open();
      } catch {
        openThrew = true;
      }
      h.equal("ac6-open-does-not-crash", openThrew, false);
      h.equal("ac6-flagged-as-recovered", recovered.recoveredFromBackup, true);
      h.ok("ac6-pre-corruption-data-survived", recovered.getRun("safe-run"));
      recovered.close();
    }

    // ── Sensitive-at-rest: primary store + backup files are chmod 0600 (security MAJOR S3) ────
    {
      const dbPath = `${dir}/chmod.sqlite`;
      const backupsDir = `${dir}/chmod-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      h.equal("primary-file-chmod-0600", statSync(dbPath).mode & 0o777, 0o600);

      const backupPath = await store.backup();
      h.equal("backup-file-chmod-0600", statSync(backupPath).mode & 0o777, 0o600);
      store.close();
    }

    // ── Quarantine safety net (E9 review-fix, MAJOR: "auto-restore false-positive clobber") ──
    // Whenever open() falls through to an auto-restore, the PRE-restore bytes must be preserved
    // somewhere recoverable first — the corruption check can't perfectly distinguish genuine
    // corruption from a transient false positive, so a false-positive auto-restore must never be
    // a PERMANENT loss.
    {
      const dbPath = `${dir}/quarantine.sqlite`;
      const backupsDir = `${dir}/quarantine-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      await store.insertRun(makeSummary("safe-run"));
      await store.backup();
      store.close();

      const corruptBytes = Buffer.alloc(64, 0xee);
      writeFileSync(dbPath, corruptBytes);

      const recovered = new PrimaryStore(dbPath, backupsDir);
      recovered.open();
      h.equal("quarantine-recovered-flag", recovered.recoveredFromBackup, true);

      const quarantineDir = `${backupsDir}/quarantine`;
      h.ok("quarantine-dir-created", existsSync(quarantineDir));
      const quarantined = existsSync(quarantineDir) ? readdirSync(quarantineDir) : [];
      h.ok("quarantine-file-present", quarantined.length > 0);
      if (quarantined.length > 0) {
        const preserved = readFileSync(`${quarantineDir}/${quarantined[0]}`);
        h.equal("quarantine-bytes-match-pre-restore-file", preserved.equals(corruptBytes), true);
      }
      recovered.close();
    }

    // ── AC6: corruption with NO backup -> clear typed error, not a raw crash ──────────────
    {
      const dbPath = `${dir}/ac6-nobackup.sqlite`;
      const backupsDir = `${dir}/ac6-nobackup-backups`;
      writeFileSync(dbPath, Buffer.from("garbage, not a valid sqlite database file"));
      const store = new PrimaryStore(dbPath, backupsDir);
      h.throws("ac6-no-backup-throws-typed-error", () => store.open(), () => true);
      try {
        store.open();
      } catch (err) {
        h.equal("ac6-error-is-PrimaryStoreCorruptedError", err instanceof PrimaryStoreCorruptedError, true);
      }
    }

    // ── run history round-trips faithfully (row + every per-step result) ─────────────────
    {
      const dbPath = `${dir}/roundtrip.sqlite`;
      const backupsDir = `${dir}/roundtrip-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();
      const summary = makeSummary("run-full");
      await store.insertRun(summary);

      const run = store.getRun("run-full") as any;
      h.equal("run-row-fields", { run_id: run?.run_id, flow_name: run?.flow_name, passed: run?.passed, status: run?.status }, {
        run_id: "run-full", flow_name: "Sample flow", passed: 1, status: "passed",
      });

      const results = store.raw.prepare("SELECT * FROM run_results WHERE run_id = ? ORDER BY step_index").all("run-full") as any[];
      h.equal("run-results-count", results.length, 2);
      h.equal("run-results-step2-screenshot", results[1]?.screenshot, "artifacts/r1/shot.png");
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
