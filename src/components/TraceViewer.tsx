import { useState } from "react";
import { artifactUrl } from "../api.ts";
import { traceToJson, type Trace } from "../trace.ts";
import { useT } from "../i18n/index.tsx";
import { renderStepDescriptor } from "../step-desc.ts";
import { Icon } from "./icons.tsx";

export interface TraceViewerProps {
  /** One trace for a single-flow run, or several for a tagged suite (spec AC3: "one merged
   * trace/report covering every worker's flows, correctly attributed per flow" — each entry
   * here is one flow's own trace; rendering them together under their own flow-name heading
   * IS the merged view, no server-side merge needed since each is independently correct). */
  traces: Trace[];
  onClose: () => void;
}

function statusDotClass(status: string): string {
  switch (status) {
    case "passed": return "dot--ok";
    case "failed": return "dot--fail";
    case "failed-soft": return "dot--warn";
    case "running": return "dot--running";
    default: return "dot--pending";
  }
}

/**
 * TraceViewer — trace/time-travel viewer (E18 spec AC2/AC3). Scrubbable: pick any step in the
 * list and see exactly that step's before/after screenshot, status, duration, and captured
 * variable — never a reconstructed/approximated state, every field is copied straight from the
 * real StepResult (see src/trace.ts's buildTrace).
 */
export default function TraceViewer({ traces, onClose }: TraceViewerProps) {
  const t = useT();
  const [traceIndex, setTraceIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);

  const trace = traces[traceIndex];
  const step = trace?.steps[stepIndex];

  function downloadTrace() {
    if (!trace) return;
    const blob = new Blob([traceToJson(trace)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trace-${trace.runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--trace" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.clock size={16} />
          <span className="modal__title">{t("trace.title")}</span>
          <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={downloadTrace}>
            <Icon.export size={13} />
            {t("trace.downloadButton")}
          </button>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>

        <div className="modal__body trace-viewer">
          {traces.length > 1 && (
            <div className="row" role="tablist" style={{ gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
              {traces.map((tr, i) => (
                <button
                  key={tr.runId}
                  type="button"
                  role="tab"
                  aria-selected={i === traceIndex}
                  className={`btn btn--sm${i === traceIndex ? " btn--primary" : " btn--ghost"}`}
                  onClick={() => {
                    setTraceIndex(i);
                    setStepIndex(0);
                  }}
                >
                  <span className={`dot ${tr.passed ? "dot--ok" : "dot--fail"}`} />
                  {tr.flowName}
                </button>
              ))}
            </div>
          )}

          {!trace || trace.steps.length === 0 ? (
            <div className="empty-state" style={{ padding: "20px 4px" }}>
              <div className="empty-state__title">{t("trace.empty")}</div>
            </div>
          ) : (
            <div className="trace-viewer__layout">
              <div className="trace-viewer__list" role="list" aria-label={t("trace.stepListAria")}>
                {trace.steps.map((s, i) => (
                  <button
                    key={s.stepId}
                    type="button"
                    role="listitem"
                    className={`trace-viewer__list-item${i === stepIndex ? " trace-viewer__list-item--active" : ""}`}
                    onClick={() => setStepIndex(i)}
                  >
                    <span className={`dot ${statusDotClass(s.status)}`} />
                    <span className="trace-viewer__list-index">{i + 1}</span>
                    <span className="trace-viewer__list-label">
                      {s.descriptor ? renderStepDescriptor(t, s.descriptor) : s.label}
                    </span>
                  </button>
                ))}
              </div>

              <div className="trace-viewer__detail">
                {step && (
                  <>
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <button
                        className="btn btn--sm btn--ghost"
                        onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                        disabled={stepIndex === 0}
                        aria-label={t("trace.prevStepAria")}
                      >
                        <Icon.up size={13} style={{ transform: "rotate(-90deg)" }} />
                      </button>
                      <span className="badge badge--neutral">
                        {t("trace.stepOfTotal", { n: stepIndex + 1, total: trace.steps.length })}
                      </span>
                      <button
                        className="btn btn--sm btn--ghost"
                        onClick={() => setStepIndex((i) => Math.min(trace.steps.length - 1, i + 1))}
                        disabled={stepIndex === trace.steps.length - 1}
                        aria-label={t("trace.nextStepAria")}
                      >
                        <Icon.down size={13} style={{ transform: "rotate(-90deg)" }} />
                      </button>
                      <span className={`badge ${statusDotClass(step.status) === "dot--ok" ? "badge--ok" : statusDotClass(step.status) === "dot--fail" ? "badge--fail" : "badge--warn"}`}>
                        {t(`common.stepStatus.${step.status}`)}
                      </span>
                      {step.durationMs !== undefined && (
                        <span className="faint">{t("trace.durationLabel", { ms: step.durationMs })}</span>
                      )}
                      {step.attempts !== undefined && step.attempts > 1 && (
                        <span className="badge badge--warn">{t("trace.attemptsLabel", { n: step.attempts })}</span>
                      )}
                      {step.healedRung && (
                        <span className="badge badge--accent">{t("heal.healedRungBadge", { rung: step.healedRung })}</span>
                      )}
                    </div>

                    <div className="trace-viewer__screens">
                      <div className="trace-viewer__screen">
                        <div className="faint" style={{ marginBottom: 4 }}>{t("trace.beforeLabel")}</div>
                        {step.beforeScreenshot ? (
                          <img src={artifactUrl(step.beforeScreenshot)} alt="" />
                        ) : (
                          <div className="trace-viewer__screen-empty">{t("trace.noScreenshot")}</div>
                        )}
                      </div>
                      <div className="trace-viewer__screen">
                        <div className="faint" style={{ marginBottom: 4 }}>{t("trace.afterLabel")}</div>
                        {step.afterScreenshot ? (
                          <img src={artifactUrl(step.afterScreenshot)} alt="" />
                        ) : (
                          <div className="trace-viewer__screen-empty">{t("trace.noScreenshot")}</div>
                        )}
                      </div>
                    </div>

                    {step.capturedName && (
                      <div className="hint-banner">
                        <Icon.variable size={14} />
                        <span>{t("trace.capturedLabel", { name: step.capturedName, value: step.capturedValue ?? "" })}</span>
                      </div>
                    )}

                    {step.error ? (
                      <div className="error-banner" role="alert">
                        <Icon.alert size={14} />
                        <span>{step.error}</span>
                      </div>
                    ) : step.detail ? (
                      <div className="faint">{step.detail}</div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
