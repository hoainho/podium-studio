import type { RunSummary, StepResult } from "../shared/protocol.ts";
import type { TriageInput } from "../shared/triage.ts";

/**
 * triage-input.ts — best-effort derivation of a `TriageInput` (shared/triage.ts) from REAL
 * `StepResult`/`RunSummary` data.
 *
 * This is a HEURISTIC layer, deliberately kept separate from the deterministic classifier
 * itself: `classifyFailure()` is exhaustively tested against 50 clean, unambiguous seeded
 * `TriageInput` fixtures (test/triage.test.ts) and never needs to know how its input was
 * produced. Turning a REAL completed run's step outcome into that clean input shape is harder —
 * a completed run can't be re-inspected live, so `selectorMatchCount`/`screenStructureChanged`
 * are approximated from the step's recorded `error`/`detail` TEXT rather than measured directly.
 * A real production upgrade would have bridge/runner.ts (or a live re-check against
 * shared/lint.ts's own ambiguity engine) emit these as STRUCTURED fields on `StepResult` instead
 * of requiring text-pattern matching — out of this epic's scope (bridge/ is off-limits this
 * round) but disclosed here, not hidden behind a false claim of precision.
 */

const NO_MATCH_PATTERNS = [/không tìm thấy/i, /not found/i, /no element/i, /no match/i];
const AMBIGUOUS_PATTERNS = [/khớp \d+ phần tử/i, /matched \d+ elements?/i, /ambiguous/i, /multiple elements?/i];
const VALUE_MISMATCH_PATTERNS = [
  /không khớp với giá trị/i,
  /giá trị .*không khớp/i,
  /does ?n['o]?t match (the )?expected/i,
  /expected .* but (got|found)/i,
  /value mismatch/i,
];
const STRUCTURE_CHANGED_PATTERNS = [/cấu trúc màn hình/i, /screen structure/i, /layout changed/i, /structural(ly)? (different|changed)/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Best-effort element-match count from free text — 0 for a clear "not found," a parsed number
 * when the message states one (e.g. "khớp 3 phần tử" / "matched 3 elements"), a generic >1 for a
 * recognized "ambiguous" phrase with no explicit count, else undefined (no confident signal). */
function extractMatchCount(text: string): number | undefined {
  if (!text.trim()) return undefined;
  if (matchesAny(text, NO_MATCH_PATTERNS)) return 0;
  const m = text.match(/(\d+)\s*(phần tử|elements?)/i);
  if (m) return Number(m[1]);
  if (matchesAny(text, AMBIGUOUS_PATTERNS)) return 2;
  return undefined;
}

/**
 * True when a DIFFERENT run in `otherSummaries` has this same step (by `stepId`) recorded as
 * `ok: true` — the cross-run "intermittent pass" flake signal (spec T2#2's own framing). A
 * single ad-hoc run has nothing to compare against and correctly yields `false` here — flake
 * detection needs at least one other data point, never guessed from a single observation.
 */
export function stepPassedElsewhere(stepId: string, currentRunId: string, otherSummaries: RunSummary[]): boolean {
  return otherSummaries.some((s) => s.runId !== currentRunId && s.results.some((r) => r.stepId === stepId && r.ok));
}

export interface DeriveTriageInputContext {
  /** Other completed runs of the SAME flow (e.g. from an E15 suite report's multiple workers, or
   * prior manual re-runs the QA has kept around) — used purely for the flake cross-check above.
   * Omit (or pass just `[currentSummary]`) when only a single run is available. */
  otherSummaries?: RunSummary[];
}

/** Derive a `TriageInput` for one failed/failed-soft step of `summary`. */
export function deriveTriageInput(step: StepResult, summary: RunSummary, ctx: DeriveTriageInputContext = {}): TriageInput {
  const text = `${step.error ?? ""} ${step.detail ?? ""}`;
  return {
    action: step.action,
    passedOnRetry: stepPassedElsewhere(step.stepId, summary.runId, ctx.otherSummaries ?? []),
    attempts: step.attempts,
    selectorMatchCount: extractMatchCount(text),
    assertionValueMismatch: matchesAny(text, VALUE_MISMATCH_PATTERNS),
    screenStructureChanged: matchesAny(text, STRUCTURE_CHANGED_PATTERNS),
  };
}

/** Every failed/failed-soft step of `summary` — the set the triage panel actually needs to
 * classify (a passed step has nothing to triage). */
export function failedSteps(summary: RunSummary): StepResult[] {
  return summary.results.filter((r) => r.status === "failed" || r.status === "failed-soft");
}
