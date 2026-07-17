import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { interpolate, isStepIdempotent, type Flow, type FlowStep } from "../shared/ir.ts";
import type { RunEvent, RunStatus, RunSummary, StepResult } from "../shared/protocol.ts";
import type { Driver, DriverAvailability, DriverContext, StepOutcome } from "./driver.ts";
import { createRunContext, isTransientError, MAX_RETRIES, type RunContext } from "./runner.ts";
import { collectSecretRefs, redactRunEvent, redactSecrets, redactSummary, resolveSecrets } from "./secrets.ts";
import {
  computeConcurrency,
  createPortPool,
  createProfilePool,
  registerRun,
  shardJobs,
  unregisterRun,
  type SuiteReport,
  type WorkerReport,
} from "./orchestrator.ts";

/**
 * BrowserDriver (E7 — janus-specs/R1-foundations/E7-browser-firstrun.md).
 *
 * CloakBrowser (a Playwright-compatible API) is the default engine; a plain-Playwright
 * fallback sits behind the SAME calls per Pillar J's locked decision ("CloakBrowser is one
 * Driver implementation, not the core — a frozen-Chromium/licensing/availability failure must
 * never sink browser E2E"). Free tier (no `CLOAKBROWSER_LICENSE_KEY`) is the default; Pro is
 * out of scope for this first-run epic (E7 AC5).
 *
 * Neither `cloakbrowser` nor `playwright` is an npm dependency of this repo today (see
 * package.json) — both are loaded via a runtime dynamic import behind a NON-literal specifier
 * (see `loadModule` below), which is what keeps `tsc`/vitest working even when neither package
 * is installed on this machine. `isAvailable()`/`detectBrowserRuntime()` report the real
 * situation; nothing here fakes a green result when the runtime is missing (team-lead
 * instruction: "do NOT fake success").
 */

// ── Runtime detection & session (untestable without a real browser — kept separate from the
//    pure IR->action mapping below, which the vitest tests exercise with a fake session) ──────

/** Free tier per Pillar J §5.2 — pin exactly ONE Chromium build for determinism (E7 AC4),
 * not the "v145/v146" floating range. Override via env for a workspace-level pin. */
export const PINNED_CHROMIUM_VERSION = process.env.PODIUM_STUDIO_CHROMIUM_VERSION ?? "145";

export type BrowserDriverName = "cloakbrowser" | "playwright";

/**
 * E16 AC2 — "the SAME flow runs green against the plain-Playwright fallback driver with ZERO
 * flow-file changes, only a driver-selection config value differs": this env var IS that config
 * value. "auto" (default) prefers CloakBrowser and falls back to Playwright only when
 * CloakBrowser isn't importable (E7's original behavior, unchanged); an explicit
 * "cloakbrowser"/"playwright" pins the choice regardless of what else is installed, which is
 * what makes AC2 provable even on a machine that happens to have both packages available.
 */
export type BrowserDriverPreference = BrowserDriverName | "auto";

function readDriverPreference(): BrowserDriverPreference {
  const raw = process.env.PODIUM_STUDIO_BROWSER_DRIVER;
  if (raw === "cloakbrowser" || raw === "playwright" || raw === "auto") return raw;
  // Locked decision (WEB-E2E-STRATEGY.md, 2026-07-17): Playwright is the DEFAULT engine — plain
  // playwright-core (vendored) driving the shared Chromium, giving native trace/video. CloakBrowser
  // stays a selectable fallback for bot-protected sites (its stealth layer). An explicit env var
  // still overrides. "playwright" (not "auto") is the floor so trace/video are on by default.
  return "playwright";
}

export const BROWSER_DRIVER_PREFERENCE: BrowserDriverPreference = readDriverPreference();

/**
 * Locate a Chromium executable for plain playwright-core, which (unlike the full `playwright`
 * package) ships NO browser binary. We reuse the ONE Chromium CloakBrowser already manages in the
 * shared, per-user `~/.cloakbrowser` (downloaded once, never re-bundled) so a Playwright-default run
 * needs zero extra download on a machine that has ever run a web test. Order: explicit env override
 * → newest `~/.cloakbrowser/chromium-*` build (mac/linux/win layout) → undefined (caller falls back
 * to CloakBrowser, which knows how to fetch its own). Never throws.
 */
export function resolveChromiumExecutable(): string | undefined {
  const envPath = process.env.PODIUM_STUDIO_CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  try {
    const root = join(homedir(), ".cloakbrowser");
    if (!existsSync(root)) return undefined;
    // Newest chromium-<version> dir first (lexical desc is good enough for the pinned single build).
    const builds = readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const build of builds) {
      const base = join(root, build);
      const candidates = [
        join(base, "Chromium.app", "Contents", "MacOS", "Chromium"), // macOS
        join(base, "chrome-linux", "chrome"), // Linux
        join(base, "chrome-win", "chrome.exe"), // Windows
      ];
      for (const c of candidates) if (existsSync(c)) return c;
    }
  } catch {
    /* best-effort discovery — undefined just means "let CloakBrowser handle it" */
  }
  return undefined;
}

/** Load whichever Playwright is present: the vendored `playwright-core` (no bundled browser — we
 * point it at the shared Chromium above) or, if someone installed it, the full `playwright`. */
async function loadPlaywright(loadModuleFn: (name: string) => Promise<any>): Promise<any> {
  try {
    return await loadModuleFn("playwright-core");
  } catch {
    return await loadModuleFn("playwright");
  }
}

export interface BrowserSession {
  // Playwright-compatible surface (page/context/browser). Typed as `any` because neither
  // library is a compile-time dependency here — the real shape is validated at runtime by the
  // calls this driver makes, and by whichever package actually ends up installed.
  page: any;
  context: any;
  browser: any;
  driverName: BrowserDriverName;
  browserVersion: string;
}

/**
 * Dynamic-import a module by a NON-literal specifier. This is deliberate: TypeScript only
 * attempts static module resolution (and would fail with TS2307) for a *literal* string passed
 * to `import()`. Routing the name through a variable makes the expression's type `Promise<any>`
 * without TS trying (and failing) to resolve `cloakbrowser`/`playwright` at compile time — both
 * are genuinely optional, machine-dependent runtime dependencies, not something this repo can
 * assume is installed.
 */
