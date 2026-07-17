import { useEffect, useState } from "react";
import type { Flow } from "../../shared/ir.ts";
import { useEscToClose } from "../use-esc-to-close.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";
import { testAiProvider } from "../api.ts";
import CoPilotReviewDiff from "./CoPilotReviewDiff.tsx";

export interface DescribeTestPromptProps {
  /** Base flow context for the draft (an empty new flow, per the Phase A spec — the QA can still
   * "add more steps to this" later the same way the buried Steps-editor co-pilot entry already
   * does with an in-progress flow). */
  flow: Flow;
  /** Connected AI provider's display name, same convention as everywhere else this is threaded
   * through (App.tsx's `aiProviderName`) — null/undefined falls back to a generic "AI". */
  providerName?: string | null;
  onApply: (flow: Flow) => void;
  onClose: () => void;
  /** "Connect AI first" card's button — the caller opens the existing AiSettingsPanel. */
  onOpenAiSettings: () => void;
}

type Status = "checking" | "connected" | "disconnected";

/**
 * "Describe it" front door of the Create-a-test launcher (Phase A spec AC3). Whether a provider
 * is even reachable is checked ONCE up front via the existing `testAiProvider()` (a real minimal
 * call against the primary authoring provider, same "Test connection" contract AiSettingsPanel's
 * ProviderConfigPanel already uses) — catching that failure here, BEFORE the QA ever types a
 * prompt, is what lets this be a genuinely friendly fallback instead of a wasted draft attempt
 * that dead-ends in a raw error.
 *
 * When a provider IS connected, this renders the EXISTING CoPilotReviewDiff verbatim — it already
 * IS "a plain-language prompt textarea → copilotDraftFlow → hunk-by-hunk review diff for accept/
 * reject" (src/components/CoPilotReviewDiff.tsx), so re-implementing that pipeline here would only
 * duplicate it and make the QA type their prompt twice. This component's own job is narrow: the
 * connectivity gate + the friendly "connect AI first" card — never a dead end, the other two
 * launcher paths (Record/Template) stay available regardless (spec: "never a dead end").
 */
export default function DescribeTestPrompt({
  flow,
  providerName,
  onApply,
  onClose,
  onOpenAiSettings,
}: DescribeTestPromptProps) {
  const t = useT();
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    testAiProvider()
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? "connected" : "disconnected");
      })
      .catch(() => {
        if (!cancelled) setStatus("disconnected");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // CoPilotReviewDiff owns its own close/backdrop behavior once connected; Esc here only needs to
  // apply to OUR two stages (checking/disconnected).
  useEscToClose(onClose, status !== "connected");

  if (status === "connected") {
    return <CoPilotReviewDiff flow={flow} providerName={providerName} onApply={onApply} onClose={onClose} />;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.wand size={16} />
          <span className="modal__title">{t("createTest.describe.title")}</span>
          <button
            className="btn btn--ghost btn--icon"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label={t("common.closeAria")}
          >
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          {status === "checking" ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" /> {t("createTest.describe.checking")}
            </div>
          ) : (
            <div>
              <p style={{ marginTop: 0 }}>{t("createTest.describe.connectAi.message")}</p>
              <p className="faint">{t("createTest.describe.connectAi.hint")}</p>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn--primary" onClick={onOpenAiSettings}>
                  <Icon.key size={13} />
                  {t("createTest.describe.connectAi.button")}
                </button>
                <button className="btn btn--ghost" onClick={onClose}>
                  {t("createTest.describe.connectAi.closeButton")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
