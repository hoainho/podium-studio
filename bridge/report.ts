import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Flow } from "../shared/ir.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { buildTrace, traceToJson, type Trace } from "../shared/trace.ts";
import { ARTIFACTS_DIR } from "./runner.ts";

/**
 * E18 AC4 — janus-specs/R3-reuse-browser/E18-tags-trace.md: "trace data is exported as an
 * artifact ALONGSIDE the existing JUnit XML/HTML report on every run (present in the same
 * artifacts directory, referenced from the HTML report)."
 *
 * `shared/trace.ts`'s own `buildTrace`/`traceToJson` (E18) are a pure, framework-free derivation
 * with no bridge/server.ts wiring of their own. Reused here VERBATIM (not reimplemented): this
 * file only adds the FILE-WRITING half (into the run's own artifacts dir, alongside its
 * screenshots) plus a minimal HTML report to link it from — a grep across this codebase found no
 * JUnit-XML/HTML report generator anywhere before this change, so this genuinely IS that
 * generator's first version, kept deliberately small (a static run-summary + step table + a link
 * to trace.json), not a general reporting subsystem.
 *
 * (Previously imported from `../src/trace.ts` — a backend→frontend-directory import — moved to
 * shared/trace.ts in a follow-up cleanup; src/trace.ts is now just a re-export shim so every
 * existing src/ import site keeps working unchanged.)
 */
export async function writeRunReport(flow: Flow, summary: RunSummary): Promise<{ dir: string; tracePath: string; reportPath: string }> {
  const dir = join(ARTIFACTS_DIR, summary.runId);
  await mkdir(dir, { recursive: true });

  const trace = buildTrace(flow, summary);
  const tracePath = join(dir, "trace.json");
  await writeFile(tracePath, traceToJson(trace), "utf8");

  const reportPath = join(dir, "report.html");
  await writeFile(reportPath, renderReportHtml(summary, trace), "utf8");

  return { dir, tracePath, reportPath };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderReportHtml(summary: RunSummary, trace: Trace): string {
  const rows = trace.steps
    .map(
      (s) =>
        `<tr class="s-${esc(s.status)}"><td>${s.index}</td><td>${esc(s.action)}</td><td>${esc(s.label)}</td>` +
        `<td>${esc(s.status)}</td><td>${s.durationMs ?? ""}</td><td>${esc(s.error ?? s.detail ?? "")}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(summary.flowName)} — ${esc(summary.runId)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: 14px; }
  .s-passed { background: #eaffea; }
  .s-failed { background: #ffecec; }
  .s-failed-soft { background: #fff6e0; }
  .s-skipped { color: #888; }
</style>
</head>
<body>
  <h1>${esc(summary.flowName)}</h1>
  <p>Run <code>${esc(summary.runId)}</code> — <strong>${summary.passed ? "PASSED" : "FAILED"}</strong>
     (${summary.passedCount}/${summary.total} steps passed, ${summary.softFailedCount} soft-failed) in ${summary.durationMs}ms</p>
  <p><a href="trace.json">trace.json</a> — full step-by-step trace (time-travel viewer data, E18 AC2/AC4)</p>
  <table>
    <thead><tr><th>#</th><th>Action</th><th>Step</th><th>Status</th><th>ms</th><th>Detail/Error</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}
