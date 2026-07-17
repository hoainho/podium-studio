import { useMemo, useState } from "react";
import type { Flow } from "../../shared/ir.ts";
import { parseSteps, stepsToText } from "../../shared/parse-steps.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface TextStepsPanelProps {
  flow: Flow;
  onChange: (flow: Flow) => void;
  /** Whether the open flow has unsaved edits (used to warn before Replace discards them). */
  dirty?: boolean;
}

/**
 * The literal grammar cheat sheet shown under the textarea — kept in sync with
 * parse-steps.ts. This is DSL syntax (not UI prose): the Text DSL's English keywords
 * are out of scope for this epic (blocked on plan §7-6, Vietnamese keyword aliases),
 * so these lines are intentionally left as-is in both locales.
 */
const CHEAT_SHEET: string[] = [
  "tap Login",
  "tap #login_btn",
  "tap 120, 340",
  "double tap X",
  "long press X",
  "tap X if visible",
  "type hello@mail.com",
  "type secret + enter",
  "type X into <field>",
  "type <field>: X",
  "clear text",
  "delete N",
  "hide keyboard",
  "wait for Home",
  "wait for Home 30s",
  "wait until X gone",
  "wait 1500ms",
  "assert Welcome",
  "assert not X",
  "swipe up",
  "scroll up | down",
  "scroll until X",
  "back",
  "open <url>",
  "launch",
  "stop",
  "copy from X",
  "paste",
  "press enter",
  "screenshot",
  "raw <maestro>",
];

export default function TextStepsPanel({ flow, onChange, dirty }: TextStepsPanelProps) {
  const t = useT();
  // Auto-load the current flow's steps so the tab is never a confusing blank page.
  // The panel remounts each time the Text tab is opened, so this also covers "on switch".
  const [text, setText] = useState(() => stepsToText(flow.steps));

  const { steps: parsedSteps, issues } = useMemo(() => parseSteps(text), [text]);
  const canApply = parsedSteps.length > 0 && issues.length === 0;

  function loadCurrentSteps() {
    setText(stepsToText(flow.steps));
  }

  function replaceSteps() {
    if (!canApply) return;
    const n = flow.steps.length;
    const warn = dirty ? t("textSteps.replaceConfirmWarn") : "";
    const ok = window.confirm(
      t("textSteps.replaceConfirm", { oldCount: n, newCount: parsedSteps.length, warn }),
    );
    if (!ok) return;
    onChange({ ...flow, steps: parsedSteps });
  }

  function appendSteps() {
    if (!canApply) return;
    onChange({ ...flow, steps: [...flow.steps, ...parsedSteps] });
  }

  return (
    <div className="text-panel">
      <div className="text-panel__header">
        <div>
          <div className="text-panel__title">{t("textSteps.title")}</div>
          <div className="text-panel__subtitle">{t("textSteps.subtitle")}</div>
        </div>
        <button className="btn" onClick={loadCurrentSteps}>
          <Icon.refresh size={13} />
          {t("textSteps.reloadButton")}
        </button>
      </div>

      <textarea
        className="textarea text-panel__textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label={t("textSteps.textareaAria")}
        placeholder={"tap Login\ntype hello@mail.com + enter\nwait for Home\nassert Welcome"}
      />

      <div className="text-panel__summary">
        {parsedSteps.length > 0 || issues.length > 0 ? (
          <span className={`badge ${issues.length > 0 ? "badge--warn" : "badge--ok"}`}>
            {t("textSteps.parsedCountLabel", { n: parsedSteps.length })}
            {issues.length > 0 ? ` · ${t("textSteps.issuesCountLabel", { n: issues.length })}` : ""}
          </span>
        ) : (
          <span className="faint">{t("textSteps.emptyParsed")}</span>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="warnings-list">
          {issues.map((issue, i) => (
            <li key={i}>
              <Icon.alert size={13} />
              <span>
                {t("textSteps.issueLinePrefix", { line: issue.line })}: {issue.error} —{" "}
                <span className="mono">{issue.text}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="text-panel__apply-row">
        <button
          className="btn btn--primary"
          onClick={appendSteps}
          disabled={!canApply}
          title={!canApply ? t("textSteps.appendTitleDisabled") : t("textSteps.appendTitleEnabled")}
        >
          <Icon.plus size={13} />
          {t("textSteps.appendButton")}
        </button>
        <button
          className="btn"
          onClick={replaceSteps}
          disabled={!canApply}
          title={!canApply ? t("textSteps.appendTitleDisabled") : t("textSteps.replaceTitleEnabled")}
        >
          <Icon.refresh size={13} />
          {t("textSteps.replaceButton")}
        </button>
      </div>

      {flow.steps.length === 0 && (
        <div className="empty-state" style={{ padding: "20px 4px" }}>
          <div className="empty-state__title">{t("textSteps.emptySteps")}</div>
          <div className="empty-state__hint">{t("textSteps.emptyStepsHint")}</div>
        </div>
      )}

      <div className="cheat-sheet">
        <div className="cheat-sheet__title">{t("textSteps.cheatSheetTitle")}</div>
        <div className="cheat-sheet__grid">
          {CHEAT_SHEET.map((item) => (
            <code key={item} className="cheat-sheet__item">
              {item}
            </code>
          ))}
        </div>
        <div className="cheat-sheet__note">
          {t("textSteps.cheatSheetNoteA")} <code>:: label</code> {t("textSteps.cheatSheetNoteB")}{" "}
          <code>#</code> {t("textSteps.cheatSheetNoteC")}
        </div>
      </div>
    </div>
  );
}
