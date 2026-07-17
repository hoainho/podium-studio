import { useState } from "react";
import { Icon } from "./icons.tsx";

export interface InfoTipProps {
  /** One plain sentence explaining the jargon term. */
  text: string;
  /** An optional concrete example, shown in monospace under the sentence. */
  example?: string;
  /** Accessible name for the trigger; defaults to a generic "What does this mean?". */
  label?: string;
}

/**
 * A small "(i)" affordance that reveals one plain-language sentence (plus an optional
 * example) on hover, keyboard focus, or click. Used to demystify every technical term a
 * QA reads — bundle id, accessibility id, coordinates, raw Maestro, etc.
 */
export function InfoTip({ text, example, label = "What does this mean?" }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className="infotip">
      <button
        type="button"
        className="infotip__btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
      >
        <Icon.info size={12} />
      </button>
      <span className={`infotip__pop${open ? " infotip__pop--open" : ""}`} role="tooltip">
        <span className="infotip__text">{text}</span>
        {example && <span className="infotip__eg">{example}</span>}
      </span>
    </span>
  );
}
