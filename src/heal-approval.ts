import type { StepResult } from "../shared/protocol.ts";
import { isAssertionHealType, type ProposedPatch } from "../shared/selfheal-types.ts";

/**
 * heal-approval.ts — the src/ half of E19/E24's "save this fix?" patch approval
 * (janus-specs/R4-selfheal-collab/E19-selfheal-learning.md, AC2/AC5/AC6; extended for E24's
 * rung 4 AI heal — janus-specs/R5-R6-ai-cloud/E24-ai-providers.md, AC3/AC4).
 *
 * Pure, testable "which heals are approvable" logic. A healed step (`StepResult.healedRung` set)
 * is only ever offered for approval when the backend has ALSO attached its own `pendingHeal`
 * patch — `StepResult.pendingHeal?: ProposedPatch` is now a REAL field on the shared type (landed
 * by worker-E1's backend work; this module previously read it via a local structural stand-in
 * while that was in flight — no longer needed, reads it directly now). Per
 * shared/selfheal-types.ts's own doc comment, `ProposedPatch` itself is `undefined` for an
 * assertion heal (AC5/E24-AC4: "an assertion heal never produces one" — backend-enforced) — this
 * module never re-derives or second-guesses `healType` on its own; it reuses
 * `isAssertionHealType` (the SAME single source of truth the backend itself uses) rather than a
 * separately-maintained allowlist, so a future new `HealType` value never silently falls through
 * either check out of sync with the other, and only refuses to show a patch that somehow claims
 * to be an assertion heal anyway, as defense-in-depth — never trusting a single layer alone.
 */

export interface HealedStepInfo {
  step: StepResult;
  /** The backend's own proposed patch for this step, when one is available. */
  patch?: ProposedPatch;
}

/**
 * True when `info` is a genuinely approvable "save this fix?" candidate: the step actually
 * healed, a patch was attached, AND that patch's own `healType` is NOT "assertion" (AC5/E24-AC4)
 * — locator, interstitial, AND rung 4's AI-proposed "other"-typed patches are all approvable;
 * only an assertion heal is categorically refused. Narrows `info.patch` to defined for
 * TypeScript, so callers never need an extra null-check after this returns true.
 */
export function isApprovableHeal(info: HealedStepInfo): info is HealedStepInfo & { patch: ProposedPatch } {
  if (!info.step.healedRung || !info.patch) return false;
  return !isAssertionHealType(info.patch.healType);
}

/**
 * Every step in `results` that healed AND carries its own approvable `pendingHeal` patch, in run
 * order — the exact set a "save this fix?" prompt should render. Reads `pendingHeal` straight off
 * each step — no external correlation map needed.
 */
export function collectApprovableHeals(results: StepResult[]): Array<HealedStepInfo & { patch: ProposedPatch }> {
  const out: Array<HealedStepInfo & { patch: ProposedPatch }> = [];
  for (const step of results) {
    if (!step.healedRung) continue;
    const info: HealedStepInfo = { step, patch: step.pendingHeal };
    if (isApprovableHeal(info)) out.push(info);
  }
  return out;
}

/** True when a patch can actually be pinned right now — it needs a real `lessonId` (a brand-new
 * rung 1/2 heal that hasn't been correlated to its freshly-inserted lesson row yet has none, per
 * ProposedPatch's own doc comment) — the Approve button is disabled, never silently failing,
 * when this is false. */
export function canPinPatch(patch: ProposedPatch): patch is ProposedPatch & { lessonId: string } {
  return typeof patch.lessonId === "string" && patch.lessonId.length > 0;
}

/** Plain-Vietnamese label for a rung number — shown next to the patch summary so a QA
 * understands roughly WHAT KIND of fix this was without needing to know the rung-numbering
 * scheme by heart. Rung 4 (E24, Adaptive-mode only) is called out as AI-sourced explicitly —
 * every heal needs the SAME explicit human approval (AC2/AC3), but a QA reviewing an AI
 * suggestion specifically benefits from knowing that up front, not just "rung 4" as an opaque
 * number. */
export function healRungLabel(rung: 1 | 2 | 3 | 4): string {
  switch (rung) {
    case 1: return "Đã tự tìm lại bộ chọn (rung 1)";
    case 2: return "Đã tự đóng thông báo/popup lạ (rung 2)";
    case 3: return "Đã áp dụng cách khắc phục đã lưu trước đó (rung 3)";
    case 4: return "AI đề xuất cách khắc phục (rung 4) — cần bạn duyệt lại";
  }
}
