import { PrimaryStore } from "../../../bridge/db/primary-store.ts";
import type { RunSummary } from "../../../shared/protocol.ts";

/**
 * A genuine, separate OS-process writer for the E9 AC5 concurrency stress test (see
 * ../concurrency-stress.test.ts). Each invocation opens its OWN connection to the SAME primary
 * store file and hammers it with writes — this is exactly "N parallel run workers + 1 headless
 * CLI process + the app writing concurrently" (AC5), just simulated via `label`/count rather
 * than literally being Podium Studio's future E15 orchestrator (which doesn't exist yet — see
 * my report for that scope note).
 *
 * argv: [dbPath, backupsDir, label, writeCount]
 * stdout: one JSON line { label, attempted, succeeded, errors: string[] }
 */

function bareSummary(runId: string): RunSummary {
  return {
    runId, flowName: "stress", udid: "u", bundleId: "b", passed: true, status: "passed",
    total: 0, passedCount: 0, failedCount: 0, softFailedCount: 0, durationMs: 0,
    startedAt: Date.now(), results: [],
  };
}

async function run() {
  const [, , dbPath, backupsDir, label, writeCountStr] = process.argv;
  const writeCount = Number(writeCountStr);
  const store = new PrimaryStore(dbPath, backupsDir);
  const errors: string[] = [];
  let succeeded = 0;

  try {
    store.open();
    for (let i = 0; i < writeCount; i++) {
      try {
        await store.insertRun(bareSummary(`${label}-${i}`));
        succeeded++;
      } catch (err: any) {
        errors.push(err?.message ?? String(err));
      }
    }
  } catch (err: any) {
    errors.push(`open() failed: ${err?.message ?? String(err)}`);
  } finally {
    try {
      store.close();
    } catch {
      /* best-effort */
    }
  }

  console.log(JSON.stringify({ label, attempted: writeCount, succeeded, errors }));
}

run();
