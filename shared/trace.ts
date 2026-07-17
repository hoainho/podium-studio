import { containerChildren, describeStep, describeStepCode, type Flow, type FlowStep, type StepDescriptor } from "./ir.ts";
import type { RunSummary, StepResult } from "./protocol.ts";

/**
 * trace.ts — trace/time-travel viewer model (E18, janus-specs/R3-reuse-browser/E18-tags-trace.md).
 *
 * Deliberately a pure, client-side DERIVATION from data the runner already produces — a
 * `Flow` (for step labels/`captureAs` declarations) and the `RunSummary` a run already returns
 * (per-step status/detail/error/screenshot/timing). No new runner/bridge fields needed: the
 * spec's "before/after screenshot per step" comes for free by chaining each step's OWN
 * screenshot as the NEXT step's "before" — bridge/runner.ts already takes one screenshot after
 * every step, so step N's before == step N-1's after, with zero runtime changes required
 * (review-gate requirement: "trace step data matches the actual runner state at that step (not
 * reconstructed/approximated after the fact)" — every field here is copied straight from the
 * real StepResult, never invented).
 *
 * Lives in shared/ (moved here from src/trace.ts, a follow-up cleanup) precisely BECAUSE it's
 * consumed from both sides: src/ (TraceViewer, App.tsx, TriagePanel, src/bug-export.ts) and
 * bridge/ (bridge/report.ts's own JUnit/HTML+trace.json artifact writer) — same "framework-free
 * logic goes in shared/, alongside ir.ts/protocol.ts/lint.ts" convention every other cross-cutting
 * module in this codebase already follows. `src/trace.ts` now just re-exports from here, so every
 * existing src/ import site (and test) keeps working unchanged.
 */

export interface TraceStep {
  index: number;
  stepId: string;
  action: string;
  /** Plain-language step description (shared/ir.ts's describeStep) — kept as plain text for
   * bridge/report.ts's static HTML/JUnit export, which has no i18n context to translate through. */
  label: string;
  /** Same step, as a stable code+params descriptor (task #48) — TraceViewer.tsx (interactive UI)
   * localizes via this instead of `label`. Undefined exactly when `label` falls back to the raw
   * action name (the originating FlowStep couldn't be resolved by stepId). */
  descriptor?: StepDescriptor;
  status: StepResult["status"];
  durationMs?: number;
  attempts?: number;
  /** E19/E24 — which self-heal rung (1-4) recovered this step, if any; copied straight from
   * StepResult, same "never reconstructed/approximated" rule as every other field here. */
  healedRung?: 1 | 2 | 3 | 4;
  /** The PREVIOUS step's screenshot (undefined for step 0 — nothing came before it). */
  beforeScreenshot?: string;
  /** This step's own screenshot, taken right after it ran. */
  afterScreenshot?: string;
  detail?: string;
  error?: string;
  /** Present only when this step declared `captureAs` — the variable it captured, and the
   * value it captured (StepResult.detail at the moment this step ran, per AC2's "captured
   * variables" requirement). */
  capturedName?: string;
  capturedValue?: string;
}

export interface Trace {
  runId: string;
  /** Task #44 — copied straight from `RunSummary.jobId`, so an exported trace.json is
   * attributable to the exact suite job that produced it, independent of `runId` (which stays a
   * plain execution-identity value, e.g. for /api/cancel). Undefined for a summary that predates
   * this field (browser-suite runs, out of this task's scope). */
  jobId?: string;
  flowName: string;
  passed: boolean;
  startedAt: number;
  durationMs: number;
  steps: TraceStep[];
}

/** Flatten a flow's steps (recursing through if/repeat, E4) into an id -> FlowStep lookup base.
 * `bridge/runner.ts` only ever produces ONE `StepResult` per TOP-LEVEL enabled step — an
 * `if`/`repeat` container is dispatched (and reported) as a single step, its children compiled
 * into one Maestro `run_flow` rather than run/reported individually — so `summary.results` never
 * contains a child's own id. Flattening anyway (rather than only indexing top-level steps) costs
 * nothing and means a future runner change that DID start reporting per-child results would
 * still resolve correctly here with no change to this file. */
function flattenSteps(steps: FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const step of steps) {
    out.push(step);
    const children = containerChildren(step);
    if (children) out.push(...flattenSteps(children));
  }
  return out;
}

/**
 * Build a step-by-step trace for ONE completed run (spec AC2). Joins `summary.results` (the
 * runner's actual per-step outcomes, in run order) with the originating `flow`'s own step
 * definitions (for the human-readable label and any `captureAs` declaration) — matched by
 * `stepId`, which both sides already share (StepResult.stepId === FlowStep.id).
 */
export function buildTrace(flow: Flow, summary: RunSummary): Trace {
  const byId = new Map<string, FlowStep>();
  for (const step of flattenSteps(flow.steps)) byId.set(step.id, step);

  let previousScreenshot: string | undefined;
  const steps: TraceStep[] = summary.results.map((r) => {
    const flowStep = byId.get(r.stepId);
    const beforeScreenshot = previousScreenshot;
    const afterScreenshot = r.screenshot;
    if (afterScreenshot) previousScreenshot = afterScreenshot;

    const capturedName = flowStep?.captureAs;
    const trace: TraceStep = {
      index: r.index,
      stepId: r.stepId,
      action: r.action,
      label: flowStep ? describeStep(flowStep) : r.action,
      descriptor: flowStep ? describeStepCode(flowStep) : undefined,
      status: r.status,
      durationMs: r.startedAt !== undefined && r.finishedAt !== undefined ? r.finishedAt - r.startedAt : undefined,
      attempts: r.attempts,
      healedRung: r.healedRung,
      beforeScreenshot,
      afterScreenshot,
      detail: r.detail,
      error: r.error,
      capturedName,
      capturedValue: capturedName && r.ok ? r.detail : undefined,
    };
    return trace;
  });

  return {
    runId: summary.runId,
    jobId: summary.jobId,
    flowName: summary.flowName,
    passed: summary.passed,
    startedAt: summary.startedAt,
    durationMs: summary.durationMs,
    steps,
  };
}

/** Stable JSON serialization for exporting a trace as its own artifact (spec AC4) — used both by
 * src/'s client-side "download trace.json" affordance and bridge/report.ts's own artifact writer. */
export function traceToJson(trace: Trace): string {
  return JSON.stringify(trace, null, 2);
}