async function loadModule(name: string): Promise<any> {
  return import(name);
}

/**
 * Runtime probe: is a usable browser engine importable on this machine? Never throws. `preference`
 * (E16 AC2) picks the try-order: "auto" tries CloakBrowser first, falling back to Playwright only
 * if CloakBrowser isn't importable (E7's original, unchanged behavior); an explicit preference
 * tries ONLY that engine first, still falling back to the other if the preferred one is missing
 * (missing is missing — a config preference for an uninstalled engine shouldn't be a hard failure
 * when the other engine would work). `loadModuleFn` is injectable so tests can prove the
 * preference logic itself without either real package installed (see test/browser-driver.test.ts).
 */
export async function detectBrowserRuntime(
  loadModuleFn: (name: string) => Promise<any> = loadModule,
  preference: BrowserDriverPreference = BROWSER_DRIVER_PREFERENCE,
): Promise<DriverAvailability & { driverName?: BrowserDriverName }> {
  const order: BrowserDriverName[] =
    preference === "cloakbrowser" ? ["cloakbrowser", "playwright"] : ["playwright", "cloakbrowser"];
  for (const name of order) {
    try {
      // "playwright" resolves to the vendored playwright-core (or full playwright); "cloakbrowser"
      // to its own package. Both are optional runtime deps loaded via a non-literal specifier.
      if (name === "playwright") await loadPlaywright(loadModuleFn);
      else await loadModuleFn(name);
      return { ok: true, driverName: name };
    } catch {
      // try the next engine in `order`
    }
  }
  return {
    ok: false,
    reason:
      "No browser runtime found on this machine — install `cloakbrowser` (preferred, Free tier " +
      "default, see PILLAR-BROWSER-E2E.md §1) or `playwright` (fallback) to use the browser driver. " +
      "Neither is a bundled dependency of podium-studio, so this is expected on a machine that " +
      "hasn't set either up yet.",
  };
}

async function readBrowserVersion(page: any, fallback: string): Promise<string> {
  try {
    const v = await page?.context?.()?.browser?.()?.version?.();
    return typeof v === "string" && v.length > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

let sessionPromise: Promise<BrowserSession> | null = null;

/**
 * Lazily launch ONE shared browser session. E7 scope is a single first-run login flow, not the
 * full per-worker port/profile pool (that orchestrator is E16/R3, per PILLAR-BROWSER-E2E.md §2)
 * — one page is all a first-run needs.
 */
async function getSession(): Promise<BrowserSession> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const detected = await detectBrowserRuntime();
    if (!detected.ok || !detected.driverName) throw new Error(detected.reason ?? "browser runtime unavailable");

    if (detected.driverName === "cloakbrowser") {
      const cb = await loadModule("cloakbrowser");
      // Free tier default: no license key, pinned Chromium build (E7 AC4/AC5). CloakBrowser's
      // launch() is Playwright-compatible: returns { browser, context, page } (or a context
      // whose .newPage() we call ourselves if `page` isn't handed back directly).
      const launched = await cb.launch({
        headless: true,
        chromiumVersion: PINNED_CHROMIUM_VERSION,
        licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY, // undefined => Free tier (AC5)
      });
      const page = launched.page ?? (await launched.context.newPage());
      return {
        page, context: launched.context, browser: launched.browser,
        driverName: "cloakbrowser",
        browserVersion: await readBrowserVersion(page, PINNED_CHROMIUM_VERSION),
      };
    }

    const pw = await loadPlaywright(loadModule);
    // playwright-core ships no browser — drive the shared Chromium (see resolveChromiumExecutable).
    // `executablePath: undefined` lets a full `playwright` install use its own bundled build.
    const browser = await pw.chromium.launch({ headless: true, executablePath: resolveChromiumExecutable() });
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      page, context, browser,
      driverName: "playwright",
      browserVersion: await readBrowserVersion(page, PINNED_CHROMIUM_VERSION),
    };
  })();
  return sessionPromise;
}

/** Tear down the shared session (best-effort; never throws). Exported for test/process cleanup. */
export async function closeBrowserSession(): Promise<void> {
  if (!sessionPromise) return;
  const p = sessionPromise;
  sessionPromise = null;
  try {
    const s = await p;
    await s.context?.close?.();
    await s.browser?.close?.();
  } catch {
    /* best-effort teardown */
  }
}

// ── Worker lifecycle (E16 — janus-specs/R3-reuse-browser/E16-browser-driver.md) ────────────────
//
// The single shared `getSession()` above is E7's first-run scope: one ad-hoc page, good enough
// for a single flow. E16's suite-parallel scope needs PILLAR-BROWSER-E2E.md §2's worker model
// instead: "Worker i = ONE browser process, bound to a port from the pool + a clean profile dir
// from bridge/orchestrator.ts's ProfilePool; the process stays alive across its whole shard,
// opening a FRESH browser context per flow (clean cookies/storage each flow, no per-flow process
// spawn)." `launchBrowserWorker` below is that one process; `runBrowserFlow` runs one Flow
// against one of its contexts; `runBrowserSuite` is the glue that reuses E15's pool/concurrency/
// sharding primitives (never reimplementing them) to drive many workers in parallel.

/** The (port, profileDir) a worker is bound to — structurally the same shape as
 * bridge/orchestrator.ts's `WorkerSlot`, kept as a local minimal type (rather than importing
 * `WorkerSlot` itself) so this file only depends on orchestrator.ts for the pieces it actually
 * calls (pools/sharding/registry), not for a type it can satisfy structurally either way. */
export interface BrowserWorkerSlot {
  workerId: number;
  port: number;
  profileDir: string;
}

