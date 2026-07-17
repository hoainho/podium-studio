import type { FlowStep } from "../shared/ir.ts";
import type { ScreenElement } from "../shared/lint.ts";
import type { StepOutcome } from "./driver.ts";
import { mapStepToBrowserAction, type BrowserSession } from "./browser-driver.ts";
import { executeStep } from "./runner.ts";
import { stepLayerForMode, type TargetProfile } from "./target-profile.ts";

/**
 * WebView-aware inspector + hybrid step execution (E17 —
 * janus-specs/R3-reuse-browser/E17-webview-inspector.md).
 *
 * A hybrid app's WebView (e.g. the demo app's React-Native shell wrapping the web app) is
 * NOT meaningfully different from a standalone browser page once you have a Playwright-
 * compatible `page` handle attached to it — the closed IR action vocabulary maps onto its DOM
 * exactly the same way bridge/browser-driver.ts's `mapStepToBrowserAction` already maps it onto
 * a standalone browser (reused here VERBATIM, not reimplemented). The only genuinely NEW thing
 * this epic needs is HOW that page handle is obtained: attaching to an already-running app's
 * live WebView via its remote-debug endpoint, rather than launching a fresh browser process —
 * and routing each step to the right layer (native a11y tree vs WebView DOM) in hybrid mode.
 *
 * Runtime-gated per the epic's own framing: no real simulator/device is available in this
 * environment, so `attachToWebView`'s real connection logic cannot be exercised end to end here
 * — it's implemented honestly (never fakes success) and unit-tested via its injectable `connectFn`
 * (same DI pattern as bridge/browser-driver.ts's `loadModuleFn` / bridge/android-driver.ts's `exec`).
 */

export interface WebViewTarget {
  /** The simulator/device the app is running on. */
  udid: string;
  bundleId: string;
}

export interface WebViewHandle {
  /** Playwright-compatible page attached to the LIVE WebView (review gate: "reads the actual
   * live DOM, not a cached/stale snapshot" — every call below reads through this page, never a
   * cached tree). */
  page: any;
  close(): Promise<void>;
}

export type ConnectWebViewFn = (target: WebViewTarget) => Promise<WebViewHandle>;

async function defaultConnect(target: WebViewTarget): Promise<WebViewHandle> {
  // Discovering a running app's WebView remote-debug endpoint is OS/tooling-specific plumbing
  // (iOS: Safari Web Inspector / ios-webkit-debug-proxy; Android: chrome://inspect over adb) that
  // needs a real simulator/device with the app actually running — neither is available in this
  // dev environment. Honest, non-fatal failure (never fakes success), exactly like
  // bridge/browser-driver.ts's `detectBrowserRuntime()` when no engine is importable.
  throw new Error(
    `No WebView remote-debug endpoint found for "${target.bundleId}" on device "${target.udid}" — ` +
    `this needs a live simulator/device with the app running and its WebView remote-debugging ` +
    `reachable (iOS: Safari Web Inspector; Android: chrome://inspect over adb). Neither is ` +
    `available in this environment.`,
  );
}

/** Attach to the target app's currently-open WebView. `connectFn` is injectable so this is
 * unit-testable with a fake connection — no real simulator/app needed. */
export async function attachToWebView(target: WebViewTarget, connectFn: ConnectWebViewFn = defaultConnect): Promise<WebViewHandle> {
  return connectFn(target);
}

/**
 * Flatten a WebView's LIVE DOM into `shared/lint.ts`'s generic `ScreenElement[]` shape — the
 * SAME shape the existing ambiguity-preflight engine (confidence score / "khớp N phần tử" /
 * candidate picker, already built + tested for native a11y and standalone-browser DOM) already
 * consumes. `data-testid` maps to `accessibilityId` exactly like the browser driver's
 * `resolveLocator` already treats it as the IR's `targetId` field (IR-SPEC.md §5.2: "prefer
 * data-testid, the most stable"). Zero changes needed to shared/lint.ts itself for AC4.
 */
export async function flattenWebViewElements(page: any): Promise<ScreenElement[]> {
  // These callbacks run INSIDE the WebView (Playwright serializes them there), where `document`
  // genuinely exists — the `globalThis as any` cast is only to satisfy this file's own Node-only
  // (no-DOM-lib) tsconfig, not a runtime workaround (same pattern browser-driver.ts's
  // pasteText/copyText cases already use for `navigator`).
  const raw: Array<{ text?: string; testId?: string }> = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const out: Array<{ text?: string; testId?: string }> = [];
    doc.querySelectorAll("*").forEach((el: any) => {
      const testId = el.getAttribute("data-testid") ?? undefined;
      const text = (el.textContent ?? "").trim() || undefined;
      if (testId || text) out.push({ text, testId });
    });
    return out;
  });
  return raw.map((e) => ({ text: e.text, accessibilityId: e.testId }));
}

