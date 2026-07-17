import type { Flow } from "../../shared/ir.ts";
import { evaluateCompleteness } from "../test-design.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface CompletenessMeterProps {
  flow: Flow;
  threshold?: number;
}

/**
 * CompletenessMeter — E14 spec AC1/AC2. A compact badge (for the editor's meta-row, next to the
 * step-count/lint badges) that fires when a flow has actions but no check anywhere, or when too
 * many actions pile up without one (the configurable K, test-design.ts's `evaluateCompleteness`).
 * Advisory only — never disables Save or Run (review-gate: "the meter is advisory only and
 * never blocks a Strict run"). Pair with `CompletenessMeterBanner` for the full, readable
 * message — a hover-only tooltip isn't visible enough for a warning the spec calls out by name.
 */
export default function CompletenessMeter({ flow, threshold }: CompletenessMeterProps) {
  const t = useT();
  const result = evaluateCompleteness(flow, threshold);

  return result.fires ? (
    <span className="badge badge--warn">
      <Icon.alert size={12} />
      {t("testDesign.meter.warnLabel")}
    </span>
  ) : (
    <span className="badge badge--ok">
      <Icon.check size={12} />
      {t("testDesign.meter.okLabel")}
    </span>
  );
}

/** The full, readable warning — rendered as a `hint-banner` (same visual language as
 * StepEditor's other advisory banners, e.g. "no device booted") right under the editor's
 * meta-row, so the message itself (not just a badge label) is on screen without hovering. */
export function CompletenessMeterBanner({ flow, threshold }: CompletenessMeterProps) {
  const t = useT();
  const result = evaluateCompleteness(flow, threshold);
  if (!result.fires) return null;

  const message =
    result.reason === "no-assertion-anywhere"
      ? t("testDesign.meter.noneMessage", { count: result.actionCount })
      : t("testDesign.meter.exceedsMessage", { run: result.maxActionsWithoutAssert, threshold: result.threshold });

  return (
    <div className="hint-banner" role="status">
      <Icon.alert size={14} />
      <span>{message}</span>
    </div>
  );
}