export interface BrowserWorker {
  readonly workerId: number;
  readonly port: number;
  readonly profileDir: string;
  readonly driverName: BrowserDriverName;
  readonly browserVersion: string;
  /** The ONE browser process's pid, when the runtime exposes it (Playwright's `browser.process()`)
   * — undefined if it doesn't (E16 AC4: "same process ID serves every flow in the shard" is only
   * literally provable when this is set; CloakBrowser's real exposure of it is unverified here). */
  readonly pid?: number;
  /** A fresh, cookie/localStorage-isolated context + page for ONE flow (E16 AC4). The PROCESS
   * above is reused across every call — only the context is new each time. `recordDir` (when set)
   * asks the engine to record a video of the flow into that dir (Playwright `recordVideo`), part of
   * the locked per-run evidence set (WEB-E2E-STRATEGY.md). */
  newContextForFlow(opts?: { recordDir?: string }): Promise<BrowserSession>;
  /** Best-effort teardown of the ONE process this worker launched. Never throws. */
  close(): Promise<void>;
}

async function readWorkerVersion(browser: any, fallback: string): Promise<string> {
  try {
    const v = await browser?.version?.();
    return typeof v === "string" && v.length > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** The CloakBrowser worker (its stealth layer is why it stays selectable for bot-protected sites).
 * Extracted so the Playwright-default path can delegate here as the one honest bootstrap when no
 * shared Chromium exists yet. */
async function launchBrowserWorkerCloak(
  slot: BrowserWorkerSlot,
  loadModuleFn: (name: string) => Promise<any>,
): Promise<BrowserWorker> {
  const cb = await loadModuleFn("cloakbrowser");
  const launched = await cb.launch({
    headless: true,
    chromiumVersion: PINNED_CHROMIUM_VERSION, // AC3: exactly one pinned build, never a range
    licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY, // undefined => Free tier (AC5); env-only, never hardcoded
    stealth: false, // AC3: deterministic runs — no fingerprint randomization
    userDataDir: slot.profileDir, // AC4: this worker's own clean profile dir
    port: slot.port, // AC4: this worker's own remote-debug port from the pool
  });
  // CloakBrowser's launch() returns the browser-like object DIRECTLY (Playwright-compatible API,
  // but the launch result is the browser itself, not `{ browser }`). Tolerate either shape.
  const browser = launched?.browser ?? launched;
  const pid: number | undefined = browser?.process?.()?.pid;
  const browserVersion = await readWorkerVersion(browser, PINNED_CHROMIUM_VERSION);
  return {
    workerId: slot.workerId,
    port: slot.port,
    profileDir: slot.profileDir,
    driverName: "cloakbrowser",
    browserVersion,
    pid,
    async newContextForFlow(opts?: { recordDir?: string }): Promise<BrowserSession> {
      const ctxOpts = opts?.recordDir ? { recordVideo: { dir: opts.recordDir } } : undefined;
      const context =
        typeof browser?.newContext === "function" ? await browser.newContext(ctxOpts) : browser;
      const page = await context.newPage();
      return { page, context, browser, driverName: "cloakbrowser", browserVersion };
    },
    async close(): Promise<void> {
      try {
        await browser?.close?.();
      } catch {
        /* best-effort teardown */
      }
    },
  };
}

/**
 * Launch ONE browser process bound to `slot.port`/`slot.profileDir` — the E16 worker lifecycle.
 * `loadModuleFn` is injectable (mirrors `bridge/android-driver.ts`'s `exec` DI) so this is
 * unit-testable with a fake module, exactly like every other "untestable without a real X" seam
 * in this file. Never fakes success: rejects with a clear message when neither engine is
 * importable, same contract as `getSession()`.
 */
export async function launchBrowserWorker(
  slot: BrowserWorkerSlot,
  loadModuleFn: (name: string) => Promise<any> = loadModule,
): Promise<BrowserWorker> {
  const detected = await detectBrowserRuntime(loadModuleFn);
  if (!detected.ok || !detected.driverName) throw new Error(detected.reason ?? "browser runtime unavailable");

  if (detected.driverName === "cloakbrowser") return launchBrowserWorkerCloak(slot, loadModuleFn);

  // Playwright (default engine, locked decision). playwright-core ships no browser binary, so we
  // drive the shared Chromium CloakBrowser already manages. If that Chromium isn't present yet
  // (first web run on a brand-new machine), there is no binary to launch — re-detect with an
  // explicit CloakBrowser preference so its packaged launcher fetches its own Chromium; the NEXT
  // run finds it and uses Playwright. This isn't a silent shim: it's the one honest bootstrap path
  // for "Playwright default + no browser downloaded yet", logged so it's visible.
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    const cbAvailable = await detectBrowserRuntime(loadModuleFn, "cloakbrowser");
    if (cbAvailable.ok && cbAvailable.driverName === "cloakbrowser") {
      console.warn(
        "[browser-driver] Playwright is the default engine but no Chromium is installed yet — " +
          "using CloakBrowser for this run (it fetches Chromium into the shared ~/.cloakbrowser); " +
          "subsequent runs use Playwright against that binary.",
      );
      return launchBrowserWorkerCloak(slot, loadModuleFn);
    }
    throw new Error(
      "Playwright engine selected but no Chromium binary was found (set PODIUM_STUDIO_CHROMIUM_PATH " +
        "or install CloakBrowser so a shared Chromium is available).",
    );
  }
  const pw = await loadPlaywright(loadModuleFn);
  // A REGULAR (non-persistent) launch. Playwright manages its OWN temp profile per launched process
  // and rejects a `--user-data-dir` arg outright ("pass userDataDir to launchPersistentContext"),
  // so we do NOT set it — each worker is already its own isolated process, and the per-flow fresh
  // profile (AC4) comes from `browser.newContext()` below. `slot.profileDir`/`slot.port` remain the
  // orchestrator's bookkeeping (and this worker's artifacts dir), just not Chromium CLI flags.
  const browser = await pw.chromium.launch({ headless: true, executablePath });
  const pid: number | undefined = browser?.process?.()?.pid;
  const browserVersion = await readWorkerVersion(browser, PINNED_CHROMIUM_VERSION);
  return {
    workerId: slot.workerId,
    port: slot.port,
    profileDir: slot.profileDir,
    driverName: "playwright",
    browserVersion,
    pid,
    async newContextForFlow(opts?: { recordDir?: string }): Promise<BrowserSession> {
      const context = await browser.newContext(
        opts?.recordDir ? { recordVideo: { dir: opts.recordDir } } : undefined,
      );
      const page = await context.newPage();
      return { page, context, browser, driverName: "playwright", browserVersion };
    },
    async close(): Promise<void> {
      try {
        await browser?.close?.();
      } catch {
        /* best-effort teardown */
      }
    },
  };
}

// ── IR -> browser action mapping (pure enough to unit-test with a fake session/page) ──────────

/** Selector-bearing IR fields, shared by every tap-like/assert-like action. */
interface Selector {
  text?: string;
  targetId?: string;
  x?: number;
  y?: number;
}

/**
 * Resolve an IR selector to a Playwright-compatible Locator, following IR-SPEC.md §5's mobile
 * a11y locator field set (text/targetId) reinterpreted as the browser DOM locator field set:
 * `targetId` -> `getByTestId` (prefer `data-testid`, the most stable per §5.2), `text` ->
 * `getByText` (case-insensitive full match, mirroring the IR's `text` field semantics).
 *
 * `secrets` (E12/R2 follow-up) is threaded alongside `fixtures` exactly like the mobile/Android
 * drivers do (bridge/runner.ts, bridge/android-driver.ts) — an optional, separate resolved
 * `${secret:name}` -> value map, so a `${secret:...}` reference in a step's `text` field
 * resolves on the browser path too, not just mobile/Android.
 */
/** Candidate `.first()` Locators for `sel` in ONE frame-like root (a Page or a Frame — both expose
 * `getByRole`/`getByTestId`/`getByText`), in priority order. `preferRole` (tap-like actions) puts a
 * clickable button/link FIRST so a tap hits the real control, not a same-text heading or SR-only
 * node that happens to appear earlier in the DOM (the demo app "Play Now" trap). Non-tap callers
 * (assert/wait) just use the plain text/testid match. */
function makeLocatorCandidates(
  root: any,
  sel: Selector,
  fixtures: Record<string, unknown>,
  secrets: Record<string, string> | undefined,
  preferRole: boolean,
): any[] {
  if (sel.targetId) return [root.getByTestId(sel.targetId).first()];
  if (sel.text !== undefined) {
    const text = interpolate(sel.text, fixtures, secrets);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // SUBSTRING (not anchored ^...$) + case-insensitive: "tap Sony" must find "Sony" inside a longer
    // label — the contains-not-exact lesson from the mobile engine (QA audit RUN-3).
    const re = new RegExp(escaped, "i");
    const text_ = root.getByText(re).first();
    if (!preferRole) return [text_];
    return [root.getByRole?.("button", { name: re })?.first?.(), root.getByRole?.("link", { name: re })?.first?.(), text_].filter(Boolean);
  }
  return [];
}

/**
 * Resolve an IR selector to a Locator, searching the MAIN FRAME **and every child iframe** — the
 * proven root cause of "element never found" on real embedded apps (WEB-E2E-STRATEGY.md): the app
 * often lives in a cross-origin iframe, and `page.getByText` only ever sees the main frame. We
 * return the locator from the first frame that currently contains the target, so a following
 * click/type/assert acts on the right frame. When nothing matches yet (element not rendered), we
 * fall back to the MAIN-frame locator so waiting actions (`waitFor`) still have something to wait
 * on and non-waiting ones fail with an honest, frame-searched error.
 *
 * `secrets` (E12/R2) is threaded alongside `fixtures` exactly like the mobile/Android drivers do.
 */
async function resolveLocator(
  page: any,
  sel: Selector,
  fixtures: Record<string, unknown>,
  secrets?: Record<string, string>,
  waitMs = 0,
  preferRole = false,
): Promise<any> {
  if (sel.targetId === undefined && sel.text === undefined) return undefined;
  // In ONE frame, return the first candidate that EXISTS, flagged with whether it's visible.
  const pick = async (root: any): Promise<{ loc: any; visible: boolean } | null> => {
    let existing: any = null;
    for (const c of makeLocatorCandidates(root, sel, fixtures, secrets, preferRole)) {
      if (!(await c.count().catch(() => 0))) continue;
      existing ??= c;
      if (await c.isVisible().catch(() => false)) return { loc: c, visible: true };
    }
    return existing ? { loc: existing, visible: false } : null;
  };
  // One scan of the main frame + every child iframe. Returns a VISIBLE match (main frame first) or
  // null; remembers the best existing-but-not-visible locator for the deadline fallback.
  let lastExisting: any = null;
  const scan = async (): Promise<any | null> => {
    const frames: any[] = typeof page.frames === "function" ? page.frames() : [];
    const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
    for (const root of [page, ...frames.filter((f) => f !== mainFrame)]) {
      const hit = await pick(root);
      if (hit) {
        lastExisting ??= hit.loc;
        if (hit.visible) return hit.loc;
      }
    }
    return null;
  };
  // Poll until a VISIBLE match appears in SOME frame or the budget runs out — real apps mount the
  // target inside a cross-origin iframe that finishes loading AFTER navigation (the demo app case).
  // `waitMs === 0` (assert/point-in-time callers) still does exactly one scan.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await scan();
    if (found) return found;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout?.(250);
  }
  // Nothing visible in the budget: hand back the best existing locator (so a following click/assert
  // acts + fails with a clear, frame-searched error), or the primary candidate if truly absent.
  return lastExisting ?? makeLocatorCandidates(page, sel, fixtures, secrets, preferRole)[0] ?? null;
}

