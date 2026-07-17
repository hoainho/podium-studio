import { useEffect, useState } from "react";
import { useEscToClose } from "../use-esc-to-close.ts";
import type { AiMode } from "../ai-provider.ts";
import { getAiMode, setAiMode as apiSetAiMode } from "../api.ts";
import { friendlyApiError } from "../friendly.ts";
import AiModeToggle from "./AiModeToggle.tsx";
import ProviderConfigPanel from "./ProviderConfigPanel.tsx";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface AiSettingsPanelProps {
  onClose: () => void;
}

/**
 * Combined "AI & Providers" settings surface (E24): Strict/Adaptive toggle up top (always
 * visible, defaults to Strict — AI OFF by default, non-negotiable #1), provider registry +
 * routing below (configurable regardless of mode — a QA can set up providers ahead of time
 * without that alone turning AI on; only the mode switch does that).
 */
export default function AiSettingsPanel({ onClose }: AiSettingsPanelProps) {
  useEscToClose(onClose);
  const t = useT();
  const [mode, setMode] = useState<AiMode>("strict");
  // The raw thrown error (usually an api.ts `ApiError`) — rendered through `friendlyApiError`
  // below so a missing/unwired /api/ai/mode endpoint shows a calm localized sentence instead of
  // a raw "404 Not Found" (always English regardless of the active locale).
  const [modeError, setModeError] = useState<unknown>(null);

  useEffect(() => {
    getAiMode()
      .then((res) => setMode(res.mode))
      .catch((err) => setModeError(err));
  }, []);

  async function handleModeChange(next: AiMode) {
    const previous = mode;
    setMode(next); // optimistic — this is a local settings toggle, not a run-affecting action
    setModeError(null);
    try {
      const res = await apiSetAiMode(next);
      setMode(res.mode);
    } catch (err) {
      setMode(previous);
      setModeError(err);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--ai-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.wand size={16} />
          <span className="modal__title">{t("aiSettings.title")}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          <AiModeToggle mode={mode} onChange={handleModeChange} />
          {modeError != null && (
            <div className="error-banner" role="alert" style={{ marginTop: 8 }}>
              <Icon.alert size={14} />
              <div>{friendlyApiError(t, modeError)}</div>
            </div>
          )}
          <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--border)" }} />
          <ProviderConfigPanel />
        </div>
      </div>
    </div>
  );
}
