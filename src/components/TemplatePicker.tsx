import { useState, type CSSProperties } from "react";
import type { Flow } from "../../shared/ir.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";
import { TEMPLATES, buildTemplateFlow, type FlowTemplateMeta } from "../test-templates.ts";

export interface TemplatePickerProps {
  /** Called with a ready-to-edit, schema-valid Flow once the QA confirms the filled-in fields. */
  onPick: (flow: Flow) => void;
  /** Back to the launcher's 3-card choice (never a dead end — Esc/backdrop close still works via
   * the parent CreateTestLauncher modal, this is just "go up one level"). */
  onBack: () => void;
}

type Stage = "list" | "fields";

/**
 * Template path of the Create-a-test launcher (Phase A spec AC4): pick one of the ≥5 templates,
 * fill in its handful of placeholder fields (app bundle id, a product name, a search term, ...),
 * then hand back a ready Flow via `onPick` — the caller (App.tsx, per the integration spec) just
 * does `setOpenFlow(builtFlow)` and the QA lands straight in the normal editor, charter prefilled.
 */
export default function TemplatePicker({ onPick, onBack }: TemplatePickerProps) {
  const t = useT();
  const [stage, setStage] = useState<Stage>("list");
  const [selected, setSelected] = useState<FlowTemplateMeta | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  function selectTemplate(tpl: FlowTemplateMeta) {
    const defaults: Record<string, string> = {};
    for (const f of tpl.fields) defaults[f.key] = f.defaultValue;
    setSelected(tpl);
    setValues(defaults);
    setStage("fields");
  }

  function confirm() {
    if (!selected) return;
    onPick(buildTemplateFlow(selected.id, values));
  }

  if (stage === "list") {
    return (
      <div>
        <div style={listStyle}>
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="card"
              style={itemStyle}
              onClick={() => selectTemplate(tpl)}
            >
              <Icon.folder size={16} />
              <span style={itemTextStyle}>
                <span style={itemTitleStyle}>{t(`createTest.template.items.${tpl.id}.title`)}</span>
                <span className="faint" style={itemDescStyle}>{t(`createTest.template.items.${tpl.id}.desc`)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            {t("createTest.backButton")}
          </button>
        </div>
      </div>
    );
  }

  // stage === "fields" — selected is always set by the time we get here (selectTemplate sets
  // both together right before switching stage).
  const tpl = selected!;
  return (
    <div>
      <p className="faint" style={{ marginTop: 0 }}>{t(`createTest.template.items.${tpl.id}.desc`)}</p>
      {tpl.fields.map((f) => (
        <div key={f.key} style={fieldRowStyle}>
          <label style={fieldLabelStyle}>{t(`createTest.template.field.${f.key}`)}</label>
          <input
            className="input"
            style={{ width: "100%" }}
            value={values[f.key] ?? ""}
            placeholder={f.defaultValue}
            onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn--ghost" onClick={() => setStage("list")}>
          {t("createTest.backButton")}
        </button>
        <button type="button" className="btn btn--primary" onClick={confirm}>
          <Icon.check size={13} />
          {t("createTest.template.useButton")}
        </button>
      </div>
    </div>
  );
}

const listStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 14px",
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  width: "100%",
  appearance: "none",
};
const itemTextStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const itemTitleStyle: CSSProperties = { fontWeight: 600, fontSize: 13.5 };
const itemDescStyle: CSSProperties = { fontSize: 12 };
const fieldRowStyle: CSSProperties = { marginBottom: 10 };
const fieldLabelStyle: CSSProperties = { display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 4 };
