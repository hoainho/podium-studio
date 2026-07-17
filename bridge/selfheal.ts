import { createHash } from "node:crypto";
import type { FlowStep } from "../shared/ir.ts";
import { ASSERTION_ACTIONS, type ScreenElement } from "../shared/lint.ts";
import { isTransientError } from "./runner.ts";
import type {
  CandidateLocator,
  FailureClass,
  HealAttempt,
  HealOutcome,
  HealRung,
  InterstitialEntry,
  Lesson,
  LocatorKind,
  SelectorMemoryEntry,
} from "../shared/selfheal-types.ts";

/**
 * E19 — the rule-based, zero-AI recovery ladder, rungs 1–3
 * (janus-specs/R4-selfheal-collab/E19-selfheal-learning.md, PILLAR-9-adaptive-ai.md §2–3).
 * Rung 0 (implicit wait + retry) is bridge/runner.ts's EXISTING `runStepWithRetry` (R1) — reused,
 * not reimplemented, and it always runs BEFORE this module is ever consulted.
 *
 * Every function here is pure and fully injectable: no DB, no device, no AI. The caller (a
 * future bridge/runner.ts wiring, or bridge/server.ts glue) is responsible for reading
 * selector-memory / interstitial-catalog / heal-outcome rows from
 * bridge/db/primary-store.ts and handing them in ALREADY resolved — keeping this file
 * independently unit-testable and, more importantly, keeping it possible for a reviewer to grep
 * this ENTIRE file for any model/provider reference and find NONE (review-gate requirement —
 * rung 4, AI-proposed recovery, is out of scope for this epic, R5/E24).
 */

/** A step whose failure must NEVER be auto-healed (spec AC5, heal-type safety): re-targeting an
 * assertion's element would silently change WHAT the test verifies, not just WHERE it looks —
 * exactly the thing this epic's non-negotiable forbids. Shares the exact same action set
 * shared/lint.ts's own no-assertion rule uses, so the two can never drift apart. */
export function isAssertionAction(action: FlowStep["action"]): boolean {
  return ASSERTION_ACTIONS.has(action);
}

const CLASSIFY_PATTERNS: Array<{ cls: FailureClass; pattern: RegExp }> = [
  { cls: "crash", pattern: /crash|terminated unexpectedly|process exited/i },
  { cls: "app_not_foreground", pattern: /not (installed|running)|app.*background|not in foreground/i },
  { cls: "ambiguous", pattern: /ambiguous|khớp \d+ phần tử|matched \d+ elements|multiple (elements|matches)/i },
  { cls: "unexpected_screen", pattern: /unexpected screen|interstitial|popup|dialog/i },
];

/**
 * Classify a failed step's error message into Pillar 9 §2's failure taxonomy. Heuristic — like
 * `bridge/runner.ts`'s own `isTransientError`, which this function checks FIRST (reused, not
 * reimplemented) so "is this worth a rung 0 retry" and "which class is this for rungs 1–3" can
 * never silently disagree with each other. `element_not_found` is the fallback for an otherwise-
 * unclassified selector failure — the single most common shape of step failure.
 */
export function classifyFailure(error: string | undefined): FailureClass {
  if (isTransientError(error)) return "transient";
  if (!error) return "element_not_found";
  for (const { cls, pattern } of CLASSIFY_PATTERNS) {
    if (pattern.test(error)) return cls;
  }
  return "element_not_found";
}

/**
 * A stable fingerprint for "what's on screen right now" (Pillar 9 §3's "screen fingerprint") —
 * sorted + normalized on-screen labels, hashed. Order-independent (two screens with the same
 * labels traversed in a different order fingerprint identically) and case/whitespace-insensitive,
 * matching how `shared/lint.ts`'s own selector matching already normalizes text.
 */