/** Button/link labels that dismiss the common cookie/consent/GDPR banners (OneTrust, Cookiebot,
 * Osano, …) that cover a freshly-loaded page. Ordered "accept everything" first so a run isn't
 * silently degraded to essential-only. Includes Vietnamese. */
const CONSENT_LABELS: RegExp[] = [
  /^accept all$/i, /^allow all$/i, /^accept all cookies$/i, /^accept cookies$/i,
  /^accept$/i, /^agree$/i, /^i agree$/i, /^got it$/i, /^allow$/i, /^ok$/i,
  /^đồng ý$/i, /^chấp nhận$/i, /^chấp nhận tất cả$/i,
];

/**
 * Best-effort: dismiss a cookie/consent overlay so it stops covering the page (locked decision:
 * auto-dismiss on by default). Tries role=button then plain text, across the main frame and any
 * CMP iframe. Never throws and never fails a run — returns the label it clicked, or null. Runs
 * once after navigation; users can still add an explicit `tapIfVisible "Accept…"` step for edge
 * cases the auto-pass misses.
 */
export async function autoDismissConsent(page: any): Promise<string | null> {
  const roots: any[] = [page, ...(typeof page.frames === "function" ? page.frames() : [])];
  for (const re of CONSENT_LABELS) {
    for (const root of roots) {
      try {
        const byRole = root.getByRole?.("button", { name: re })?.first?.();
        if (byRole && (await byRole.isVisible().catch(() => false))) {
          await byRole.click({ timeout: 3000 }).catch(() => {});
          return re.source;
        }
        const byText = root.getByText?.(re)?.first?.();
        if (byText && (await byText.isVisible().catch(() => false))) {
          await byText.click({ timeout: 3000 }).catch(() => {});
          return re.source;
        }
      } catch {
        /* try the next label/root */
      }
    }
  }
  return null;
}

