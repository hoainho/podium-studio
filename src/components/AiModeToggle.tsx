import { isAiEnabled, type AiMode } from "../ai-provider.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface AiModeToggleProps {
  mode: AiMode;
  onChange: (mode: AiMode) => void;
  disabled?: boolean;
}

/**
 * Strict/Adaptive mode toggle (E24 spec: "Strict/Adaptive mode UX toggle (AI fully unavailable
 * in Strict; rungs 0-3 from E19 still apply there)"). Defaults to Strict everywhere it's used
 * (AI OFF by default, non-negotiable #1) — this component itself never silently switches modes;
 * it only ever reflects/changes whatever `mode` its caller already holds.
 */
export default function AiModeToggle({ mode, onChange, disabled }: AiModeToggleProps) {
  const t = useT();
  const adaptive = isAiEnabled(mode);

  return (
    <div className="ai-mode-toggle">
      <div className="ai-mode-toggle__header">
        <span className={`badge ${adaptive ? "badge--warn" : "badge--ok"}`}>
          {adaptive ? t("aiSettings.modeAdaptiveBadge") : t("aiSettings.modeStrictBadge")}
        </span>
        <div className="row" role="radiogroup" aria-label={t("aiSettings.modeToggleAria")} style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn--sm${!adaptive ? " btn--primary" : " btn--ghost"}`}
            onClick={() => onChange("strict")}
            disabled={disabled}
            aria-pressed={!adaptive}
          >
            {t("aiSettings.strictButton")}
          </button>
          <button
            type="button"
            className={`btn btn--sm${adaptive ? " btn--primary" : " btn--ghost"}`}
            onClick={() => onChange("adaptive")}
            disabled={disabled}
            aria-pressed={adaptive}
          >
            {t("aiSettings.adaptiveButton")}
          </button>
        </div>
      </div>

      <div className="hint-banner" style={{ marginTop: 8 }}>
        <Icon.info size={14} />
        <span>{t("aiSettings.aiOffByDefaultHint")}</span>
      </div>

      {adaptive && (
        <div className="ai-mode-toggle__enables">
          <div className="faint" style={{ fontWeight: 600, marginBottom: 4 }}>{t("aiSettings.adaptiveEnablesTitle")}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li className="faint" style={{ fontSize: 12.5, marginBottom: 4 }}>{t("aiSettings.adaptiveEnables.rung4")}</li>
            <li className="faint" style={{ fontSize: 12.5, marginBottom: 4 }}>{t("aiSettings.adaptiveEnables.copilot")}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