export interface WebViewInspectorNode {
  tag: string;
  /** Only set on a leaf node (no children) — mirrors how a real a11y tree only surfaces text at
   * the innermost element, avoiding every ancestor duplicating a descendant's text. */
  text?: string;
  testId?: string;
  children: WebViewInspectorNode[];
}

/** The full element tree for the inspector UI (AC1: "element tree renders with correct node
 * hierarchy") — a SEPARATE call from `flattenWebViewElements` (which only needs a flat bag of
 * candidates for ambiguity-counting, not real parent/child structure). */
export async function inspectWebViewTree(page: any): Promise<WebViewInspectorNode> {
  return page.evaluate(() => {
    // Same "runs inside the WebView" cast rationale as flattenWebViewElements above.
    function walk(el: any): WebViewInspectorNode {
      const children = Array.from(el.children as any[]).map(walk);
      return {
        tag: el.tagName.toLowerCase(),
        text: children.length === 0 ? (el.textContent ?? "").trim() || undefined : undefined,
        testId: el.getAttribute("data-testid") ?? undefined,
        children,
      };
    }
    return walk((globalThis as any).document.body);
  });
}

/** A locator the execution side can resolve straight back into a real DOM query — same
 * vocabulary `bridge/browser-driver.ts`'s `resolveLocator` already accepts (`targetId`/`text`),
 * so nothing new needs parsing on the run path. */
export interface WebViewLocator {
  text?: string;
  targetId?: string;
}

/** Click-to-select (AC1): resolve a point in the inspector's rendered DOM snapshot to the
 * element under it and produce a WORKING locator (`targetId` preferred, `text` fallback — same
 * priority `resolveLocator` uses). */
export async function pickWebViewLocatorAt(page: any, x: number, y: number): Promise<WebViewLocator | undefined> {
  const picked: { text?: string; testId?: string } | null = await page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      // Same "runs inside the WebView" cast rationale as flattenWebViewElements above.
      const el = (globalThis as any).document.elementFromPoint(x, y);
      if (!el) return null;
      return { testId: el.getAttribute("data-testid") ?? undefined, text: (el.textContent ?? "").trim() || undefined };
    },
    { x, y },
  );
  if (!picked) return undefined;
  return { targetId: picked.testId, text: picked.text };
}

/** Same signature as `bridge/runner.ts`'s `executeStep` — injectable so the native layer is
 * unit-testable without a real Podium engine/simulator (mirrors that module's own DI-free design
 * being wrapped here, not changed). */
export type NativeStepExecutor = (
  udid: string,
  step: FlowStep,
  bundleId: string | undefined,
  fixtures?: Record<string, unknown>,
  env?: Record<string, string>,
  secrets?: Record<string, string>,
) => Promise<StepOutcome>;

/**
 * Execute ONE step against the right layer for this target profile's drive mode (AC2/AC3).
 * `native`/`webview` modes dispatch unconditionally — no cross-mode leakage is possible. Hybrid
 * mode's "auto" steps try the WebView first (nearly all of a WebView-wrapped app's own UI lives
 * there) and fall back to the native layer only when the WebView genuinely has no match — this
 * is what lets a permission dialog (native, outside the WebView's DOM) and an in-app tap (inside
 * it) both use the SAME selector-bearing actions (`tapText`/`waitFor`/...) within one flow run
 * (AC2), with no per-step "which layer" field for the flow author to set (P1 cannot be asked to
 * understand that distinction — PODIUM-STUDIO-PLAN.md §2).
 */
export async function runHybridStep(
  step: FlowStep,
  webviewPage: any | undefined,
  udid: string,
  profile: TargetProfile,
  fixtures: Record<string, unknown> = {},
  secrets?: Record<string, string>,
  nativeExec: NativeStepExecutor = executeStep,
): Promise<StepOutcome> {
  const layer = stepLayerForMode(step, profile.driveMode);

  if (layer === "native") {
    return nativeExec(udid, step, profile.bundleId, fixtures, undefined, secrets);
  }
  if (layer === "webview") {
    if (!webviewPage) return { ok: false, error: "This step needs the WebView, but none is attached." };
    return mapStepToBrowserAction(step, sessionFor(webviewPage), fixtures, secrets);
  }

  // "auto" (hybrid): try the WebView layer first, fall back to native only if unresolved there.
  if (webviewPage) {
    const webResult = await mapStepToBrowserAction(step, sessionFor(webviewPage), fixtures, secrets);
    if (webResult.ok) return webResult;
  }
  return nativeExec(udid, step, profile.bundleId, fixtures, undefined, secrets);
}

function sessionFor(page: any): BrowserSession {
  return { page, context: {}, browser: {}, driverName: "playwright", browserVersion: "n/a" };
}