/**
 * Turn a raw engine error into an actionable diagnosis (locked decision: no more "waited and gave
 * up" with no cause). The classification keys off the Playwright error text + the step's target.
 */
export function diagnoseBrowserError(raw: string | undefined, sel: Selector): string {
  const msg = raw ?? "unknown error";
  const target = sel.text ?? sel.targetId ?? "the target";
  if (/Timeout.*exceeded|waiting for|not visible|to be visible/i.test(msg)) {
    return `Could not act on "${target}" in time. It may be inside an iframe that hasn't loaded, ` +
      `covered by an overlay/cookie banner, or the label may differ. Original: ${msg}`;
  }
  if (/intercepts pointer events|element is not clickable|obscured/i.test(msg)) {
    return `"${target}" is covered by another element (often a cookie/consent overlay). Add a step ` +
      `to dismiss it, or rely on auto-dismiss. Original: ${msg}`;
  }
  if (/strict mode|resolved to \d+ elements/i.test(msg)) {
    return `"${target}" matched multiple elements. Use a more specific text or a test id. Original: ${msg}`;
  }
  return msg;
}

const UNSUPPORTED = (action: string): StepOutcome => ({
  ok: false,
  error: `"${action}" is unsupported on the browser driver (see IR-SPEC.md's platform capability matrix).`,
});

const NO_OP = (detail: string): StepOutcome => ({ ok: true, detail, backend: "browser" });

/**
 * Execute ONE IR step against an already-open browser session. Kept as a standalone function
 * (not a method) so it's directly unit-testable with a fake `session.page` — no real browser
 * needed. Consistent with the platform capability matrix in IR-SPEC.md §3: `hideKeyboard` is a
 * no-op, `swipe`/`launchApp`/`stopApp`/`raw` are unsupported (never silently "succeed").
 *
 * `secrets` (R2 follow-up — E12 originally left this path unwired, inconsistent with the
 * mobile/Android drivers) is an OPTIONAL, already-resolved `${secret:name}` -> value map,
 * threaded alongside `fixtures` everywhere a step field gets interpolated — same "separate
 * parameter, never merged into fixtures" contract as bridge/runner.ts and
 * bridge/android-driver.ts (see bridge/secrets.ts).
 */
