import { useEffect, useMemo, useState } from "react";
import { useEscToClose } from "../use-esc-to-close.ts";
import { getRunHistory } from "../api.ts";
import {
  computeFlakinessReport,
  effectiveQuarantineState,
  type FlakinessReport,
  type QuarantineOverride,
} from "../../shared/flakiness.ts";
import {
  getRemoteEndpoint,
  getTelemetryConsent,
  listTelemetryEvents,
  setRemoteEndpoint,
  setTelemetryConsent,
  type CrashEvent,
} from "../telemetry.ts";
import { getQuarantineOverride, setQuarantineOverride } from "../quarantine-store.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface QualityDashboardProps {
  onClose: () => void;
}

/**
 * E23 spec: opt-in crash telemetry settings (AC1/AC2) + cross-run flakiness trend/quarantine
 * (AC3/AC4), in one dashboard. Flow-level flakiness is computed from REAL run history via the
 * existing E9-backed `/api/db/runs` endpoint (src/api.ts's `getRunHistory`) — step-level history
 * has no read path exposed from bridge/ yet (disclosed gap, see this epic's completion notes),
 * so only flows appear here, not individual steps.
 */
export default function QualityDashboard({ onClose }: QualityDashboardProps) {
  useEscToClose(onClose);
  const t = useT();
  const [consent, setConsentState] = useState(() => getTelemetryConsent());
  const [endpoint, setEndpointState] = useState(() => getRemoteEndpoint() ?? "");
  const [events, setEvents] = useState<CrashEvent[]>(() => listTelemetryEvents());

  const [reports, setReports] = useState<FlakinessReport[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a manual quarantine toggle to force re-reading localStorage overrides.
  const [overrideVersion, setOverrideVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRunHistory(200)
      .then((history) => {
        if (cancelled) return;
        const byFlow = new Map<string, { runId: string; passed: boolean; startedAt: number }[]>();
        for (const run of history) {
          const list = byFlow.get(run.flowName) ?? [];
          list.push({ runId: run.runId, passed: run.passed, startedAt: run.startedAt });
          byFlow.set(run.flowName, list);
        }
        const computed = [...byFlow.entries()].map(([flowName, outcomes]) => computeFlakinessReport(flowName, outcomes));
        computed.sort((a, b) => b.flakyScore - a.flakyScore);
        setReports(computed);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleConsent(next: boolean) {
    setTelemetryConsent(next);
    setConsentState(next);
  }

  function saveEndpoint() {
    setRemoteEndpoint(endpoint.trim() || undefined);
  }

  function toggleQuarantine(key: string, current: boolean) {
    const next: QuarantineOverride = current ? "active" : "quarantined";
    setQuarantineOverride(key, next);
    setOverrideVersion((v) => v + 1);
  }

  const quarantinedKeys = useMemo(() => {
    if (!reports) return new Set<string>();
    const set = new Set<string>();
    for (const r of reports) {
      const override = getQuarantineOverride(r.key);
      if (effectiveQuarantineState(r, override)) set.add(r.key);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, overrideVersion]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--quality" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.info size={16} />
          <span className="modal__title">{t("quality.title")}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          <div className="add-step__group-label">{t("quality.telemetryTitle")}</div>
          <label className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input type="checkbox" checked={consent} onChange={(e) => toggleConsent(e.target.checked)} />
            {t("quality.telemetryOptIn")}
          </label>
          <p className="faint" style={{ marginTop: 0, fontSize: 12 }}>{t("quality.telemetryHint")}</p>
          {consent && (
            <>
              <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={endpoint}
                  onChange={(e) => setEndpointState(e.target.value)}
                  onBlur={saveEndpoint}
                  placeholder={t("quality.remoteEndpointPlaceholder")}
                />
              </div>
              <div className="faint" style={{ fontSize: 12, marginBottom: 14 }}>
                {t("quality.eventsCaptured", { n: events.length })}
              </div>
            </>
          )}

          <div className="add-step__group-label" style={{ marginTop: 14 }}>{t("quality.flakinessTitle")}</div>
          {loading ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" /> {t("quality.loading")}
            </div>
          ) : error ? (
            <div className="error-banner" role="alert">
              <Icon.alert size={14} />
              <div>{error}</div>
            </div>
          ) : !reports || reports.length === 0 ? (
            <div className="faint">{t("quality.noHistory")}</div>
          ) : (
            reports.map((report) => {
              const override = getQuarantineOverride(report.key);
              const quarantined = effectiveQuarantineState(report, override);
              return (
                <div key={report.key} className="flaky-row">
                  <div className="flaky-row__header">
                    <span className="mono">{report.key}</span>
                    {quarantined && <span className="badge badge--warn">{t("quality.quarantinedBadge")}</span>}
                  </div>
                  <div className="flaky-row__bar-track">
                    <div
                      className={`flaky-row__bar-fill${quarantined ? " flaky-row__bar-fill--quarantined" : ""}`}
                      style={{ width: `${Math.round(report.flakyScore * 100)}%` }}
                    />
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {t("quality.flakyStats", { failed: report.failedRuns, total: report.totalRuns, pct: Math.round(report.flakyScore * 100) })}
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ marginTop: 4 }}
                    onClick={() => toggleQuarantine(report.key, quarantined)}
                  >
                    {quarantined ? t("quality.unquarantineButton") : t("quality.quarantineButton")}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
