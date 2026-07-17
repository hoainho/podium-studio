import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { PrimaryStore } from "../../../bridge/db/primary-store.ts";
import { planGc, runGc } from "../../../bridge/db/gc.ts";
import type { RunSummary } from "../../../shared/protocol.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

function bareSummary(runId: string): RunSummary {
  return {
    runId, flowName: "f", udid: "u", bundleId: "b", passed: true, status: "passed",
    total: 0, passedCount: 0, failedCount: 0, softFailedCount: 0, durationMs: 0,
    startedAt: Date.now(), results: [],
  };
}

async function seedArtifacts(store: PrimaryStore, artifactsDir: string, count: number, sizeBytes: number) {
  for (let i = 0; i < count; i++) {
    const runId = `run-${i}`;
    await store.insertRun(bareSummary(runId));
    const path = `${artifactsDir}/${runId}.png`;
    writeFileSync(path, Buffer.alloc(sizeBytes, 1));
    await store.insertArtifact({ path, runId, kind: "screenshot", sizeBytes, createdAt: 1000 + i }); // strictly increasing => oldest-first
  }
}

main(async (h) => {
  const dir = tempDir("podium-studio-gc-");
  try {
    // ── planGc: read-only, empty plan when under quota ────────────────────────────────────
    {
      const artifactsDir = `${dir}/artifacts-a`;
      mkdirSync(artifactsDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/a.sqlite`, `${dir}/a-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 3, 100);
      const plan = planGc(store, 10_000);
      h.equal("under-quota-overBy-zero", plan.overBy, 0);
      h.equal("under-quota-no-candidates", plan.candidates, []);
      store.close();
    }

    // ── planGc: selects oldest-first, only as many as needed ─────────────────────────────
    {
      const artifactsDir = `${dir}/artifacts-b`;
      mkdirSync(artifactsDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/b.sqlite`, `${dir}/b-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 5, 100); // 500 bytes total
      const plan = planGc(store, 250);
      h.equal("plan-total-bytes", plan.totalBytes, 500);
      h.equal("plan-overBy", plan.overBy, 250);
      h.equal("plan-oldest-first-candidates", plan.candidates.map((c) => c.runId), ["run-0", "run-1", "run-2"]);
      store.close();
    }

    // ── runGc: refuses to delete without exportDir or force ───────────────────────────────
    {
      const artifactsDir = `${dir}/artifacts-c`;
      mkdirSync(artifactsDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/c.sqlite`, `${dir}/c-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 3, 100);
      const plan = planGc(store, 100);
      h.ok("refuse-plan-has-candidates", plan.candidates.length > 0);
      await h.throwsAsync("refuses-without-export-or-force", () => runGc(store, plan), (m) => m.includes("export-before-delete"));
      const stillThere = plan.candidates.every((c) => existsSync(c.path));
      h.equal("refuse-nothing-touched", stillThere, true);
      store.close();
    }

    // ── runGc: exports before deleting, quota restored ────────────────────────────────────
    {
      const artifactsDir = `${dir}/artifacts-d`;
      const exportDir = `${dir}/exported-d`;
      mkdirSync(artifactsDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/d.sqlite`, `${dir}/d-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 5, 100);
      const plan = planGc(store, 250);
      const result = await runGc(store, plan, { exportDir });

      h.equal("export-pruned-count", result.prunedCount, 3);
      h.equal("export-freed-bytes", result.freedBytes, 300);
      h.equal("export-dir-contents", readdirSync(exportDir).sort(), ["run-0.png", "run-1.png", "run-2.png"]);
      h.equal("originals-deleted", plan.candidates.every((c) => !existsSync(c.path)), true);
      const after = planGc(store, 250);
      h.equal("quota-restored", after.overBy, 0);
      store.close();
    }

    // ── runGc: force:true skips export, still prunes ──────────────────────────────────────
    {
      const artifactsDir = `${dir}/artifacts-e`;
      const exportDir = `${dir}/exported-e`;
      mkdirSync(artifactsDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/e.sqlite`, `${dir}/e-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 3, 100);
      const plan = planGc(store, 100);
      const result = await runGc(store, plan, { force: true });

      h.ok("force-pruned-something", result.prunedCount > 0);
      h.equal("force-no-exports", result.exportedPaths, []);
      h.equal("force-no-export-dir-created", existsSync(exportDir), false);
      store.close();
    }

    // ── runGc: a failed export must NOT be followed by delete (E9 review-fix, MAJOR) ───────
    // Make exportDir read-only so copyFileSync fails for every candidate — the old code
    // swallowed that failure and pruned anyway ("export is best-effort"); the fix must leave
    // every one of these files and index rows untouched, and report them in failedExports.
    {
      const artifactsDir = `${dir}/artifacts-f`;
      const exportDir = `${dir}/exported-f`;
      mkdirSync(artifactsDir, { recursive: true });
      mkdirSync(exportDir, { recursive: true });
      const store = new PrimaryStore(`${dir}/f.sqlite`, `${dir}/f-backups`);
      store.open();
      await seedArtifacts(store, artifactsDir, 3, 100);
      const plan = planGc(store, 100);
      h.ok("failed-export-plan-has-candidates", plan.candidates.length > 0);

      chmodSync(exportDir, 0o555); // read-only: every copyFileSync into it will fail
      try {
        const result = await runGc(store, plan, { exportDir });
        h.equal("failed-export-nothing-deleted", plan.candidates.every((c) => existsSync(c.path)), true);
        h.equal("failed-export-all-reported", result.failedExports.length, plan.candidates.length);
        h.equal("failed-export-pruned-count-zero", result.prunedCount, 0);
        h.equal("failed-export-freed-bytes-zero", result.freedBytes, 0);
      } finally {
        chmodSync(exportDir, 0o755); // restore so cleanupDir() can remove the temp dir
      }
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