export function computeScreenFingerprint(elements: ScreenElement[]): string {
  const labels = elements
    .map((e) => (e.text ?? e.accessibilityId ?? "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return createHash("sha256").update(JSON.stringify(labels)).digest("hex").slice(0, 16);
}

/** Pillar 9 §2's rung 1 priority order: semantic-id is the most stable, position the least. */
const LOCATOR_KIND_PRIORITY: Record<LocatorKind, number> = {
  targetId: 0,
  text: 1,
  role: 2,
  nearbyLabel: 3,
  position: 4,
};

/**
 * Rung 1 — re-resolve the SAME logical element via an alternate stable locator. Only ever
 * proposes a candidate that ACTUALLY resolves against the CURRENT screen (`elements`) — a
 * remembered locator that no longer matches anything live is never returned, so a stale memory
 * entry can never manufacture a false heal. Ranks by locator-kind priority first, then by how
 * often that exact locator has resolved before (`timesResolved`).
 */
export function reResolveLocator(elements: ScreenElement[], candidates: SelectorMemoryEntry[]): CandidateLocator | undefined {
  const liveTexts = new Set(elements.map((e) => (e.text ?? "").trim().toLowerCase()).filter(Boolean));
  const liveIds = new Set(elements.map((e) => e.accessibilityId).filter((x): x is string => !!x));

  const resolvable = candidates.filter((c) => {
    if (c.locatorKind === "targetId") return liveIds.has(c.locatorValue);
    if (c.locatorKind === "text") return liveTexts.has(c.locatorValue.trim().toLowerCase());
    // role/nearbyLabel/position have no simple live-set check available from a flat ScreenElement
    // list — trust the memory for these kinds (lowest-priority anyway, tried last).
    return true;
  });
  if (resolvable.length === 0) return undefined;

  resolvable.sort(
    (a, b) => LOCATOR_KIND_PRIORITY[a.locatorKind] - LOCATOR_KIND_PRIORITY[b.locatorKind] || b.timesResolved - a.timesResolved,
  );
  const best = resolvable[0];
  const kindScore = 1 - LOCATOR_KIND_PRIORITY[best.locatorKind] / 5;
  const historyScore = Math.min(best.timesResolved / 10, 1);
  // A heuristic re-resolution, never absolute certainty — capped below 1.
  const confidence = Math.min(0.99, 0.5 * kindScore + 0.5 * historyScore);
  return { kind: best.locatorKind, value: best.locatorValue, confidence };
}

/** Rung 2 — dismiss a KNOWN interstitial (already looked up by the caller via
 * `PrimaryStore.findInterstitial(fingerprint)`). Kept as its own named function (rather than
 * inlined into `attemptSelfHeal`) so the ladder-climbing logic below reads as one rung per line. */
export function matchKnownInterstitial(entry: InterstitialEntry | undefined): Record<string, unknown> | undefined {
  return entry?.dismissAction;
}

/**
 * Rung 3 — replay a KNOWN recovery for this exact (screen, error-class). `pinnedLessons` MUST
 * already be filtered to pinned-only by the caller (spec AC6: an unpinned candidate must never
 * auto-apply — enforced at the `PrimaryStore.findLessons(..., {pinnedOnly: true})` call site, not
 * here, so this function has no way to accidentally see an unpinned one). Prefers the lesson
 * matching the best-known strategy's rung (when heal-outcome stats are available); falls back to
 * the most recently pinned lesson that has a usable recovery payload.
 */
export function findKnownRecovery(pinnedLessons: Lesson[], bestOutcome: HealOutcome | undefined): { lesson: Lesson; rung: HealRung } | undefined {
  const withRecovery = pinnedLessons.filter((l): l is Lesson & { rung: HealRung; recovery: Record<string, unknown> } => !!l.recovery && !!l.rung);
  if (withRecovery.length === 0) return undefined;
  const preferred = bestOutcome ? withRecovery.find((l) => l.rung === bestOutcome.rung) : undefined;
  const chosen = preferred ?? withRecovery[0];
  return { lesson: chosen, rung: chosen.rung };
}

export interface SelfHealContext {
  step: FlowStep;
  errorClass: FailureClass;
  /** Elements on screen at failure time — used both to compute the fingerprint upstream and by
   * rung 1's live-resolvability check. */
  elements: ScreenElement[];
  /** Rung 1's candidates for the SAME element the step targeted, already looked up by the caller
   * (keyed by (screenFingerprint, elementKey) — see bridge/db/primary-store.ts's
   * `findSelectorMemory`). */
  selectorCandidates?: SelectorMemoryEntry[];
  /** Rung 2's match, if the caller already looked one up for this fingerprint. */
  interstitial?: InterstitialEntry;
  /** Rung 3's candidates — PINNED lessons only (AC6) — plus the aggregated ranking stat. */
  pinnedLessons?: Lesson[];
  bestOutcome?: HealOutcome;
}

/**
 * Climb rungs 1–3 for one failed step (rung 0 already ran, upstream, before this is ever
 * called). Heal-type safety (AC5) is enforced FIRST and unconditionally: an assertion action
 * never even attempts a heal, let alone proposes a patch — the run simply falls through to its
 * existing hard-failure/halt behavior untouched, exactly matching "stops and asks".
 */
export function attemptSelfHeal(ctx: SelfHealContext): HealAttempt {
  if (isAssertionAction(ctx.step.action)) {
    return { healed: false, reason: "assertion failures are never auto-healed (heal-type safety, AC5)" };
  }

  // Rung 2: unexpected_screen — dismiss a known interstitial before anything else.
  if (ctx.errorClass === "unexpected_screen") {
    const dismiss = matchKnownInterstitial(ctx.interstitial);
    if (dismiss) {
      return {
        healed: true,
        rung: 2,
        appliedRecovery: dismiss,
        proposedPatch: {
          healType: "interstitial",
          rung: 2,
          summary: `Dismissed known interstitial "${ctx.interstitial!.label}" before retrying.`,
          recovery: dismiss,
        },
      };
    }
  }

  // Rung 1: element_not_found / ambiguous — re-resolve via an alternate stable locator.
  if (ctx.errorClass === "element_not_found" || ctx.errorClass === "ambiguous") {
    const candidate = reResolveLocator(ctx.elements, ctx.selectorCandidates ?? []);
    if (candidate) {
      const recovery = { kind: candidate.kind, value: candidate.value };
      return {
        healed: true,
        rung: 1,
        appliedRecovery: recovery,
        // No `lessonId` yet — this is a BRAND NEW candidate, not yet a persisted lesson; the
        // caller creates one (via `insertLesson`) only if the human approves the patch.
        proposedPatch: {
          healType: "locator",
          rung: 1,
          summary: `Re-resolved the target via ${candidate.kind} ("${candidate.value}") instead of the original locator.`,
          recovery,
        },
      };
    }
  }

  // Rung 3: replay a known recovery for this exact (screen, error-class) — the general fallback,
  // reached when rungs 1/2 didn't apply, or found nothing LIVE to use.
  const known = findKnownRecovery(ctx.pinnedLessons ?? [], ctx.bestOutcome);
  if (known) {
    // Heal-type safety (AC5) is architectural, not merely a UI-review courtesy: an assertion-
    // typed lesson must never be APPLIED at all, not just hidden from the "save this fix?"
    // patch view. A pinned lesson's own healType should never be "assertion" (nothing in this
    // module ever inserts one for an assertion action), but this is checked again here — code-
    // review finding (R4 gate, BLOCKER) — rather than trusted blindly from stored data, since
    // previously this branch still set `healed: true`/`appliedRecovery` even when it decided not
    // to expose a patch, silently re-targeting the assertion's element anyway.
    if (known.lesson.healType === "assertion") {
      return { healed: false, reason: "matching lesson is assertion-typed — never auto-applied (heal-type safety, AC5)" };
    }
    return {
      healed: true,
      rung: 3,
      appliedRecovery: known.lesson.recovery,
      proposedPatch: {
        lessonId: known.lesson.id,
        healType: known.lesson.healType,
        rung: 3,
        summary: "Replayed a previously-approved fix for this exact screen + failure.",
        recovery: known.lesson.recovery!,
      },
    };
  }

  return { healed: false, reason: `no rung 1-3 recovery available for error class "${ctx.errorClass}"` };
}
