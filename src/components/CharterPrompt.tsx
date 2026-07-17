import { useState } from "react";
import { useEscToClose } from "../use-esc-to-close.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface CharterPromptProps {
  /** Saves the answer onto the flow (caller merges it via test-design.ts's withCharterAnswer). */
  onSave: (answer: string) => void;
  /** Dismiss without answering — the QA can still author steps; the meter/nudges still work
   * without a charter, this is coaching, never a gate (spec: "advisory only, never blocking"). */
  onSkip: () => void;
}

/**
 * CharterPrompt — charter-first framing (E14 spec AC3). Shown once, before step authoring
 * begins on a genuinely NEW flow (StepEditor gates this on `isNewUnsavedFlow && !getCharterAnswer`).
 * A single plain-Vietnamese question with a worked example — never an English testing acronym
 * (spec AC5) — the answer is saved onto the flow's own data (test-design.ts's
 * `withCharterAnswer`), not a separate record, so it travels with the flow file.
 */
export default function CharterPrompt({ onSave, onSkip }: CharterPromptProps) {
  useEscToClose(onSkip);
  const [answer, setAnswer] = useState("");
  const t = useT();

  return (
    <div className="modal-backdrop" onClick={onSkip}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.wand size={16} />
          <span className="modal__title">{t("testDesign.charter.title")}</span>
          <button
            className="btn btn--ghost btn--icon"
            style={{ marginLeft: "auto" }}
            onClick={onSkip}
            aria-label={t("common.closeAria")}
          >
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          <p className="charter__question">{t("testDesign.charter.question")}</p>
          <p className="faint charter__example">{t("testDesign.charter.example")}</p>
          <textarea
            className="input charter__textarea"
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t("testDesign.charter.placeholder")}
            autoFocus
          />
          <div className="charter__actions">
            <button className="btn btn--ghost" onClick={onSkip}>
              {t("testDesign.charter.skipButton")}
            </button>
            <button
              className="btn btn--primary"
              onClick={() => onSave(answer)}
              disabled={!answer.trim()}
            >
              {t("testDesign.charter.saveButton")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
