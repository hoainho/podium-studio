import type { ScreenElement } from "../shared/lint.ts";
import type { PrimaryStore } from "./db/primary-store.ts";
import { engine } from "./podium.ts";
import type { SelfHealHooks } from "./runner.ts";

/**
 * E19 — the "live" (real device + real learning store) implementation of bridge/runner.ts's
 * `SelfHealHooks` seam. Everything in bridge/selfheal.ts and the SelfHealHooks interface itself
 * is pure/injectable on purpose (unit-tested with fakes, no DB, no device) — this file is the
 * ONE place that actually wires it to `engine.inspectScreen` (a real a11y-tree read) and a real
 * `PrimaryStore` (bridge/db/primary-store.ts). Kept deliberately thin, matching this codebase's
 * established "server.ts routes / driver glue are thin plumbing, not independently unit-tested"
 * convention (see bridge/server.ts's other routes).
 */

/** Mirrors bridge/server.ts's own `flattenScreenElements` exactly — duplicated rather than
 * imported, since server.ts is an ENTRY POINT with side effects at module load (it calls
 * `server.listen(...)` at the bottom) — nothing should ever import FROM it. Kept intentionally
 * tiny so the duplication is cheap to keep in sync if either ever changes. */
function flattenScreenElements(node: unknown, out: ScreenElement[] = []): ScreenElement[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  const text = n.text ?? n.label ?? n.accessibilityLabel ?? n.name;
  const accessibilityId = n.id ?? n.accessibilityId ?? n.resourceId;
  if (typeof text === "string" || typeof accessibilityId === "string") {
    out.push({
      text: typeof text === "string" ? text : undefined,
      accessibilityId: typeof accessibilityId === "string" ? accessibilityId : undefined,
    });
  }
  const children = n.children ?? n.elements ?? [];
  if (Array.isArray(children)) for (const c of children) flattenScreenElements(c, out);
  return out;
}

/**
 * Build real hooks for one run against one device. `flowId` is optional context threaded into
 * any lesson this run records (Pillar 9 §3's lesson record includes it).
 */
export function createLiveSelfHealHooks(udid: string, store: PrimaryStore, flowId?: string): SelfHealHooks {
  return {
    async getScreenElements() {
      try {
        const raw = await engine.inspectScreen(udid);
        return flattenScreenElements(raw);
      } catch {
        return []; // no live screen available — rungs 1/2 simply find nothing resolvable, never crash
      }
    },
    getSelectorCandidates: (fingerprint, elementKey) => store.findSelectorMemory(fingerprint, elementKey),
    getInterstitial: (fingerprint) => store.findInterstitial(fingerprint),
    getPinnedLessons: (fingerprint, errorClass) => store.findLessons(fingerprint, errorClass, { pinnedOnly: true }),
    getBestOutcome: (fingerprint, errorClass) => store.findBestHealOutcome(fingerprint, errorClass),

    // AWAITED by the run loop (E19 gap-fix — see SelfHealHooks' own doc comment): the return
    // value is the id of a lesson JUST inserted, so the caller can correlate it onto the step's
    // `StepResult.pendingHeal.lessonId` for the "save this fix?" UI. Still never allowed to
    // throw/reject — a persistence hiccup resolves to `undefined` instead of failing the run.
    //
    // `succeeded` (code-review finding, R4 gate, MAJOR + MINOR) is the REAL, verified result of
    // the healed retry, computed by the run loop AFTER it actually ran — never inferred from
    // `attempt.healed` alone, which only means "a candidate/known recovery was found", not that
    // it worked. Both the ranking stat AND the fresh-lesson insert below key off it: a candidate
    // that resolved but whose retry then failed must be recorded as a FAILURE, and must NEVER
    // persist a brand-new, unpinned lesson for a "fix" that didn't actually fix anything.
    onHealAttempt: async ({ step, fingerprint, errorClass, elements, attempt, succeeded }) => {
      if (!attempt.healed || !attempt.rung) return undefined;
      const strategy = attempt.proposedPatch?.healType ?? "known-recovery";
      store.recordHealOutcome(fingerprint, errorClass, attempt.rung, strategy, succeeded).catch(() => {
        /* best-effort — a ranking-stat write failing never affects the run */
      });
      if (!succeeded) return undefined;

      // A patch with NO lessonId is a BRAND NEW candidate (rung 1/2) — record it as its own,
      // UNPINNED lesson (Pillar 9 §3: every run writes to the learning store, automatically —
      // that's just data capture). A rung 3 replay of an ALREADY-pinned lesson has a lessonId
      // already and is skipped here, so replaying a known fix never creates a duplicate row.
      // Pinning (making it Strict-replayable) stays a SEPARATE, explicit human action (AC2/AC6)
      // — nothing on this path ever calls pinLesson.
      if (attempt.proposedPatch && !attempt.proposedPatch.lessonId) {
        const stepAny = step as unknown as { text?: string; targetId?: string };
        const stepIntent = `${step.action}${stepAny.text ? ` "${stepAny.text}"` : stepAny.targetId ? ` #${stepAny.targetId}` : ""}`;
        const topLabels = elements.map((e) => e.text ?? e.accessibilityId ?? "").filter(Boolean).slice(0, 10);
        try {
          return await store.insertLesson({
            screenFingerprint: fingerprint,
            errorClass,
            stepIntent,
            healType: attempt.proposedPatch.healType,
            rung: attempt.rung,
            recovery: attempt.appliedRecovery,
            topLabels,
            flowId,
          });
        } catch (err: any) {
          console.error("[podium-studio] self-heal: failed to record lesson:", err?.message ?? err);
          return undefined;
        }
      }
      return undefined;
    },
  };
}
