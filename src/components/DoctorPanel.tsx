import { useEffect, useState } from "react";
import { getDoctor } from "../api.ts";
import type { DoctorCheck, DoctorCheckId, DoctorReport } from "../../shared/protocol.ts";
import { useT } from "../i18n/index.tsx";
import { friendlyApiError } from "../friendly.ts";
import { Icon } from "./icons.tsx";

const COPY_FEEDBACK_MS = 1500;

type T = (path: string, vars?: Record<string, string | number>) => string;

/** Every DoctorCheckId this panel has an i18n entry for (src/i18n/locales/{vi,en}.ts's
 * `doctorPanel.checks`) — kept as a runtime Set since DoctorCheckId is a compile-time-only
 * type. An id outside this set (e.g. a future check bridge/doctor.ts adds before this list
 * is updated) falls back to the bridge's own raw label/fixVi rather than a missing-key string. */
const KNOWN_DOCTOR_CHECK_IDS = new Set<DoctorCheckId>([
  "xcodeClt", "idb", "jre", "simulatorBoot", "podiumEngine",
  "androidSdk", "adb", "androidEmulatorBoot", "androidRealDevice",
]);

export function doctorCheckLabel(t: T, c: DoctorCheck): string {
  return KNOWN_DOCTOR_CHECK_IDS.has(c.id) ? t(`doctorPanel.checks.${c.id}.label`) : c.label;
}

/** bridge/doctor.ts's checkAndroidRealDevice returns 3-4 DIFFERENT Vietnamese fixVi messages for
 * this one id depending on sub-state (no device / unauthorized / not ready / adb exec failure) —
 * `fixCode` (task #48, a follow-up to #47) disambiguates which one, so this id's fix hint is
 * localized per sub-state instead of flattened into one generic string. Falls back to the raw
 * bridge fixVi if a future bridge build ever omits fixCode (old client / new bridge skew). */
export function doctorCheckFix(t: T, c: DoctorCheck): string | undefined {
  if (!c.fixVi) return undefined;
  if (!KNOWN_DOCTOR_CHECK_IDS.has(c.id)) return c.fixVi;
  if (c.id === "androidRealDevice") {
    return c.fixCode ? t(`doctorPanel.checks.androidRealDevice.fix.${c.fixCode}`) : c.fixVi;
  }
  return t(`doctorPanel.checks.${c.id}.fix`);
}

/**
 * A plain-language sentence for a failing check — what's wrong and what it means — with none
 * of `doctorCheckFix`'s Terminal-command jargon (QA-D friendliness audit, D-3: "Doctor scary
 * wall"). Undefined for any id this panel doesn't have copy for (an unrecognized bridge id, or
 * androidRealDevice missing its fixCode) — DoctorPanel falls back to showing just the raw
 * `doctorCheckFix` text in that case, same as before this explain layer existed.
 */
export function doctorCheckExplain(t: T, c: DoctorCheck): string | undefined {
  if (!c.fixVi || !KNOWN_DOCTOR_CHECK_IDS.has(c.id)) return undefined;
  if (c.id === "androidRealDevice") {
    return c.fixCode ? t(`doctorPanel.checks.androidRealDevice.explain.${c.fixCode}`) : undefined;
  }
  return t(`doctorPanel.checks.${c.id}.explain`);
}

/**
 * DoctorPanel — Environment Doctor (E5): a self-contained red/green preflight for the
 * toolchain Podium Studio depends on (Xcode CLT, idb, JRE, a booted simulator, the
 * pinned Podium engine). Fetches its own report; every red check shows its actionable
 * Vietnamese fix inline (spec AC6).
 */
