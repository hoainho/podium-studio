import { useState, type CSSProperties } from "react";
import type { Flow } from "../../shared/ir.ts";
import { useEscToClose } from "../use-esc-to-close.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";
import TemplatePicker from "./TemplatePicker.tsx";

export interface CreateTestLauncherProps {
  /** "Record it" — the caller creates a new flow and opens the editor on the Record tab. */
  onPickRecord: () => void;
  /** "Describe it" — the caller opens the DescribeTestPrompt modal (co-pilot draft + review). */
  onPickDescribe: () => void;
  /** "Template" — called once the embedded TemplatePicker has a ready-to-edit Flow built. */
  onPickTemplate: (flow: Flow) => void;
  onClose: () => void;
}

type View = "choice" | "template";

/**
 * Create-a-test launcher (Phase A, docs/TEST-AUTHORING-UPGRADE-PLAN.md §7 / docs/janus/
 * INTAKE-ui-refresh.md AC2). Replaces the bare "New flow → Steps tab" entry with a neutral choice
 * of three EQUAL paths — no default-highlighted option (2026-07-16 decision: "show all three
 * equally"). Record/Describe are simple triggers the caller routes; Template is handled entirely
 * in-modal (pick a template → fill a couple of fields → hand back a ready Flow) since that whole
 * sub-flow never needs to leave this launcher.
 */
export default function CreateTestLauncher({
  onPickRecord,
  onPickDescribe,
  onPickTemplate,
  onClose,
}: CreateTestLauncherProps) {
  const t = useT();
  useEscToClose(onClose);
  const [view, setView] = useState<View>("choice");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--launcher" style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.rocket size={16} />
          <span className="modal__title">
            {view === "template" ? t("createTest.template.pickerTitle") : t("createTest.title")}
          </span>
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
          {view === "choice" ? (
            <>
              <p className="faint" style={{ marginTop: 0 }}>{t("createTest.subtitle")}</p>
              <div style={cardsRowStyle}>
                <button type="button" className="card" style={cardStyle} onClick={onPickRecord}>
                  <span style={emojiStyle} aria-hidden="true">📹</span>
                  <span style={cardTitleStyle}>{t("createTest.record.title")}</span>
                  <span className="faint" style={cardDescStyle}>{t("createTest.record.desc")}</span>
                </button>
                <button type="button" className="card" style={cardStyle} onClick={onPickDescribe}>
                  <span style={emojiStyle} aria-hidden="true">💬</span>
                  <span style={cardTitleStyle}>{t("createTest.describe.title")}</span>
                  <span className="faint" style={cardDescStyle}>{t("createTest.describe.desc")}</span>
                </button>
                <button type="button" className="card" style={cardStyle} onClick={() => setView("template")}>
                  <span style={emojiStyle} aria-hidden="true">📋</span>
                  <span style={cardTitleStyle}>{t("createTest.template.title")}</span>
                  <span className="faint" style={cardDescStyle}>{t("createTest.template.desc")}</span>
                </button>
              </div>
            </>
          ) : (
            <TemplatePicker onPick={onPickTemplate} onBack={() => setView("choice")} />
          )}
        </div>
      </div>
    </div>
  );
}

const modalStyle: CSSProperties = { width: "min(760px, 94vw)" };

// Equal-width cards that WRAP instead of overflowing at narrow widths (640px+, AC1) — no new
// styles.css classes needed (W-DESIGN owns that file exclusively this increment), just the
// existing `.card` surface treatment (bg/border/radius/shadow) reset to behave as a button.
const cardsRowStyle: CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap" };

const cardStyle: CSSProperties = {
  flex: "1 1 200px",
  minWidth: 168,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 6,
  padding: "16px 14px",
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  appearance: "none",
};

const emojiStyle: CSSProperties = { fontSize: 28, lineHeight: 1 };
const cardTitleStyle: CSSProperties = { fontWeight: 700, fontSize: 13.5 };
const cardDescStyle: CSSProperties = { fontSize: 12.5 };