export async function mapStepToBrowserAction(
  step: FlowStep,
  session: BrowserSession,
  fixtures: Record<string, unknown> = {},
  secrets?: Record<string, string>,
): Promise<StepOutcome> {
  const { page } = session;
  const fx = fixtures;
  try {
    switch (step.action) {
      case "openLink": {
        await page.goto(interpolate(step.url, fx, secrets));
        return { ok: true, backend: "browser" };
      }
      case "tap": {
        await page.mouse.click(step.x, step.y);
        return { ok: true, backend: "browser" };
      }
      case "tapText": {
        const loc = await resolveLocator(page, step, fx, secrets, 10_000, true);
        if (!loc) return { ok: false, error: "tapText needs text or targetId" };
        await loc.click();
        return { ok: true, backend: "browser" };
      }
      case "doubleTap": {
        const loc = await resolveLocator(page, step, fx, secrets, 10_000, true);
        if (loc) await loc.dblclick();
        else if (step.x !== undefined && step.y !== undefined) await page.mouse.dblclick(step.x, step.y);
        else return { ok: false, error: "doubleTap needs text, targetId, or x/y" };
        return { ok: true, backend: "browser" };
      }
      case "longPress": {
        const loc = await resolveLocator(page, step, fx, secrets, 10_000, true);
        if (loc) await loc.click({ delay: 600 });
        else if (step.x !== undefined && step.y !== undefined) await page.mouse.click(step.x, step.y, { delay: 600 });
        else return { ok: false, error: "longPress needs text, targetId, or x/y" };
        return { ok: true, backend: "browser" };
      }
      case "tapIfVisible": {
        const loc = await resolveLocator(page, { text: step.text }, fx, secrets);
        const visible = await loc?.isVisible?.().catch(() => false);
        if (visible) await loc.click();
        return { ok: true, backend: "browser", detail: visible ? "tapped" : "not visible — skipped" };
      }
      case "type": {
        await page.keyboard.type(interpolate(step.text, fx, secrets));
        if (step.submit) await page.keyboard.press("Enter");
        return { ok: true, backend: "browser" };
      }
      case "clearText": {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        return { ok: true, backend: "browser" };
      }
      case "deleteText": {
        for (let i = 0; i < step.count; i++) await page.keyboard.press("Backspace");
        return { ok: true, backend: "browser" };
      }
      case "pasteText": {
        // This callback runs inside the browser (Playwright serializes it there), where
        // `navigator` genuinely exists — the `globalThis as any` cast is only to satisfy this
        // file's own Node-only (no-DOM-lib) tsconfig, not a runtime workaround.
        const text: string = await page.evaluate(() => (globalThis as any).navigator.clipboard.readText());
        await page.keyboard.type(text);
        return { ok: true, backend: "browser" };
      }
      case "copyText": {
        const loc = await resolveLocator(page, step, fx, secrets, 10_000, true);
        if (!loc) return { ok: false, error: "copyText needs a text target" };
        const text = await loc.innerText();
        await page.evaluate((t: string) => (globalThis as any).navigator.clipboard.writeText(t), text);
        return { ok: true, backend: "browser", detail: text };
      }
      case "key": {
        const KEY_MAP: Record<string, string> = { enter: "Enter", backspace: "Backspace", tab: "Tab" };
        if (step.key in KEY_MAP) {
          await page.keyboard.press(KEY_MAP[step.key]);
          return { ok: true, backend: "browser" };
        }
        if (step.key === "back") {
          await page.goBack();
          return { ok: true, backend: "browser" };
        }
        // home/lock/volume up/volume down/power: mobile-only, no browser equivalent (IR-SPEC.md §3 footnote).
        return NO_OP(`key "${step.key}" has no browser equivalent — no-op`);
      }
      case "waitFor": {
        const timeout = step.timeoutMs ?? 10_000;
        // Find the frame that holds the target within the budget, THEN wait for it to be visible.
        const loc = await resolveLocator(page, { text: step.text }, fx, secrets, timeout);
        await loc.waitFor({ state: "visible", timeout });
        return { ok: true, backend: "browser" };
      }
      case "waitForNotVisible": {
        const loc = await resolveLocator(page, { text: step.text }, fx, secrets);
        await loc.waitFor({ state: "hidden", timeout: step.timeoutMs ?? 10_000 });
        return { ok: true, backend: "browser" };
      }
      case "waitMs": {
        await page.waitForTimeout(step.ms);
        return { ok: true, backend: "browser" };
      }
      case "assertVisible": {
        const loc = await resolveLocator(page, { text: step.text }, fx, secrets);
        const visible = await loc.isVisible().catch(() => false);
        return visible
          ? { ok: true, backend: "browser" }
          : { ok: false, error: `"${step.text}" is not visible`, backend: "browser" };
      }
      case "assertNotVisible": {
        const loc = await resolveLocator(page, { text: step.text }, fx, secrets);
        const visible = await loc.isVisible().catch(() => false);
        return !visible
          ? { ok: true, backend: "browser" }
          : { ok: false, error: `"${step.text}" is visible (expected NOT visible)`, backend: "browser" };
      }
      case "scroll": {
        const dy = step.direction === "up" ? -600 : step.direction === "down" || !step.direction ? 600 : 0;
        await page.mouse.wheel(0, dy);
        return { ok: true, backend: "browser" };
      }
      case "scrollUntilVisible": {
        // Loop-scroll until the target becomes visible, RE-RESOLVING across frames each pass: a
        // bare one-shot locator hangs (or misses) whenever the element isn't in the DOM yet — the
        // common case on gallery/infinite/lazy pages AND cross-origin iframes that mount late.
        const deadline = Date.now() + 15_000;
        for (;;) {
          const loc = await resolveLocator(page, { text: step.text }, fx, secrets);
          if (loc && (await loc.isVisible().catch(() => false))) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            return { ok: true, backend: "browser" };
          }
          if (Date.now() > deadline) {
            return { ok: false, error: `"${step.text}" not visible after scrolling`, backend: "browser" };
          }
          await page.mouse.wheel(0, 700);
          await page.waitForTimeout(400);
        }
      }
      case "back": {
        await page.goBack();
        return { ok: true, backend: "browser" };
      }
      case "screenshot": {
        await page.screenshot({ path: undefined }); // caller wires a real path via a future ctx; MVP just proves the call
        return { ok: true, backend: "browser" };
      }
      case "hideKeyboard":
        return NO_OP("no on-screen keyboard on a desktop browser — no-op");
      case "swipe":
      case "launchApp":
      case "stopApp":
      case "raw":
        return UNSUPPORTED(step.action);
      default:
        return UNSUPPORTED((step as FlowStep).action);
    }
  } catch (err: any) {
    // Actionable diagnosis (locked decision): translate raw engine timeouts/overlays/strict-mode
    // errors into "what to do", keyed off this step's own selector fields.
    const sel: Selector = {
      text: (step as any).text,
      targetId: (step as any).targetId,
      x: (step as any).x,
      y: (step as any).y,
    };
    return { ok: false, error: diagnoseBrowserError(err?.message ?? String(err), sel), backend: "browser" };
  }
}

/**
 * Per-action retry with idempotency (E2 AC2/AC3, applied to the browser path per E16's worker
 * lifecycle). Reuses the EXACT SAME transient-failure heuristic and retry cap `bridge/runner.ts`
 * uses for the mobile path (`isTransientError`/`MAX_RETRIES`, imported not reimplemented) —
 * mirrors `bridge/android-driver.ts`'s `runAndroidStepWithRetry`, the established per-platform
 * pattern for this — so retry behavior can't silently diverge between platforms.
 */
export async function runBrowserStepWithRetry(
  step: FlowStep,
  session: BrowserSession,
  fixtures: Record<string, unknown> = {},
  secrets?: Record<string, string>,
): Promise<{ outcome: StepOutcome; attempts: number }> {
  const canRetry = isStepIdempotent(step);
  let attempts = 0;
  let outcome: StepOutcome;
  for (;;) {
    attempts += 1;
    outcome = await mapStepToBrowserAction(step, session, fixtures, secrets);
    if (outcome.ok) return { outcome, attempts };
    if (!canRetry || attempts > MAX_RETRIES || !isTransientError(outcome.error)) return { outcome, attempts };
  }
}

/**
 * Run one Flow against one browser context (E16 AC4: a FRESH context per flow — `worker`'s
 * process is reused, only the context this function opens/closes is scoped to this one call).
 * Mirrors `bridge/runner.ts`'s `runFlow` closely (same RunEvent stream, same RunSummary shape,
 * same secrets preflight/redaction, same soft-assert/skip-on-hard-failure/cancel semantics) —
 * deliberately a SEPARATE function rather than a change to `runFlow` itself: `runFlow` is
 * mobile-specific end to end (`engine.appState`/`engine.launchApp`/`engine.screenshot`), and
 * generalizing it to dispatch through the `Driver` seam for every platform is the larger,
 * riskier refactor `bridge/driver.ts`'s own comment flags as NOT this epic's job (and which
 * `bridge/android-driver.ts`, E10, didn't attempt either — same precedent). Keeping this
 * self-contained means zero risk of regressing the mobile run path (T4 DoD: "no regression of
 * E15 gates").
 */