export default function DoctorPanel() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Which checks currently have their raw command expanded — a per-check id Set so more than
  // one "Show command" can be open at once (D-3: the command is folded behind this toggle,
  // not the first thing shown, since it's for whoever helps a non-technical QA out, not the
  // QA themselves).
  const [openCommands, setOpenCommands] = useState<Set<DoctorCheckId>>(new Set());
  const [copiedId, setCopiedId] = useState<DoctorCheckId | null>(null);
  const t = useT();

  function toggleCommand(id: DoctorCheckId) {
    setOpenCommands((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyCommand(id: DoctorCheckId, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), COPY_FEEDBACK_MS);
    } catch {
      /* clipboard unavailable (permissions/private mode) — the command is still visible to select by hand */
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setReport(await getDoctor());
    } catch (err) {
      setError(friendlyApiError(t, err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="panel">
      <div className="panel__header">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <Icon.down size={13} /> : <Icon.up size={13} />}
        </button>
        <span className="panel__title">{t("doctorPanel.title")}</span>
        <span
          className={`dot ${report ? (report.ok ? "dot--ok" : "dot--fail") : "dot--pending"}`}
          title={
            report
              ? report.ok
                ? t("doctorPanel.allGreenTitle")
                : t("doctorPanel.someRedTitle")
              : t("doctorPanel.notYetRunTitle")
          }
        />
        <button
          className="btn btn--ghost btn--icon"
          onClick={refresh}
          disabled={loading}
          aria-label={t("doctorPanel.rerunAria")}
          title={t("doctorPanel.rerunTitle")}
        >
          {loading ? <span className="spinner" /> : <Icon.refresh />}
        </button>
      </div>

      {open && (
        <>
          {error && (
            <div className="error-banner" role="alert">
              <Icon.alert size={14} />
              <span>{error}</span>
            </div>
          )}

          {report && (
            <>
              <div className="faint" style={{ padding: "4px 4px 8px" }}>
                {t("doctorPanel.summary", {
                  passed: report.checks.filter((c) => c.ok).length,
                  total: report.checks.length,
                  ms: report.durationMs,
                })}
              </div>
              <div className="device-list">
                {report.checks.map((c) => {
                  // A red check that's `optional` (R2 follow-up) doesn't block overall usability —
                  // it belongs to a platform toolchain the machine isn't relying on, because the
                  // OTHER platform is already fully green (DoctorReport.platforms). Shown as a
                  // muted/neutral dot + an explicit "(không bắt buộc)" label instead of the same
                  // alarming red a genuinely blocking check gets, so a QA doesn't chase down an
                  // Android SDK install on a machine that only ever runs iOS, or vice versa.
                  const optionalRed = !c.ok && c.optional;
                  return (
                    <div key={c.id} className="device-row">
                      <span
                        className={`dot ${c.ok ? "dot--ok" : optionalRed ? "dot--pending" : "dot--fail"}`}
                        aria-hidden="true"
                      />
                      <div className="device-row__main">
                        <span className="device-row__name" title={doctorCheckLabel(t, c)}>
                          {doctorCheckLabel(t, c)}
                          {optionalRed && <span className="faint"> {t("doctorPanel.optionalLabel")}</span>}
                        </span>
                        <span className="device-row__meta" title={c.detail}>{c.detail}</span>
                        {!c.ok && c.fixVi && (() => {
                          const explain = doctorCheckExplain(t, c);
                          const command = doctorCheckFix(t, c);
                          const showingCommand = openCommands.has(c.id);
                          return (
                            <>
                              <span className="hint-banner" style={{ marginTop: 4 }}>
                                <Icon.info size={13} />
                                <span>{explain ?? command}</span>
                              </span>
                              {explain && command && (
                                <div style={{ marginTop: 4 }}>
                                  <button
                                    type="button"
                                    className="linklike"
                                    onClick={() => toggleCommand(c.id)}
                                    aria-expanded={showingCommand}
                                  >
                                    {showingCommand ? t("doctorPanel.hideCommandLabel") : t("doctorPanel.showCommandLabel")}
                                  </button>
                                  {showingCommand && (
                                    <>
                                      <code className="tech-details">{command}</code>
                                      <div className="row" style={{ gap: 8, marginTop: 4, alignItems: "center" }}>
                                        <button
                                          type="button"
                                          className="btn btn--ghost btn--sm"
                                          onClick={() => copyCommand(c.id, command)}
                                        >
                                          <Icon.copy size={12} />{" "}
                                          {copiedId === c.id ? t("doctorPanel.copiedLabel") : t("doctorPanel.copyCommandButton")}
                                        </button>
                                        <span className="faint" style={{ fontSize: 11 }}>
                                          {t("doctorPanel.forwardHint")}
                                        </span>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
