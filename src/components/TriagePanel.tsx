import { useState } from "react";
import type { Flow } from "../../shared/ir.ts";
import type { RunSummary } from "../../shared/protocol.ts";
import { classifyFailure, type TriageClass, type TriageInput } from "../../shared/triage.ts";
import { buildBugBundleEntries, getExportTarget, type BugBundleInput } from "../bug-export.ts";
import { deriveTriageInput, failedSteps } from "../triage-input.ts";
import { artifactUrl } from "../api.ts";
import type { Trace, TraceStep } from "../trace.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

type T = (path: string, vars?: Record<string, string | number>) => string;

/** Localizes classifyFailure's `nextAction` by `triageClass` alone (task #47 — shared/triage.ts's
 * NEXT_ACTIONS lookup table is Vietnamese-only) — the 5 classes each have exactly one fixed
 * next-action, so no other TriageInput data is needed. */
export function localizedNextAction(t: T, triageClass: TriageClass): string {
  return t(`triage.nextAction.${triageClass}`);
}

/** Localizes classifyFailure's `reason` from the SAME TriageInput this panel already derives
 * client-side (src/triage-input.ts) — mirrors shared/triage.ts's own branching (kept in sync
 * manually, same precedent as that file's own duplicated SELECTOR_ACTIONS set) so EN mode
 * doesn't leak shared/triage.ts's raw Vietnamese reason text. */
export function localizedTriageReason(t: T, triageClass: TriageClass, input: TriageInput): string {
  switch (triageClass) {
    case "flake":
      return t("triage.reason.flake", { attempts: input.attempts ?? "?" });
    case "badSelector":
      return input.selectorMatchCount === 0
        ? t("triage.reason.badSelectorNoMatch")
        : t("triage.reason.badSelectorAmbiguous", { n: input.selectorMatchCount ?? 0 });
    case "appChanged":
      return t("triage.reason.appChanged", { n: input.selectorMatchCount ?? 0 });
    case "wrongExpectedValue":
      return t("triage.reason.wrongExpectedValue");
    case "realAppBug":
    default:
      return t("triage.reason.realAppBug");
  }
}

export interface TriagePanelProps {
  summary: RunSummary;
  trace: Trace;
  flow: Flow;
  onClose: () => void;
}

const CLASS_BADGE: Record<TriageClass, string> = {
  realAppBug: "badge--fail",
  flake: "badge--neutral",
  badSelector: "badge--warn",
  appChanged: "badge--warn",
  wrongExpectedValue: "badge--warn",
};

/**
 * E22 spec AC1/AC2: every failed step of `summary` gets a fixed classification + fixed
 * next-action, plus a one-click bug export (AC3/AC4). No cross-run history is wired into this
 * panel yet (App.tsx only tracks the single most recent run) — `deriveTriageInput` is called
 * with no `otherSummaries`, so the "flake" class currently never fires from THIS live UI path
 * (the classifier and its cross-run flake signal ARE fully implemented and tested —
 * shared/triage.ts + src/triage-input.ts — this is a disclosed wiring gap, not a missing
 * capability).
 */
export default function TriagePanel({ summary, trace, flow, onClose }: TriagePanelProps) {
  const t = useT();
  const failed = failedSteps(summary);
  const traceByStepId = new Map(trace.steps.map((s) => [s.stepId, s]));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--triage" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.alert size={16} />
          <span className="modal__title">{t("triage.title")}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          {failed.length === 0 ? (
            <p className="faint" style={{ marginTop: 0 }}>{t("triage.noFailures")}</p>
          ) : (
            failed.map((step) => {
              const traceStep = traceByStepId.get(step.stepId);
              const input = deriveTriageInput(step, summary);
              const triage = classifyFailure(input);
              return (
                <TriageRow
                  key={step.stepId}
                  traceStep={traceStep}
                  triageClass={triage.triageClass}
                  reason={localizedTriageReason(t, triage.triageClass, input)}
                  nextAction={localizedNextAction(t, triage.triageClass)}
                  summary={summary}
                  trace={trace}
                  flow={flow}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function TriageRow({
  traceStep,
  triageClass,
  reason,
  nextAction,
  summary,
  trace,
  flow,
}: {
  traceStep: TraceStep | undefined;
  triageClass: TriageClass;
  reason: string;
  nextAction: string;
  summary: RunSummary;
  trace: Trace;
  flow: Flow;
}) {
  const t = useT();
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  async function handleExport() {
    setExporting(true);
    setExportMessage(null);
    try {
      const input: BugBundleInput = {
        summary,
        trace,
        triage: { triageClass, nextAction, reason },
        environment: {
          runId: summary.runId,
          platform: flow.app.platform,
          bundleId: summary.bundleId,
          udid: summary.udid,
        },
      };
      const entries = await buildBugBundleEntries(input);
      // Default target: generic zip+markdown (AC4's config-driven default). A settings surface
      // to switch to the Jira adapter isn't built in this pass — src/bug-export.ts's
      // getExportTarget()/BugExportConfig plumbing supports it fully (tested), just not yet
      // exposed as a UI control here.
      const target = getExportTarget({ target: "generic-zip" });
      const result = await target.export(entries, input);
      setExportMessage(result.detail);
    } catch (err) {
      setExportMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="triage-row">
      <div className="triage-row__header">
        <span className="mono">{traceStep?.label ?? "?"}</span>
        <span className={`badge ${CLASS_BADGE[triageClass]}`}>{t(`triage.class.${triageClass}`)}</span>
      </div>
      <div className="triage-row__reason">{reason}</div>
      <div className="triage-row__next-action">
        <Icon.info size={13} /> {nextAction}
      </div>
      {traceStep && (traceStep.beforeScreenshot || traceStep.afterScreenshot) && (
        <div className="triage-row__screens">
          {traceStep.beforeScreenshot && (
            <img className="triage-row__screen" src={artifactUrl(traceStep.beforeScreenshot)} alt={t("triage.beforeScreenshotAlt")} />
          )}
          {traceStep.afterScreenshot && (
            <img className="triage-row__screen" src={artifactUrl(traceStep.afterScreenshot)} alt={t("triage.afterScreenshotAlt")} />
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 8, alignItems: "center" }}>
        <button className="btn btn--sm btn--primary" onClick={handleExport} disabled={exporting}>
          {exporting ? <span className="spinner" /> : <Icon.export size={13} />}
          {t("triage.exportButton")}
        </button>
        {exportMessage && <span className="faint" style={{ fontSize: 12 }}>{exportMessage}</span>}
      </div>
    </div>
  );
}
