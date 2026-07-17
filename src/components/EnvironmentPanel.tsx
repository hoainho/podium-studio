import { useEffect, useState } from "react";
import { getEnvironment, getTestAccounts, setEnvironment, type EnvironmentState } from "../api.ts";
import type { EnvironmentName, SeedResetResult, TestAccountSummary } from "../../shared/protocol.ts";
import { useT } from "../i18n/index.tsx";
import { friendlyApiError } from "../friendly.ts";
import { Icon } from "./icons.tsx";
import { InfoTip } from "./InfoTip.tsx";

type T = (path: string, vars?: Record<string, string | number>) => string;

/**
 * Friendly label for one of the 3 fixed environment names ("Staging (stg)" instead of the raw
 * "stg") — QA-D friendliness audit: an abbreviation like "stg"/"qa"/"prod" doesn't explain
 * itself to a non-technical QA the way every other label in this panel does.
 */
export function environmentLabel(t: T, name: EnvironmentName): string {
  return t(`environmentPanel.envLabel.${name}`);
}

/**
 * Localizes a degraded SeedResetResult (task #48) — bridge/test-data.ts's runSeedResetHook
 * carries a stable `errorCode` + `errorParams` (data only, never a sentence) instead of baking
 * an English message on the wire; this resolves it through i18n. Returns undefined for a
 * successful result (nothing to show). No seed-reset UI is wired up in this panel yet (E11's own
 * scope note — a per-deployment editing task); this is the localization seam a future seed-reset
 * button in this panel would call, kept in sync with the wire contract now rather than later.
 */
export function localizedSeedResetError(t: T, result: SeedResetResult): string | undefined {
  if (!result.errorCode || !result.errorParams) return undefined;
  return t(`environmentPanel.seedReset.${result.errorCode}`, result.errorParams);
}

/**
 * EnvironmentPanel — Test-data & environment layer (E11): a self-contained stg/qa/prod
 * switcher. Switching here is a config-only change on the bridge — it never edits the open
 * flow (spec AC2). Also lists the test-account ROLES defined for the selected environment, so
 * a QA can see what a flow's `testAccountRole` fixture will resolve to — usernames only, never
 * a credential (a password is always shown as its still-unresolved `${secret:...}` reference).
 */
export default function EnvironmentPanel() {
  const [state, setState] = useState<EnvironmentState | null>(null);
  const [accounts, setAccounts] = useState<TestAccountSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const t = useT();

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const env = await getEnvironment();
      setState(env);
      const { accounts: a } = await getTestAccounts(env.current);
      setAccounts(a);
    } catch (err) {
      setError(friendlyApiError(t, err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSwitch(name: EnvironmentName) {
    if (!state || name === state.current) return;
    setSwitching(true);
    setError(null);
    try {
      const env = await setEnvironment(name);
      setState(env);
      const { accounts: a } = await getTestAccounts(env.current);
      setAccounts(a);
    } catch (err) {
      setError(friendlyApiError(t, err));
    } finally {
      setSwitching(false);
    }
  }

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
        <span className="panel__title">{t("environmentPanel.title")}</span>
        <span className="faint" style={{ marginLeft: "auto", fontSize: 12 }}>
          {state?.current ?? "…"}
        </span>
        <button
          className="btn btn--ghost btn--icon"
          onClick={refresh}
          disabled={loading}
          aria-label={t("environmentPanel.refreshAria")}
          title={t("environmentPanel.refreshTitle")}
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

          {state && (
            <>
              <div className="stack" style={{ padding: "4px 4px 8px" }}>
                <span className="field__label-row">
                  <span className="field__label">{t("environmentPanel.selectorLabel")}</span>
                  <InfoTip text={t("environmentPanel.envTip")} />
                </span>
                <div className="device-list">
                  {state.available.map((env) => (
                    <button
                      key={env.name}
                      type="button"
                      className={`btn btn--sm${env.name === state.current ? " btn--primary" : " btn--ghost"}`}
                      onClick={() => handleSwitch(env.name)}
                      disabled={switching}
                      title={env.baseUrl}
                    >
                      {environmentLabel(t, env.name)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="faint" style={{ padding: "4px 4px 8px" }}>
                {t("environmentPanel.accountsLabel")}
              </div>
              {accounts.length === 0 && (
                <div className="faint" style={{ padding: "0 4px 8px" }}>
                  {t("environmentPanel.noAccounts")}
                </div>
              )}
              <div className="device-list">
                {accounts.map((a) => (
                  <div className="device-row" key={a.role}>
                    <div className="device-row__main">
                      <span className="device-row__name" title={a.role}>{a.role}</span>
                      <span className="device-row__meta mono" title={a.username}>{a.username}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
