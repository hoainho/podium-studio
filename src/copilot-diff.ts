import type { Flow } from "../shared/ir.ts";
import type { CoPilotHunk, CoPilotHunkKind, CoPilotSuggestion } from "../shared/ai-types.ts";

export type { CoPilotHunk, CoPilotHunkKind, CoPilotSuggestion };

/**
 * copilot-diff.ts — authoring co-pilot review-diff (E24, AC7: "output is always presented as a
 * review diff (accept/reject per hunk)... never auto-saved"). Pure, testable — the actual HTTP
 * call to worker-E1's co-pilot endpoint lives in src/api.ts; this module only decides what
 * "applying the accepted hunks" means, structurally identical to shared/flow-diff.ts's own
 * per-step decision model (E21), reused here for consistency rather than reinvented.
 *
 * `CoPilotHunk`/`CoPilotSuggestion` are imported straight from shared/ai-types.ts (worker-E1's
 * wire-contract types, re-exported here for convenience) rather than duplicated locally — a
 * hunk's own `step` field is a `LeafStep` (shared/ir.ts), NOT the full `FlowStep` union: the
 * co-pilot only ever proposes concrete leaf actions, never an `if`/`repeat`/`callSubFlow`
 * container — a deliberate scope boundary carried from the wire type, not something this module
 * invents on its own.
 */

export type HunkDecision = "accept" | "reject";

/**
 * Build the resulting flow from ONLY the explicitly accepted hunks (AC7). Any hunk with no
 * recorded decision — or an explicit "reject" — is left out entirely: the safe default is to
 * apply NOTHING, never to guess a QA meant "yes" for something they haven't clicked on. Never
 * mutates `flow`.
 */
export function applyAcceptedHunks(
  flow: Flow,
  suggestion: CoPilotSuggestion,
  decisions: Readonly<Record<string, HunkDecision>>,
): Flow {
  let steps = flow.steps;
  for (const hunk of suggestion.hunks) {
    if (decisions[hunk.id] !== "accept") continue;
    if (hunk.kind === "add" && hunk.step) {
      steps = [...steps, hunk.step];
    } else if (hunk.kind === "change" && hunk.targetStepId && hunk.step) {
      const target = hunk.step;
      steps = steps.map((s) => (s.id === hunk.targetStepId ? target : s));
    } else if (hunk.kind === "remove" && hunk.targetStepId) {
      steps = steps.filter((s) => s.id !== hunk.targetStepId);
    }
  }
  return steps === flow.steps ? flow : { ...flow, steps };
}

/** How many hunks the QA has explicitly accepted so far — used to gate the "Apply accepted"
 * button (disabled at 0: nothing to do, never a no-op "apply" click). */
export function acceptedCount(suggestion: CoPilotSuggestion, decisions: Readonly<Record<string, HunkDecision>>): number {
  return suggestion.hunks.filter((h) => decisions[h.id] === "accept").length;
}

/** True once every hunk has an explicit decision (accept OR reject) recorded — a UI convenience
 * for showing "N of M reviewed," not an architectural requirement to apply (a QA may reasonably
 * want to accept 2 of 5 hunks and leave the rest undecided/rejected for now). */
export function allHunksDecided(suggestion: CoPilotSuggestion, decisions: Readonly<Record<string, HunkDecision>>): boolean {
  return suggestion.hunks.every((h) => decisions[h.id] !== undefined);
}
