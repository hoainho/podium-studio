import { useState } from "react";
import type { StepResult } from "../../shared/protocol.ts";
import type { ProposedPatch } from "../../shared/selfheal-types.ts";
import { canPinPatch, collectApprovableHeals, healRungLabel, type HealedStepInfo } from "../heal-approval.ts";
import { pinLesson } from "../api.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface HealApprovalPromptProps {
  /** Each step's own `pendingHeal` (the fixed contract with worker-E1's backend work —
   * shared/selfheal-types.ts's `ProposedPatch`) is read directly off it — see
   * src/heal-approval.ts's `WithPendingHeal` for why that's a local type-widen rather than a
   * `shared/protocol.ts` import for now. */
  results: StepResult[];
  onDismissed?: (stepId: string) => void;
}

/**
 * "Save this fix?" prompt (E19 spec AC2/AC5/AC6) — one row per approvable self-heal
 * (locator/interstitial only, never assertion, per src/heal-approval.ts's own boundary), each
 * with Approve (pins the lesson via POST /api/selfheal/pin) and Dismiss. Renders nothing at all
 * when there's nothing approvable — never an empty/placeholder panel.
 */
export default function HealApprovalPrompt({ results, onDismissed }: HealApprovalPromptProps) {
  const t = useT();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const heals = collectApprovableHeals(results).filter((h) => !dismissed.has(h.step.stepId));

  if (heals.length === 0) return null;

  function dismiss(stepId: string) {
    setDismissed((prev) => new Set(prev).add(stepId));
    onDismissed?.(stepId);
  }

  return (
    <div className="heal-approval">
      <div className="add-step__group-label">{t("heal.promptTitle")}</div>
      {heals.map((heal) => (
        <HealApprovalRow key={heal.step.stepId} heal={heal} onDismiss={() => dismiss(heal.step.stepId)} />
      ))}
    </div>
  );
}

function HealApprovalRow({ heal, onDismiss }: { heal: HealedStepInfo & { patch: ProposedPatch }; onDismiss: () => void }) {
  const t = useT();
  const [pinning, setPinning] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinnable = canPinPatch(heal.patch);

  async function approve() {
    if (!pinnable) return;
    setPinning(true);
    setError(null);
    try {
      await pinLesson(heal.patch.lessonId!);
      setPinned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPinning(false);
    }
  }

  return (
    <div className="heal-approval__row">
      <div className="heal-approval__header">
        <Icon.wand size={14} />
        <span className="badge badge--accent">{healRungLabel(heal.patch.rung)}</span>
      </div>
      <div className="faint" style={{ fontSize: 12.5 }}>{heal.patch.summary}</div>
      {error && (
        <div className="error-banner" role="alert" style={{ marginTop: 6 }}>
          <Icon.alert size={13} />
          <div>{error}</div>
        </div>
      )}
      {pinned ? (
        <span className="badge badge--ok" style={{ marginTop: 6 }}>{t("heal.savedBadge")}</span>
      ) : (
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <button
            className="btn btn--sm btn--primary"
            onClick={approve}
            disabled={pinning || !pinnable}
            title={!pinnable ? t("heal.notPinnableYetHint") : undefined}
          >
            {pinning ? <span className="spinner" /> : <Icon.check size={13} />}
            {t("heal.approveButton")}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={onDismiss} disabled={pinning}>
            {t("heal.dismissButton")}
          </button>
        </div>
      )}
    </div>
  );
}
