import { useEffect, useRef, useState } from "react";
import type { Flow } from "../../shared/ir.ts";
import type { RunEvent, RunSummary, StepStatus } from "../../shared/protocol.ts";
import { artifactUrl, cancelRun, connectRunEvents, loadFlow as apiLoadFlow, runFlow, runWebFlow } from "../api.ts";
import { friendlyRunError } from "../friendly.ts";
import { localizedStepDescription } from "../step-desc.ts";
import HealApprovalPrompt from "./HealApprovalPrompt.tsx";
import { useT } from "../i18n/index.tsx";
import { prepareFlowForRun } from "../prepare-run.ts";
import { Icon } from "./icons.tsx";

export interface RunPanelProps {
  activeUdid: string | null;
  deviceBooted: boolean;
  flow: Flow | null;
  flowValid: boolean;
  /** null = unknown (don't block); false = the target app is not installed on this device. */
  appInstalled?: boolean | null;
  appBundleId?: string | null;
  /** E18: open the trace/time-travel viewer for the just-completed run's summary. Omitted
   * entirely (no button rendered) when the caller doesn't wire it up. */
  onOpenTrace?: (summary: RunSummary) => void;
  /** E22: open the failure-triage panel for the just-completed run's summary. Omitted entirely
   * (no button rendered) when the caller doesn't wire it up. */
  onOpenTriage?: (summary: RunSummary) => void;
}

interface RowState {
  index: number;
  stepId: string;
  action: string;
  label: string;
  status: StepStatus;
  detail?: string;
  error?: string;
  screenshot?: string;
}

function statusBadgeClass(status: StepStatus): string {
  switch (status) {
    case "passed":
      return "badge--ok";
    case "failed":
      return "badge--fail";
    // A soft-failed step (E2 AC5, a `soft`-flagged step that failed) is a non-blocking
    // warning, not a hard stop — amber, distinct from the red hard-fail badge.
    case "failed-soft":
      return "badge--warn";
    case "running":
      return "badge--running";
    case "skipped":
      return "badge--neutral";
    default:
      return "badge--pending";
  }
}

function statusDotClass(status: StepStatus): string {
  switch (status) {
    case "passed":
      return "dot--ok";
    case "failed":
      return "dot--fail";
    case "failed-soft":
      return "dot--warn";
    case "running":
      return "dot--running";
    default:
      return "dot--pending";
  }
}

