import { useEffect } from "react";

/**
 * Close a modal/overlay on the Escape key (QA audit P0-4: modals previously only closed via the X
 * button or a backdrop click — Esc did nothing, inconsistent with RunPanel's evidence viewer which
 * already handled it). Pass the same close handler the X button uses. No-op when `enabled` is false
 * (e.g. a modal that isn't currently open), so the listener is only attached while it matters.
 */
export function useEscToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}
