import type { FlowStep } from "../shared/ir.ts";

/**
 * Target profile model (E17 — janus-specs/R3-reuse-browser/E17-webview-inspector.md).
 *
 * A "target profile" is board/config-level, NOT a Flow-file field — the same shape of decision
 * E11 already made for environments ("stg/qa/prod is a bridge-side config selector... never a
 * flow-level edit"): a Flow author never annotates a step "this one's native, this one's
 * webview" (P1, PODIUM-STUDIO-PLAN.md §2, cannot be asked to understand that distinction). This
 * file deliberately does NOT touch shared/ir.ts's flowSchema.
 */

/** The three explicit drive modes (E17 AC3 — "exposes exactly 3 selectable modes"). */
export type DriveMode = "native" | "webview" | "hybrid";

export interface TargetProfile {
  name: string;
  driveMode: DriveMode;
  /** The native shell's app id — launched via the existing mobile Driver either way (native
   * mode uses it for every step; hybrid uses it for the native-layer steps only). */
  bundleId: string;
}

/**
 * PODIUM-STUDIO-PLAN.md §7 decision #1 — "Demo App drive mode" is LOCKED to **Hybrid** as the
 * default, explicitly "reversible until E17 intake" (i.e. this decision, not an unresolved
 * question). The demo app is the plan's own primary target under test (§1). Native for launch/
 * permissions/deep-links, WebView DOM for the web app UI the QA actually clicks.
 */
export const DEMO_APP_PROFILE: TargetProfile = {
  name: "The Demo App",
  driveMode: "hybrid",
  bundleId: "com.example.demoapp",
};

/**
 * Actions that are ALWAYS native — system/app-lifecycle level, never inside a WebView's own DOM
 * regardless of drive mode (AC3: a native-mode/webview-mode profile must show NO cross-mode
 * locator leakage, so these never even attempt WebView resolution once hybrid auto-detection
 * kicks in either): launching/stopping the app, opening a deep link, and physical/system keys
 * (home, lock, volume, power, back) have no WebView-DOM equivalent — IR-SPEC.md §3's own
 * platform-capability footnotes already say as much for the browser driver.
 */
const ALWAYS_NATIVE_ACTIONS = new Set<FlowStep["action"]>(["launchApp", "stopApp", "openLink", "key"]);

/** Which layer a step resolves against for a given drive mode. `"auto"` (hybrid only) means the
 * caller must try one layer and fall back to the other — see bridge/webview-driver.ts's
 * `runHybridStep`, which is where that fallback actually happens. */
export type StepLayer = "native" | "webview" | "auto";

/**
 * AC3's routing rule. `native`/`webview` modes are unconditional — no cross-mode leakage is
 * possible because there is no auto-detection to leak from. `hybrid` auto-detects PER STEP
 * rather than requiring the flow author to annotate anything: lifecycle/system-level actions are
 * always native; everything else is "auto" (nearly all of a WebView-wrapped app's own UI lives
 * in the WebView, so the caller tries there first and falls back to native only if genuinely
 * unresolved there — covering system dialogs like a permission prompt, which sit outside the
 * WebView's DOM entirely even though they use a selector-bearing action like `tapText`/`waitFor`).
 */
export function stepLayerForMode(step: FlowStep, driveMode: DriveMode): StepLayer {
  if (driveMode === "native") return "native";
  if (driveMode === "webview") return "webview";
  return ALWAYS_NATIVE_ACTIONS.has(step.action) ? "native" : "auto";
}
