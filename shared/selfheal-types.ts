/**
 * E19 — Deterministic self-heal rungs 0–3 + learning store
 * (janus-specs/R4-selfheal-collab/E19-selfheal-learning.md, PILLAR-9-adaptive-ai.md §2–3, §6).
 *
 * Pure, framework-free types shared by bridge/selfheal.ts (the rung-climbing engine),
 * bridge/db's learning-store CRUD, and — eventually — a future authoring/dashboard UI. Nothing
 * here references node:sqlite, a driver, or an AI provider: rungs 0–3 are 100% rule-based
 * (review gate: "grep the entire rung 0–3 code path for any AI/AiProvider reference — must find
 * none"). Rung 4 (AI-proposed recovery) is out of scope for this epic (R5/E24).
 */

/** Pillar 9 §2's failure taxonomy — what CLASS of failure a step outcome represents, decided
 * BEFORE any rung is attempted (the classification drives which rungs are even eligible). */
export type FailureClass =
  | "transient"
  | "element_not_found"
  | "ambiguous"
  | "unexpected_screen"
  | "app_not_foreground"
  | "crash";

/** Rung 0 is the existing retry-on-transient-failure path (bridge/runner.ts's
 * `runStepWithRetry`, R1) — reused, not reimplemented, here. This module adds rungs 1–3 (rule-
 * based, zero AI). Rung 4 (E24, `shared/ai-types.ts`) is the sole AI-involving rung — widened
 * into this same union (rather than a parallel type) so every existing rung-1–3 consumer
 * (StepResult.healedRung, HealOutcome, Lesson, HealAttempt) transparently also accepts "a rung-4
 * heal happened here" without a second, parallel field to keep in sync. */
export type HealRung = 1 | 2 | 3 | 4;

/** A locator's "kind" in Pillar 9 §2's re-resolution priority order (rung 1): semantic-id is the
 * most stable, position the least. Mirrors the mobile/browser drivers' own targetId/text
 * vocabulary (IR-SPEC.md §5) plus two rung-1-specific additions (role, nearbyLabel). */
export type LocatorKind = "targetId" | "text" | "role" | "nearbyLabel" | "position";

export interface CandidateLocator {
  kind: LocatorKind;
  value: string;
  /** 0..1 confidence this locator resolves to the SAME logical element the step originally
   * targeted — used to rank rung 1 candidates, highest first. */
  confidence: number;
}

/** Whether a heal changes WHICH element a step targets (locator) or WHAT COUNTS AS CORRECT
 * (assertion) — the load-bearing distinction for heal-type safety (spec AC5): a locator heal may
 * be auto-suggested; an assertion heal must NEVER be auto-proposed, always stop and ask. */
export type HealType = "locator" | "assertion" | "interstitial" | "other";

export function isAssertionHealType(t: HealType): boolean {
  return t === "assertion";
}

/** One dismissable interstitial (Pillar 9 §3's "interstitial catalog") — a popup/dialog fingerprint
 * plus the dismiss action that worked, so rung 2 can replay it deterministically. */
export interface InterstitialEntry {
  id: string;
  fingerprint: string;
  label: string;
  /** The IR-shaped dismiss action (kept as an opaque record here — bridge/selfheal.ts's caller
   * knows how to turn this back into a real step). */
  dismissAction: Record<string, unknown>;
  timesSeen: number;
  lastSeenAt?: number;
}

/** One remembered locator for one logical element on one screen (Pillar 9 §3's "selector
 * memory") — rung 1's re-resolution source. */
export interface SelectorMemoryEntry {
  id: string;
  screenFingerprint: string;
  elementKey: string;
  locatorKind: LocatorKind;
  locatorValue: string;
  timesResolved: number;
  lastResolvedAt?: number;
}

/** Aggregated (screen, error-class) -> which rung/strategy has worked, and how often (Pillar 9
 * §3's "heal outcomes") — rung 3's ranking source: try the most successful strategy first. */
export interface HealOutcome {
  id: string;
  screenFingerprint: string;
  errorClass: FailureClass;
  rung: HealRung;
  strategy: string;
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
}

/** One recorded failure (Pillar 9 §3's "lesson record") — the append-only, queryable "what
 * broke, where, why, and what fixed it" asset. `pinned` is the ONLY thing that makes a lesson
 * eligible for replay by rungs 1–3 (spec AC6: an unpinned lesson never auto-applies). */
export interface Lesson {
  id: string;
  screenFingerprint: string;
  errorClass: FailureClass;
  stepIntent: string;
  healType: HealType;
  /** Which rung produced a recovery, if any — undefined means "recorded, never recovered". */
  rung?: HealRung;
  /** The recovery action that worked, if any (opaque — a real IR-shaped step field set). */
  recovery?: Record<string, unknown>;
  topLabels: string[];
  screenshotPath?: string;
  appVersion?: string;
  flowId?: string;
  pinned: boolean;
  createdAt: number;
}

/** A rung 1–3 heal that succeeded, offered to the human as a reviewed patch (spec AC2/AC5:
 * "save this fix?" — NEVER auto-saved to the flow JSON). `undefined` for an assertion heal, which
 * must never be auto-proposed at all (heal-type safety, AC5) — callers check `healType` first. */
export interface ProposedPatch {
  /** The lesson this patch would save/update, if one already exists (e.g. a rung 3 replay of an
   * already-pinned lesson). Absent for a BRAND NEW rung 1/2 heal — no lesson row exists yet at
   * the moment of proposing; the caller creates one (via insertLesson) only if the human approves. */
  lessonId?: string;
  healType: HealType;
  rung: HealRung;
  /** Human-readable summary of what changed (e.g. "re-resolved 'Login' via text instead of
   * targetId #btn_login_old"). */
  summary: string;
  recovery: Record<string, unknown>;
}

/** The result of climbing rungs 1–3 for one failed step (rung 0 is handled entirely upstream by
 * bridge/runner.ts's existing retry loop before this is ever consulted). */
export interface HealAttempt {
  healed: boolean;
  rung?: HealRung;
  /** The action actually taken to recover (opaque IR-shaped step field set) — undefined when
   * `healed` is false. */
  appliedRecovery?: Record<string, unknown>;
  /** Present only when `healed` is true AND the heal type allows auto-suggestion (locator/
   * interstitial) — an assertion heal (healType === "assertion") never produces one (AC5). */
  proposedPatch?: ProposedPatch;
  /** Why nothing healed (or why a candidate was found but not applied — e.g. "unpinned in
   * Strict mode", AC6) — always present when `healed` is false, for observability/logging. */
  reason?: string;
}
