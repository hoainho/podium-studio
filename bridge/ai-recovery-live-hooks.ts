import type { PrimaryStore } from "./db/primary-store.ts";
import type { AiRecoveryHooks } from "./runner.ts";
import { resolveRoleChain } from "./ai-registry.ts";

/**
 * ai-recovery-live-hooks.ts — the "live" (real provider registry + real learning store)
 * implementation of bridge/runner.ts's `AiRecoveryHooks` seam (E24). Mirrors
 * bridge/selfheal-live-hooks.ts's own role exactly: everything in bridge/ai-rung4.ts and the
 * `AiRecoveryHooks` interface itself is pure/injectable (unit-tested with fakes, no DB, no real
 * provider) — this file is the ONE place that wires it to a real `PrimaryStore`
 * (bridge/db/primary-store.ts). Kept deliberately thin, matching this codebase's established
 * "server.ts routes / driver glue are thin plumbing, not independently unit-tested" convention.
 */

/**
 * Build real hooks for one run. Reads the CURRENT provider registry from the primary store on
 * EVERY call (not cached once at construction) so a registry change made mid-session (via
 * `POST /api/ai/providers`) takes effect on the very next failed step, not just the next process
 * restart. `flowId` is optional context threaded into any lesson this run records, same as
 * bridge/selfheal-live-hooks.ts's own `createLiveSelfHealHooks`.
 */
export function createLiveAiRecoveryHooks(store: PrimaryStore, flowId?: string): AiRecoveryHooks {
  return {
    getRecoveryProviders: () => {
      const registry = store.getProviderRegistry();
      // resolveRoleChain re-filters out any agent-cli id for the "recovery" role as a SECOND,
      // independent enforcement of AC5 — defense in depth, never trusting config-load validation
      // as the only gate (see that function's own doc comment).
      return resolveRoleChain(registry, "recovery");
    },

    // AWAITED by the run loop (same reasoning as SelfHealHooks.onHealAttempt): the return value
    // is the id of a lesson JUST inserted, so the caller can correlate it onto the step's
    // `StepResult.pendingHeal.lessonId`. Never allowed to throw/reject — a persistence hiccup
    // resolves to `undefined` instead of failing the run.
    onAiAttempt: async ({ step, errorClass, attempt, succeeded }) => {
      // AC3 (BLOCKING): every rung-4 call is logged locally, healed or not — this is the ONE
      // unconditional side effect here, never gated on `succeeded` or on human approval.
      try {
        await store.insertAiCallLog(attempt.logEntry);
      } catch (err: any) {
        console.error("[podium-studio] rung-4: failed to write AI call log:", err?.message ?? err);
      }

      if (!succeeded || !attempt.proposedPatch) return undefined;

      // A patch with NO lessonId is a BRAND NEW candidate — record it as its own, UNPINNED lesson
      // (same "every run writes to the learning store automatically, pinning is a separate human
      // action" rule as rungs 1-3's onHealAttempt). Reuses the SAME `lessons` table (E19) —
      // `HealRung` already includes 4, `HealType` already includes "other" (rung 4's patch kind),
      // so no new table/migration is needed for this.
      if (attempt.proposedPatch.lessonId) return undefined;
      const stepAny = step as unknown as { text?: string; targetId?: string };
      const stepIntent = `${step.action}${stepAny.text ? ` "${stepAny.text}"` : stepAny.targetId ? ` #${stepAny.targetId}` : ""}`;
      try {
        return await store.insertLesson({
          screenFingerprint: attempt.logEntry.screenFingerprint ?? "",
          errorClass,
          stepIntent,
          healType: attempt.proposedPatch.healType,
          rung: 4,
          recovery: attempt.appliedRecovery as unknown as Record<string, unknown>,
          topLabels: [],
          flowId,
        });
      } catch (err: any) {
        console.error("[podium-studio] rung-4: failed to record lesson:", err?.message ?? err);
        return undefined;
      }
    },
  };
}