export async function runBrowserFlow(
  worker: BrowserWorker,
  flow: Flow,
  fixtures: Record<string, unknown>,
  emitRaw: (e: RunEvent) => void,
  ctx: RunContext = createRunContext(),
  artifactsDir?: string,
): Promise<RunSummary> {
  const { runId } = ctx;
  const startedAt = Date.now();
  // RunSummary.udid has no browser-native equivalent — a worker id, not a real device
  // identifier. E17 (WebView-aware inspector + target profile) owns giving browser flows a
  // proper target model; this is a clearly-labeled placeholder, not a repurposed device id.
  const udid = `browser-worker-${worker.workerId}`;

  const secrets: Record<string, string> = {};
  const emit = (e: RunEvent) => emitRaw(redactRunEvent(e, secrets));

  const enabled = flow.steps.filter((s) => !s.disabled);
  const baseFixtures = { ...(flow.fixtures ?? {}), ...fixtures };
  const captured: Record<string, string> = {};
  const total = enabled.length;

  emit({ type: "run:start", runId, total, flowName: flow.name });

  // Secrets preflight (E12), identical contract to runFlow's: resolve every ${secret:name} once,
  // up front, fail fast and redacted if one is missing.
  const secretNames = collectSecretRefs(flow);
  if (secretNames.length > 0) {
    try {
      Object.assign(secrets, await resolveSecrets(secretNames));
    } catch (err: any) {
      const message = redactSecrets(err?.message ?? String(err), secrets);
      emit({ type: "log", runId, level: "error", message });
      const summary: RunSummary = {
        runId, flowName: flow.name, udid, bundleId: flow.app.bundleId, passed: false, status: "failed",
        total, passedCount: 0, failedCount: 0, softFailedCount: 0, durationMs: Date.now() - startedAt,
        startedAt, results: [],
      };
      emit({ type: "run:end", runId, summary });
      throw new Error(message);
    }
  }

  // AC4: a fresh, cookie/localStorage-isolated context for THIS flow — the worker's one process
  // is reused, only this context is new. `recordDir` (when we have an artifacts dir) records a
  // video of the whole flow — part of the locked per-run evidence set.
  const session = await worker.newContextForFlow(artifactsDir ? { recordDir: artifactsDir } : undefined);

  // Playwright trace (DOM/network/console timeline) — best-effort; cloakbrowser contexts may not
  // expose `tracing`. Stopped + saved in the finally below.
  let tracing = false;
  if (artifactsDir) {
    try {
      await session.context?.tracing?.start?.({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
    } catch {
      /* engine without tracing — evidence degrades to screenshots+video, never fails the run */
    }
  }

  const results: StepResult[] = [];
  let passed = true;
  let cancelled = false;

  try {
    for (let i = 0; i < enabled.length; i++) {
      const step = enabled[i];

      // Honor a Stop request between steps, checked against THIS run's own context — a
      // concurrent run's cancel never affects this one (E15 AC3, proven again on the browser path).
      if (ctx.cancelled) {
        emit({ type: "log", runId, level: "warn", message: "Run stopped by user" });
        for (let j = i; j < enabled.length; j++) {
          const skipped: StepResult = { index: j, stepId: enabled[j].id, action: enabled[j].action, status: "skipped", ok: false };
          results.push(skipped);
          emit({ type: "step:result", runId, result: skipped });
        }
        passed = false;
        cancelled = true;
        break;
      }

      emit({ type: "step:start", runId, index: i, stepId: step.id, action: step.action });
      const stepStart = Date.now();
      const result: StepResult = { index: i, stepId: step.id, action: step.action, status: "running", ok: false, startedAt: stepStart };

      const stepFixtures = { ...baseFixtures, ...captured };
      const { outcome, attempts } = await runBrowserStepWithRetry(step, session, stepFixtures, secrets);
      result.ok = outcome.ok;
      result.backend = outcome.backend ?? "browser";
      result.attempts = attempts;
      if (outcome.detail) result.detail = outcome.detail;
      if (!outcome.ok) result.error = outcome.error;

      if (outcome.ok && step.captureAs) captured[step.captureAs] = outcome.detail ?? "";

      // Locked decision: after any navigation, best-effort dismiss a cookie/consent overlay so it
      // stops covering the page (the exact blocker behind the demo app "Play Now" failure). Never
      // fails the step; logs when it acts so it's visible in the run.
      if (outcome.ok && step.action === "openLink") {
        const dismissed = await autoDismissConsent(session.page).catch(() => null);
        if (dismissed) {
          emit({ type: "log", runId, level: "info", message: `Auto-dismissed a consent overlay (matched /${dismissed}/).` });
          // Accepting consent commonly triggers a full reload (CMPs re-init the page). Wait for it to
          // settle so the NEXT step acts on the reloaded, interactive DOM — not the stale pre-reload
          // one (which is why an immediate tap was a silent no-op on the demo app lobby button).
          await session.page.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => {});
        }
      }

      // Evidence: screenshot after every step, same as runFlow's mobile path — now actually
      // wiring the real path mapStepToBrowserAction's own "screenshot" case comment flagged as
      // "a future ctx" (this IS that future ctx). Best-effort: never fails the step over it.
      if (artifactsDir) {
        try {
          const shotPath = join(artifactsDir, `step-${String(i).padStart(3, "0")}-${step.action}.png`);
          await session.page.screenshot({ path: shotPath });
          result.screenshot = shotPath;
        } catch {
          /* best-effort evidence */
        }
      }

      result.status = outcome.ok ? "passed" : step.soft ? "failed-soft" : "failed";
      result.finishedAt = Date.now();
      results.push(result);
      emit({ type: "step:result", runId, result });

      if (!outcome.ok && !step.soft) {
        passed = false;
        for (let j = i + 1; j < enabled.length; j++) {
          const skipped: StepResult = { index: j, stepId: enabled[j].id, action: enabled[j].action, status: "skipped", ok: false };
          results.push(skipped);
          emit({ type: "step:result", runId, result: skipped });
        }
        break;
      }
    }
  } finally {
    // Stop + save the Playwright trace BEFORE closing the context (tracing.stop needs a live
    // context). Best-effort — never let evidence capture fail a run.
    if (tracing && artifactsDir) {
      try {
        await session.context?.tracing?.stop?.({ path: join(artifactsDir, "trace.zip") });
      } catch {
        /* trace unavailable — screenshots+video remain */
      }
    }
    // Grab the video handle before close (its file is finalized ON close, but the handle is on the
    // page created within this context).
    const videoHandle = artifactsDir ? session.page?.video?.() : undefined;
    // The CONTEXT is scoped to this one flow — close it so the next flow on this same worker
    // starts from zero cookies/storage again (AC4), without killing the process itself.
    try {
      await session.context?.close?.();
    } catch {
      /* best-effort */
    }
    if (videoHandle) {
      try {
        const videoPath = await videoHandle.path();
        if (videoPath) emit({ type: "log", runId, level: "info", message: `Run video saved: ${videoPath}` });
      } catch {
        /* video path unavailable */
      }
    }
  }

  const softFailedCount = results.filter((r) => r.status === "failed-soft").length;
  const status: RunStatus = cancelled ? "cancelled" : passed ? "passed" : "failed";
  const summary: RunSummary = {
    runId, flowName: flow.name, udid, bundleId: flow.app.bundleId, passed, status, total,
    passedCount: results.filter((r) => r.status === "passed").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    softFailedCount, durationMs: Date.now() - startedAt, startedAt, results,
  };
  const redactedSummary = redactSummary(summary, secrets);
  emit({ type: "run:end", runId, summary: redactedSummary });
  return redactedSummary;
}

// ── Browser suite (E16 consuming E15) ───────────────────────────────────────────────────────
// Reuses bridge/orchestrator.ts's pool/concurrency/sharding/registry primitives AS-IS (never
// reimplementing them, never modifying that file — it stays driver-agnostic) to drive many
// `BrowserWorker`s in parallel. The one thing orchestrator.ts's generic `runSuite` can't offer
// out of the box is "one long-lived resource (a browser process) shared by every job in a
// shard, torn down when the shard finishes" — its per-job `run(ctx, slot)` callback has no
// "this shard just finished" hook. So this loop has the SAME shape as `runSuite`'s (shard ->
// acquire a slot -> run each job -> release), just with a `BrowserWorker` launched once per
// shard and closed in that shard's `finally`, alongside the slot release.

export interface BrowserSuiteJob {
  tag?: string;
  flow: Flow;
  fixtures?: Record<string, unknown>;
}

export interface BrowserSuiteOptions {
  concurrency?: number;
  shard?: "round-robin" | "by-tag";
  runtimeDir?: string;
  emit?: (e: RunEvent) => void;
  /** Test-only override — production callers should omit this (defaults to the real
   * `launchBrowserWorker`, which needs an actual browser runtime installed). */
  launchWorkerFn?: (slot: BrowserWorkerSlot) => Promise<BrowserWorker>;
}

export async function runBrowserSuite(
  jobs: BrowserSuiteJob[],
  options: BrowserSuiteOptions = {},
): Promise<SuiteReport<RunSummary>> {
  const suiteId = randomUUID();
  const startedAt = Date.now();

  if (jobs.length === 0) {
    return { suiteId, startedAt, durationMs: 0, concurrency: 0, workers: [], results: [] };
  }

  const concurrency = computeConcurrency(options.concurrency ?? jobs.length);
  const portPool = createPortPool(Math.max(concurrency, 1));
  const profilePool = createProfilePool(portPool, suiteId, options.runtimeDir);
  const shards = shardJobs(jobs, concurrency, options.shard ?? "round-robin");
  const emit = options.emit ?? (() => {});
  const launchWorkerFn = options.launchWorkerFn ?? launchBrowserWorker;

  const workers = await Promise.all(
    shards.map(async (shardJobs, workerId): Promise<WorkerReport<RunSummary> | null> => {
      if (shardJobs.length === 0) return null; // fewer jobs than concurrency slots
      const slot = await profilePool.acquire(workerId);
      const results: RunSummary[] = [];
      let browserWorker: BrowserWorker | undefined;
      try {
        // ONE process for the WHOLE shard (AC4) — launched once, reused by every job below.
        browserWorker = await launchWorkerFn({ workerId, port: slot.port, profileDir: slot.profileDir });
        for (const job of shardJobs) {
          const ctx = createRunContext();
          registerRun(ctx); // same registry /api/cancel already uses for mobile runs (E15)
          try {
            results.push(await runBrowserFlow(browserWorker, job.flow, job.fixtures ?? {}, emit, ctx, slot.artifactsDir));
          } finally {
            unregisterRun(ctx.runId);
          }
        }
      } finally {
        await browserWorker?.close();
        await profilePool.release(slot);
      }
      return { workerId, port: slot.port, profileDir: slot.profileDir, artifactsDir: slot.artifactsDir, results };
    }),
  );

  const activeWorkers = workers.filter((w): w is WorkerReport<RunSummary> => w !== null);
  return {
    suiteId,
    startedAt,
    durationMs: Date.now() - startedAt,
    concurrency,
    workers: activeWorkers,
    results: activeWorkers.flatMap((w) => w.results),
  };
}

/**
 * The `Driver` implementation for the browser platform (E7). Wraps `getSession()` +
 * `mapStepToBrowserAction` behind the same `Driver` seam `mobileDriver` implements
 * (bridge/driver.ts / bridge/runner.ts) — see PILLAR-BROWSER-E2E.md §4: "Browser is a new
 * Driver behind the existing Driver interface, not a fork of the product."
 */
export const browserDriver: Driver = {
  platform: "browser",
  name: "cloakbrowser (playwright fallback)",
  async isAvailable() {
    const d = await detectBrowserRuntime();
    return { ok: d.ok, reason: d.reason };
  },
  async executeStep(step: FlowStep, ctx: DriverContext): Promise<StepOutcome> {
    try {
      const session = await getSession();
      return await mapStepToBrowserAction(step, session, ctx.fixtures ?? {}, ctx.secrets);
    } catch (err: any) {
      // Graceful, honest failure when the runtime isn't installed — never fakes success.
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
};
