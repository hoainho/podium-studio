import { useState } from "react";
import type { Flow } from "../../shared/ir.ts";
import type { CoPilotSuggestion } from "../../shared/ai-types.ts";
import { acceptedCount, allHunksDecided, applyAcceptedHunks, type HunkDecision } from "../copilot-diff.ts";
import { copilotDraftFlow, copilotSuggestAssertions } from "../api.ts";
import { friendlyApiError } from "../friendly.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface CoPilotReviewDiffProps {
  /** The flow currently open in the editor — used as co-pilot context (suggest-assertions always
   * needs one; draft-a-flow uses it as an optional starting point, e.g. "add more steps to this"
   * rather than starting from scratch). */
  flow: Flow;
  /** Applies the merged flow into the editor for review — the SAME `onChange` path every other
   * edit in this app already goes through (StepEditor's own mutate/Save flow) — this component
   * NEVER calls `saveFlow` itself (AC7: "0 writes land... before an explicit per-hunk accept" —
   * and even after accepting, the QA still clicks the app's own normal Save button, same
   * "review, don't auto-persist" discipline E13's ComponentGallery/E21's BundleDiffMerge use). */
  onApply: (flow: Flow) => void;
  onClose: () => void;
  /** Connected AI provider's display name ("Gemini", "GPT", …) — the feature is labelled by
   * whatever's connected instead of a fixed "Co-pilot" brand. Falls back to a generic "AI". */
  providerName?: string | null;
}

type Stage = "prompt" | "loading" | "review" | "error";

/**
 * Authoring co-pilot review-diff (E24 spec AC7): draft-a-flow from a prose prompt, or suggest
 * assertions for the currently open flow — output is ALWAYS a hunk-by-hunk review diff, Accept/
 * Reject per hunk, never auto-saved.
 */
export default function CoPilotReviewDiff({ flow, onApply, onClose, providerName }: CoPilotReviewDiffProps) {
  const t = useT();
  const aiName = providerName || t("copilot.genericName");
  const [stage, setStage] = useState<Stage>("prompt");
  const [prompt, setPrompt] = useState("");
  const [suggestion, setSuggestion] = useState<CoPilotSuggestion | null>(null);
  const [decisions, setDecisions] = useState<Record<string, HunkDecision>>({});
  // Raw thrown error (usually an api.ts ApiError) — rendered via friendlyApiError so a co-pilot
  // failure (e.g. no reachable provider, bad key) shows a localized sentence, not raw English.
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState(false);

  async function runDraftFlow() {
    setStage("loading");
    setError(null);
    try {
      const result = await copilotDraftFlow(prompt, flow);
      setSuggestion(result);
      setDecisions({});
      setStage("review");
    } catch (err) {
      setError(err);
      setStage("error");
    }
  }

  async function runSuggestAssertions() {
    setStage("loading");
    setError(null);
    try {
      const result = await copilotSuggestAssertions(flow);
      setSuggestion(result);
      setDecisions({});
      setStage("review");
    } catch (err) {
      setError(err);
      setStage("error");
    }
  }

  function decide(hunkId: string, decision: HunkDecision) {
    setDecisions((prev) => ({ ...prev, [hunkId]: decision }));
  }

  function applyAccepted() {
    if (!suggestion) return;
    const merged = applyAcceptedHunks(flow, suggestion, decisions);
    onApply(merged);
    setApplied(true);
  }

  const accepted = suggestion ? acceptedCount(suggestion, decisions) : 0;
  const allDecided = suggestion ? allHunksDecided(suggestion, decisions) : false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--copilot" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.wand size={16} />
          <span className="modal__title">{t("copilot.title", { provider: aiName })}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          {stage === "prompt" && (
            <>
              <p className="faint" style={{ marginTop: 0 }}>{t("copilot.promptHint")}</p>
              <textarea
                className="input"
                style={{ width: "100%", minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("copilot.promptPlaceholder")}
              />
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn--primary" onClick={runDraftFlow} disabled={!prompt.trim()}>
                  <Icon.wand size={13} />
                  {t("copilot.draftFlowButton")}
                </button>
                <button className="btn btn--ghost" onClick={runSuggestAssertions}>
                  {t("copilot.suggestAssertionsButton")}
                </button>
              </div>
            </>
          )}

          {stage === "loading" && (
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" /> {t("copilot.loading", { provider: aiName })}
            </div>
          )}

          {stage === "error" && error != null && (
            <div>
              <div className="error-banner" role="alert">
                <Icon.alert size={14} />
                <div>{friendlyApiError(t, error)}</div>
              </div>
              <button className="btn btn--sm btn--ghost" style={{ marginTop: 10 }} onClick={() => setStage("prompt")}>
                {t("copilot.backButton")}
              </button>
            </div>
          )}

          {stage === "review" && suggestion && (
            <>
              <div className="faint" style={{ marginBottom: 8 }}>{suggestion.requestSummary}</div>
              {suggestion.hunks.length === 0 ? (
                <div className="faint">{t("copilot.noHunks")}</div>
              ) : (
                suggestion.hunks.map((hunk) => (
                  <div key={hunk.id} className={`copilot-hunk copilot-hunk--${hunk.kind}`}>
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <span className={`badge bundle-diff__kind bundle-diff__kind--${hunk.kind === "add" ? "added" : hunk.kind === "remove" ? "removed" : "changed"}`}>
                        {t(`copilot.hunkKind.${hunk.kind}`)}
                      </span>
                      <span style={{ fontSize: 12.5 }}>{hunk.description}</span>
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      <button
                        type="button"
                        className={`btn btn--sm${decisions[hunk.id] === "accept" ? " btn--primary" : " btn--ghost"}`}
                        onClick={() => decide(hunk.id, "accept")}
                        disabled={applied}
                      >
                        <Icon.check size={12} /> {t("copilot.acceptButton")}
                      </button>
                      <button
                        type="button"
                        className={`btn btn--sm${decisions[hunk.id] === "reject" ? " btn--primary" : " btn--ghost"}`}
                        onClick={() => decide(hunk.id, "reject")}
                        disabled={applied}
                      >
                        {t("copilot.rejectButton")}
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="row" style={{ gap: 8, marginTop: 14, alignItems: "center" }}>
                <button className="btn btn--primary" onClick={applyAccepted} disabled={accepted === 0 || applied}>
                  <Icon.check size={13} />
                  {t("copilot.applyAcceptedButton", { n: accepted })}
                </button>
                {!allDecided && <span className="faint" style={{ fontSize: 12 }}>{t("copilot.undecidedHint")}</span>}
                {applied && <span className="badge badge--ok">{t("copilot.appliedBadge")}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