export default function RunPanel({ activeUdid, deviceBooted, flow, flowValid, appInstalled, appBundleId, onOpenTrace, onOpenTriage }: RunPanelProps) {
  const t = useT();
  // Web-target UI: a RUN-TIME choice of where to run the open flow, never a flow field —
  // `flow.app.platform` (shared/ir.ts) stays locked to "ios-sim" regardless of this toggle.
  const [target, setTarget] = useState<"simulator" | "web">("simulator");
  const [webUrl, setWebUrl] = useState("");
  const [rows, setRows] = useState<RowState[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showRunRaw, setShowRunRaw] = useState(false);
  const [rawRows, setRawRows] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const disconnectRef = useRef<(() => void) | null>(null);
  // The in-flight run's id, learned from the "run:start" WS event — required to cancel it (P0-1).
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => disconnectRef.current?.();
  }, []);

  // Close the evidence viewer on Escape.
  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  const appMissing = appInstalled === false;
  // Web target needs no simulator/device at all — a real browser is launched per run instead
  // (bridge/browser-driver.ts's runBrowserSuite, same one /api/browser-suite already uses).
  const canRun =
    target === "web"
      ? !!flow && flowValid && !running
      : !!activeUdid && deviceBooted && !!flow && flowValid && !running && !appMissing;

  function handleEvent(e: RunEvent) {
    switch (e.type) {
      case "step:start":
        setRows((prev) =>
          prev.map((r) => (r.index === e.index ? { ...r, status: "running" } : r)),
        );
        break;
      case "step:result":
        setRows((prev) =>
          prev.map((r) =>
            r.index === e.result.index
              ? {
                  ...r,
                  status: e.result.status,
                  detail: e.result.detail,
                  error: e.result.error,
                  screenshot: e.result.screenshot,
                }
              : r,
          ),
        );
        break;
      case "run:end":
        setSummary(e.summary);
        setRunning(false);
        setCancelling(false);
        runIdRef.current = null;
        disconnectRef.current?.();
        disconnectRef.current = null;
        break;
      case "log":
        setLogs((prev) => [...prev.slice(-40), `[${e.level}] ${e.message}`]);
        break;
      case "run:start":
        runIdRef.current = e.runId;
        break;
      default:
        break;
    }
  }

  async function handleRun() {
    if (!flow) return;
    if (target === "simulator" && !activeUdid) return;
    setSummary(null);
    setRunError(null);
    setShowRunRaw(false);
    setRawRows({});
    setLogs([]);
    setCancelling(false);
    setRunning(true);

    // E13: expand callSubFlow calls + resolve selector-library refs BEFORE dispatch — fail
    // closed (refuse to run) on any error, exactly the "blocked at pre-run lint, not at
    // runtime" contract spec AC5 asks for. The QA sees the REAL, expanded step list in the
    // timeline below — never the collapsed callSubFlow placeholder — since `rows` is built
    // from the expanded flow, not the one they authored.
    const resolveFlowFile = async (file: string) => {
      try {
        return await apiLoadFlow(file);
      } catch {
        return undefined;
      }
    };
    const prepared = await prepareFlowForRun(flow, resolveFlowFile);
    if (prepared.errors.length > 0) {
      setRunError(prepared.errors.join(" "));
      setRunning(false);
      return;
    }
    const expandedFlow = prepared.flow;

    const enabled = expandedFlow.steps.filter((s) => !s.disabled);
    setRows(
      enabled.map((s, index) => ({
        index,
        stepId: s.id,
        action: s.action,
        label: localizedStepDescription(t, s),
        status: "pending",
      })),
    );

    disconnectRef.current?.();
    disconnectRef.current = connectRunEvents(handleEvent);

    try {
      const result =
        target === "web"
          ? await runWebFlow(expandedFlow, webUrl.trim() || undefined)
          : await runFlow({ udid: activeUdid as string, flow: expandedFlow });
      setSummary(result);
      // Reconcile from the HTTP summary so it's the source of truth even if some WS
      // step events were missed — no row can be left stuck on "pending".
      setRows((prev) => {
        const byId = new Map(prev.map((r) => [r.stepId, r]));
        return result.results.map((res) => {
          const existing = byId.get(res.stepId);
          return {
            index: res.index,
            stepId: res.stepId,
            action: res.action,
            label: existing?.label ?? res.action,
            status: res.status,
            detail: res.detail,
            error: res.error,
            screenshot: res.screenshot ?? existing?.screenshot,
          };
        });
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setCancelling(false);
      runIdRef.current = null;
      disconnectRef.current?.();
      disconnectRef.current = null;
    }
  }

  async function handleStop() {
    if (!running || cancelling) return;
    const runId = runIdRef.current;
    if (!runId) {
      // run:start hasn't arrived yet (very early) — nothing to target; let it settle.
      return;
    }
    setCancelling(true);
    try {
      await cancelRun(runId);
      // Success: the bridge stops after the current step and emits run:end, which resets state.
    } catch {
      // Cancel failed (e.g. the run already finished) — clear the cancelling flag so the button
      // isn't stuck; `running` is left as-is because the run:end/finally path is the source of
      // truth for it (P0-1: previously this left the UI permanently stuck).
      setCancelling(false);
    }
  }

  return (
    <div>
      <div className="panel">
        <div className="run-header">
          <div className="row">
            <span className="panel__title">{t("runPanel.title")}</span>
            <div className="spacer" />
            {running && (
              <button className="btn btn--danger" onClick={handleStop} disabled={cancelling}>
                {cancelling ? <span className="spinner" /> : <Icon.stop size={13} />}
                {cancelling ? t("runPanel.stoppingButton") : t("runPanel.stopButton")}
              </button>
            )}
            <button className="btn btn--primary" onClick={handleRun} disabled={!canRun}>
              {running ? <span className="spinner" /> : <Icon.play size={13} />}
              {t("runPanel.runButton")}
            </button>
          </div>

          <div className="row" role="radiogroup" aria-label={t("runPanel.targetToggleAria")} style={{ gap: 6, marginTop: 8 }}>
            <span className="field__label" style={{ marginRight: 2 }}>{t("runPanel.targetLabel")}</span>
            <button
              type="button"
              className={`btn btn--sm${target === "simulator" ? " btn--primary" : " btn--ghost"}`}
              onClick={() => setTarget("simulator")}
              disabled={running}
              aria-pressed={target === "simulator"}
            >
              {t("runPanel.targetSimulator")}
            </button>
            <button
              type="button"
              className={`btn btn--sm${target === "web" ? " btn--primary" : " btn--ghost"}`}
              onClick={() => setTarget("web")}
              disabled={running}
              aria-pressed={target === "web"}
            >
              {t("runPanel.targetWeb")}
            </button>
          </div>

          {target === "web" && (
            <div className="field" style={{ marginTop: 8 }}>
              <label className="field__label" htmlFor="run-web-url-input">
                {t("runPanel.webUrlLabel")}
              </label>
              <input
                id="run-web-url-input"
                className="input mono"
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
                placeholder={t("runPanel.webUrlPlaceholder")}
                spellCheck={false}
                disabled={running}
              />
            </div>
          )}

          {target === "simulator" && !activeUdid && (
            <div className="hint-banner"><Icon.info size={14} /><span>{t("runPanel.hintPickSimulator")}</span></div>
          )}
          {target === "simulator" && activeUdid && !deviceBooted && (
            <div className="hint-banner"><Icon.info size={14} /><span>{t("runPanel.hintNotStarted")}</span></div>
          )}
          {!flow && <div className="hint-banner"><Icon.info size={14} /><span>{t("runPanel.hintNoTest")}</span></div>}
          {flow && !flowValid && (
            <div className="hint-banner"><Icon.info size={14} /><span>{t("runPanel.hintFinishSteps")}</span></div>
          )}
          {target === "simulator" && flow && flowValid && deviceBooted && appMissing && (
            <div className="error-banner" role="alert">
              <Icon.alert size={14} />
              <span>
                {t("runPanel.appNotInstalledPrefix")} <code>{appBundleId}</code>{" "}
                {t("runPanel.appNotInstalledSuffix")}
              </span>
            </div>
          )}
          {runError && (
            <div className="error-banner error-banner--column" role="alert">
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <Icon.alert size={14} />
                <span>{friendlyRunError(t, runError)}</span>
              </div>
              <button
                type="button"
                className="linklike"
                onClick={() => setShowRunRaw((v) => !v)}
                aria-expanded={showRunRaw}
              >
                {showRunRaw ? t("common.hideTechDetails") : t("common.showTechDetails")}
              </button>
              {showRunRaw && <code className="tech-details">{runError}</code>}
            </div>
          )}

          {summary && (
            <div className={`run-banner ${summary.passed ? "run-banner--pass" : "run-banner--fail"}`}>
              {summary.passed ? <Icon.check size={16} /> : <Icon.x size={16} />}
              <span>{summary.passed ? t("runPanel.passedLabel") : t("runPanel.failedLabel")}</span>
              <span className="run-banner__stats">
                {t("runPanel.statsLabel", {
                  passed: summary.passedCount,
                  total: summary.total,
                  seconds: (summary.durationMs / 1000).toFixed(1),
                })}
              </span>
              {/* Actions grouped so they wrap to their own line as a unit in the narrow run rail
                  instead of the last one ("Triage failures") clipping off the edge. */}
              {(onOpenTrace || (onOpenTriage && summary.failedCount + summary.softFailedCount > 0)) && (
                <div className="run-banner__actions">
                  {onOpenTrace && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenTrace(summary)}>
                      <Icon.clock size={13} />
                      {t("trace.viewButton")}
                    </button>
                  )}
                  {onOpenTriage && summary.failedCount + summary.softFailedCount > 0 && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenTriage(summary)}>
                      <Icon.alert size={13} />
                      {t("triage.openButton")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {summary && <HealApprovalPrompt results={summary.results} />}
        </div>
      </div>

      <div className="panel" style={{ flex: 1 }}>
        <div className="panel__title" style={{ marginBottom: 10 }}>
          {t("runPanel.timelineTitle")}
        </div>

        {rows.length === 0 && (
          <div className="empty-state" style={{ padding: "24px 4px" }}>
            <div className="empty-state__title">{t("runPanel.noRun")}</div>
            <div className="empty-state__hint">{t("runPanel.noRunHint")}</div>
          </div>
        )}

        <div className="timeline">
          {rows.map((r) => (
            <div className="timeline-row" key={r.stepId}>
              <button
                className="timeline-row__thumb"
                onClick={() => r.screenshot && setEnlarged(r.screenshot)}
                disabled={!r.screenshot}
                aria-label={r.screenshot ? t("runPanel.enlargeAria") : t("runPanel.noScreenshotAria")}
              >
                {r.screenshot ? (
                  <img src={artifactUrl(r.screenshot)} alt="" />
                ) : (
                  <Icon.camera size={14} />
                )}
              </button>
              <div className="timeline-row__body">
                <div className="timeline-row__title">
                  <span className={`dot ${statusDotClass(r.status)}`} />
                  <span className="timeline-row__label" title={r.label}>{r.label}</span>
                  <span className={`badge ${statusBadgeClass(r.status)}`}>{t(`common.stepStatus.${r.status}`)}</span>
                </div>
                {r.error ? (
                  <div className="timeline-row__detail timeline-row__detail--error">
                    <div>{friendlyRunError(t, r.error)}</div>
                    <button
                      type="button"
                      className="linklike"
                      onClick={() =>
                        setRawRows((prev) => ({ ...prev, [r.stepId]: !prev[r.stepId] }))
                      }
                      aria-expanded={!!rawRows[r.stepId]}
                    >
                      {rawRows[r.stepId] ? t("common.hideTechDetails") : t("common.showTechDetails")}
                    </button>
                    {rawRows[r.stepId] && <code className="tech-details">{r.error}</code>}
                  </div>
                ) : r.detail ? (
                  <div className="timeline-row__detail">{r.detail}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {logs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="linklike"
              onClick={() => setShowLogs((v) => !v)}
              aria-expanded={showLogs}
            >
              {showLogs ? t("runPanel.hideLog") : t("runPanel.showLog", { n: logs.length })}
            </button>
            {showLogs && (
              <div className="run-log" style={{ marginTop: 8 }}>
                {logs.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {enlarged && (
        <div className="modal-backdrop" onClick={() => setEnlarged(null)}>
          <div className="modal modal--image" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <span className="modal__title">{t("runPanel.evidenceTitle")}</span>
              <button
                className="btn btn--ghost btn--icon"
                style={{ marginLeft: "auto" }}
                onClick={() => setEnlarged(null)}
                aria-label={t("common.closeAria")}
              >
                <Icon.x size={14} />
              </button>
            </div>
            <div className="modal__body">
              <img src={artifactUrl(enlarged)} alt="Step screenshot evidence" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
