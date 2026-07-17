import { describe, it, expect, vi } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import type { RunEvent } from "../shared/protocol.ts";
import {
  browserDriver,
  closeBrowserSession,
  detectBrowserRuntime,
  launchBrowserWorker,
  mapStepToBrowserAction,
  PINNED_CHROMIUM_VERSION,
  runBrowserFlow,
  runBrowserStepWithRetry,
  runBrowserSuite,
  type BrowserSession,
  type BrowserSuiteJob,
  type BrowserWorker,
  type BrowserWorkerSlot,
} from "../bridge/browser-driver.ts";

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep =>
  ({ id: "s1", ...over } as FlowStep);

function makeFakeLocator(overrides: Record<string, unknown> = {}) {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    // Frame-aware resolveLocator probes count() to decide which frame holds the target; default 1
    // (present on the main frame) keeps the fast path, matching the pre-frame behavior every test
    // below already asserts.
    count: vi.fn().mockResolvedValue(1),
    waitFor: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue("captured text"),
    ...overrides,
  };
}

function makeFakePage(locatorOverrides: Record<string, unknown> = {}) {
  const locator = makeFakeLocator(locatorOverrides);
  // resolveLocator now returns `.first()` (substring matches can hit multiple elements); the fake
  // locator's .first() resolves to itself so assertions on click/waitFor/etc. still see the calls.
  (locator as any).first = vi.fn(() => locator);
  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    mouse: {
      click: vi.fn().mockResolvedValue(undefined),
      dblclick: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    keyboard: { type: vi.fn().mockResolvedValue(undefined), press: vi.fn().mockResolvedValue(undefined) },
    getByText: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
  };
  // Frame-aware resolveLocator asks the page for its frames; a single-frame page returns just
  // itself as the main frame, so the child-frame search never runs (fast path preserved).
  page.frames = vi.fn(() => [page]);
  page.mainFrame = vi.fn(() => page);
  return { page, locator };
}

function makeSession(page: any): BrowserSession {
  return { page, context: {}, browser: {}, driverName: "playwright", browserVersion: "145.0" };
}

describe("mapStepToBrowserAction — IR to browser action mapping", () => {
  it("openLink -> page.goto, interpolating {{fixtures}}", async () => {
    const { page } = makeFakePage();
    const result = await mapStepToBrowserAction(
      s({ action: "openLink", url: "https://example.com/{{path}}" }),
      makeSession(page),
      { path: "login" },
    );
    expect(page.goto).toHaveBeenCalledWith("https://example.com/login");
    expect(result.ok).toBe(true);
  });

  it("tap -> page.mouse.click(x, y)", async () => {
    const { page } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "tap", x: 10, y: 20 }), makeSession(page));
    expect(page.mouse.click).toHaveBeenCalledWith(10, 20);
    expect(result.ok).toBe(true);
  });

  it("tapText by text -> getByText with a case-insensitive SUBSTRING regex, then .click()", async () => {
    const { page, locator } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "tapText", text: "Login" }), makeSession(page));
    expect(page.getByText).toHaveBeenCalledTimes(1);
    const arg = page.getByText.mock.calls[0][0] as RegExp;
    expect(arg.test("login")).toBe(true); // case-insensitive
    expect(arg.test("Please Login here")).toBe(true); // substring, not anchored (QA audit RUN-3 lesson)
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("tapText by targetId -> getByTestId (IR-SPEC.md §5 preferred locator)", async () => {
    const { page, locator } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "tapText", targetId: "login-button" }), makeSession(page));
    expect(page.getByTestId).toHaveBeenCalledWith("login-button");
    expect(locator.click).toHaveBeenCalledTimes(1);
  });

  it("tapText with neither text nor targetId fails without touching the page", async () => {
    const { page } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "tapText" }), makeSession(page));
    expect(result.ok).toBe(false);
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it("doubleTap -> locator.dblclick()", async () => {
    const { page, locator } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "doubleTap", text: "Item" }), makeSession(page));
    expect(locator.dblclick).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("longPress -> locator.click({ delay: 600 })", async () => {
    const { page, locator } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "longPress", targetId: "item" }), makeSession(page));
    expect(locator.click).toHaveBeenCalledWith({ delay: 600 });
  });

  it("tapIfVisible: clicks when visible, no-ops (still ok) when not visible", async () => {
    const { page: visiblePage, locator: visibleLoc } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
    const visibleResult = await mapStepToBrowserAction(s({ action: "tapIfVisible", text: "Popup" }), makeSession(visiblePage));
    expect(visibleLoc.click).toHaveBeenCalledTimes(1);
    expect(visibleResult.ok).toBe(true);

    const { page: hiddenPage, locator: hiddenLoc } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(false) });
    const hiddenResult = await mapStepToBrowserAction(s({ action: "tapIfVisible", text: "Popup" }), makeSession(hiddenPage));
    expect(hiddenLoc.click).not.toHaveBeenCalled();
    expect(hiddenResult.ok).toBe(true); // never fails the run, per IR semantics
  });

  it("type -> keyboard.type, + Enter when submit is set", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "type", text: "hello {{name}}", submit: true }), makeSession(page), { name: "Ada" });
    expect(page.keyboard.type).toHaveBeenCalledWith("hello Ada");
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("clearText -> Control+A then Backspace", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "clearText" }), makeSession(page));
    expect(page.keyboard.press).toHaveBeenNthCalledWith(1, "Control+A");
    expect(page.keyboard.press).toHaveBeenNthCalledWith(2, "Backspace");
  });

  it("deleteText -> Backspace pressed exactly `count` times", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "deleteText", count: 3 }), makeSession(page));
    expect(page.keyboard.press).toHaveBeenCalledTimes(3);
    expect(page.keyboard.press).toHaveBeenCalledWith("Backspace");
  });

  it("copyText -> reads locator.innerText() and writes it to the clipboard", async () => {
    const { page, locator } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "copyText", text: "Code" }), makeSession(page));
    expect(locator.innerText).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(result.detail).toBe("captured text");
  });

  it("pasteText -> reads clipboard via evaluate, types it", async () => {
    const { page } = makeFakePage();
    page.evaluate.mockResolvedValue("clipboard value");
    await mapStepToBrowserAction(s({ action: "pasteText" }), makeSession(page));
    expect(page.keyboard.type).toHaveBeenCalledWith("clipboard value");
  });

  it("key: enter/backspace/tab map to keyboard.press; back navigates; mobile-only values no-op", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "key", key: "enter" } as any), makeSession(page));
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");

    const { page: page2 } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "key", key: "back" } as any), makeSession(page2));
    expect(page2.goBack).toHaveBeenCalledTimes(1);

    const { page: page3 } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "key", key: "volume up" } as any), makeSession(page3));
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/no browser equivalent/);
    expect(page3.keyboard.press).not.toHaveBeenCalled();
  });

  it("waitFor -> locator.waitFor({state:'visible', timeout})", async () => {
    const { page, locator } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "waitFor", text: "Home", timeoutMs: 5000 }), makeSession(page));
    expect(locator.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 5000 });
  });

  it("waitForNotVisible -> locator.waitFor({state:'hidden', timeout})", async () => {
    const { page, locator } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "waitForNotVisible", text: "Spinner" }), makeSession(page));
    expect(locator.waitFor).toHaveBeenCalledWith({ state: "hidden", timeout: 10_000 });
  });

  it("waitMs -> page.waitForTimeout(ms)", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "waitMs", ms: 1500 }), makeSession(page));
    expect(page.waitForTimeout).toHaveBeenCalledWith(1500);
  });

  it("assertVisible: ok when visible, fails with a clear message when not", async () => {
    const { page: p1 } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
    expect((await mapStepToBrowserAction(s({ action: "assertVisible", text: "Welcome" }), makeSession(p1))).ok).toBe(true);

    const { page: p2 } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(false) });
    const failResult = await mapStepToBrowserAction(s({ action: "assertVisible", text: "Welcome" }), makeSession(p2));
    expect(failResult.ok).toBe(false);
    expect(failResult.error).toMatch(/not visible/);
  });

  it("assertNotVisible: ok when absent, fails when present", async () => {
    const { page: p1 } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(false) });
    expect((await mapStepToBrowserAction(s({ action: "assertNotVisible", text: "Error" }), makeSession(p1))).ok).toBe(true);

    const { page: p2 } = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
    const failResult = await mapStepToBrowserAction(s({ action: "assertNotVisible", text: "Error" }), makeSession(p2));
    expect(failResult.ok).toBe(false);
  });

  it("scroll: up/down wheel direction", async () => {
    const { page: up } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "scroll", direction: "up" }), makeSession(up));
    expect(up.mouse.wheel).toHaveBeenCalledWith(0, -600);

    const { page: down } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "scroll" }), makeSession(down));
    expect(down.mouse.wheel).toHaveBeenCalledWith(0, 600);
  });

  it("scrollUntilVisible -> locator.scrollIntoViewIfNeeded()", async () => {
    const { page, locator } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "scrollUntilVisible", text: "Footer" }), makeSession(page));
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("back -> page.goBack()", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "back" }), makeSession(page));
    expect(page.goBack).toHaveBeenCalledTimes(1);
  });

  it("screenshot -> page.screenshot() is called and reports ok", async () => {
    const { page } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "screenshot" }), makeSession(page));
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("hideKeyboard is a no-op (IR-SPEC.md §3's canonical example) — never fails, touches nothing", async () => {
    const { page } = makeFakePage();
    const result = await mapStepToBrowserAction(s({ action: "hideKeyboard" }), makeSession(page));
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/no-op/);
  });

  it.each(["swipe", "launchApp", "stopApp", "raw"] as const)(
    "%s is unsupported on the browser driver — fails honestly, never fakes success",
    async (action) => {
      const { page } = makeFakePage();
      const step = action === "raw" ? s({ action: "raw", maestro: "- tapOn: X" }) : s({ action });
      const result = await mapStepToBrowserAction(step, makeSession(page));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unsupported/);
    },
  );

  it("never throws: a page-level error is caught and returned as a failed StepOutcome", async () => {
    const { page } = makeFakePage();
    page.goto.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    const result = await mapStepToBrowserAction(s({ action: "openLink", url: "https://nope.invalid" }), makeSession(page));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe("mapStepToBrowserAction — secrets threading (R2 follow-up: E12 left the browser path unwired)", () => {
  it("openLink resolves a ${secret:...} in the URL", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(
      s({ action: "openLink", url: "https://example.com/login?token=${secret:apiToken}" }),
      makeSession(page),
      {},
      { apiToken: "hunter2" },
    );
    expect(page.goto).toHaveBeenCalledWith("https://example.com/login?token=hunter2");
  });

  it("type resolves a ${secret:...} into the keyboard input", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(
      s({ action: "type", text: "${secret:password}" }),
      makeSession(page),
      {},
      { password: "hunter2" },
    );
    expect(page.keyboard.type).toHaveBeenCalledWith("hunter2");
  });

  it("tapText's selector text resolves a ${secret:...} the same way {{fixtures}} does", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(
      s({ action: "tapText", text: "${secret:buttonLabel}" }),
      makeSession(page),
      {},
      { buttonLabel: "Sign In" },
    );
    const arg = page.getByText.mock.calls[0][0] as RegExp;
    expect(arg.test("Sign In")).toBe(true);
  });

  it("leaves the ${secret:...} token untouched when no secrets map is passed (same contract as interpolate())", async () => {
    const { page } = makeFakePage();
    await mapStepToBrowserAction(s({ action: "type", text: "${secret:password}" }), makeSession(page), {});
    expect(page.keyboard.type).toHaveBeenCalledWith("${secret:password}");
  });
});

describe("browserDriver.executeStep — threads ctx.secrets into mapStepToBrowserAction", () => {
  it("never leaks a ${secret:...} value in the result, whether the run succeeds or fails", async () => {
    // executeStep goes through the real getSession(). With a shared Chromium present it launches
    // and the step succeeds; without one it fails gracefully. EITHER way, the security contract
    // holds: the secret value never appears anywhere in the returned result. `about:blank`-free
    // `type` needs no network, so this is fast and offline-safe.
    const result = await browserDriver.executeStep(
      { id: "s1", action: "type", text: "${secret:password}" } as FlowStep,
      { secrets: { password: "hunter2" } },
    );
    expect(typeof result.ok).toBe("boolean");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    await closeBrowserSession();
  }, 30_000); // genuinely launches a real browser where a shared Chromium exists — needs headroom
});

describe("detectBrowserRuntime — honest runtime detection (E7: 'do NOT fake success')", () => {
  it("reports availability without throwing, regardless of whether a runtime is installed", async () => {
    const result = await detectBrowserRuntime();
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
      expect(result.reason).toMatch(/cloakbrowser|playwright/i);
    } else {
      expect(["cloakbrowser", "playwright"]).toContain(result.driverName);
    }
  });

  it("PINNED_CHROMIUM_VERSION is a single fixed value, not a range (E7 AC4)", () => {
    expect(PINNED_CHROMIUM_VERSION).toMatch(/^\d+$/);
  });
});

describe("browserDriver — Driver interface conformance", () => {
  it("has the shape of a Driver (platform, name, isAvailable, executeStep)", () => {
    expect(browserDriver.platform).toBe("browser");
    expect(typeof browserDriver.name).toBe("string");
    expect(typeof browserDriver.isAvailable).toBe("function");
    expect(typeof browserDriver.executeStep).toBe("function");
  });

  it("isAvailable() mirrors detectBrowserRuntime()'s honest result", async () => {
    const [driverResult, directResult] = await Promise.all([browserDriver.isAvailable(), detectBrowserRuntime()]);
    expect(driverResult.ok).toBe(directResult.ok);
  });

  it("executeStep() never throws and returns a well-formed result (engine present → ok; absent → graceful error)", async () => {
    // Environment-independent contract: with a shared Chromium the engine launches and this
    // succeeds; without one it fails gracefully. `about:blank` keeps it offline + fast either way.
    const result = await browserDriver.executeStep(
      { id: "s1", action: "openLink", url: "about:blank" } as FlowStep,
      {},
    );
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);
    }
    await closeBrowserSession();
  }, 30_000); // genuinely launches a real browser where a shared Chromium exists — needs headroom
});

// ─── E16 — Browser E2E driver (worker lifecycle + concurrency via E15) ─────────────────────────

/** A fake "cloakbrowser"/"playwright" module: `launch()` resolves to a fake browser whose
 * `newContext()` can be called many times (process-reuse-per-shard, AC4), each returning a
 * fresh, independent context/page pair so tests can prove isolation between calls. */
function makeFakeBrowserModule(opts: { pid?: number; version?: string } = {}) {
  const contexts: any[] = [];
  const fakeBrowser = {
    newContext: vi.fn(async () => {
      const page = { screenshot: vi.fn().mockResolvedValue(undefined), goto: vi.fn().mockResolvedValue(undefined) };
      const context = { close: vi.fn().mockResolvedValue(undefined), newPage: vi.fn().mockResolvedValue(page), _page: page };
      contexts.push(context);
      return context;
    }),
    newPage: vi.fn(), // some callers go through context.newPage() instead — see launch() below
    close: vi.fn().mockResolvedValue(undefined),
    process: vi.fn(() => (opts.pid !== undefined ? { pid: opts.pid } : undefined)),
    version: vi.fn().mockResolvedValue(opts.version ?? "145.0.0"),
  };
  const launch = vi.fn(async (_launchOpts: any) => {
    const context = await fakeBrowser.newContext();
    return { browser: fakeBrowser, context, page: await context.newPage() };
  });
  return { module: { launch, chromium: { launch: vi.fn().mockResolvedValue(fakeBrowser) } }, fakeBrowser, contexts };
}

function makeSlot(overrides: Partial<BrowserWorkerSlot> = {}): BrowserWorkerSlot {
  return { workerId: 0, port: 9223, profileDir: "/tmp/podium-studio-test-profile", ...overrides };
}

describe("detectBrowserRuntime — driver-selection preference (E16 AC2)", () => {
  it("'auto'/default tries Playwright first (locked Playwright-default decision, WEB-E2E-STRATEGY.md)", async () => {
    const loader = vi.fn(async (name: string) => ({ name }));
    const result = await detectBrowserRuntime(loader, "auto");
    expect(result.driverName).toBe("playwright");
    expect(loader).toHaveBeenCalledWith("playwright-core"); // playwright resolves to the vendored core
  });

  it("an explicit 'playwright' preference picks playwright even though cloakbrowser is ALSO importable — the config knob AC2 needs", async () => {
    const loader = vi.fn(async (name: string) => ({ name }));
    const result = await detectBrowserRuntime(loader, "playwright");
    expect(result.driverName).toBe("playwright");
  });

  it("an explicit 'cloakbrowser' preference still falls back to playwright if cloakbrowser genuinely isn't installed", async () => {
    const loader = vi.fn(async (name: string) => {
      if (name === "cloakbrowser") throw new Error("not installed");
      return { name };
    });
    const result = await detectBrowserRuntime(loader, "cloakbrowser");
    expect(result.ok).toBe(true);
    expect(result.driverName).toBe("playwright");
  });

  it("reports failure with neither importable, regardless of preference", async () => {
    const loader = vi.fn(async () => {
      throw new Error("nope");
    });
    const result = await detectBrowserRuntime(loader, "playwright");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cloakbrowser|playwright/i);
  });
});

describe("launchBrowserWorker — 1 process = 1 port = 1 profile (E16 AC4)", () => {
  it("cloakbrowser path: launches with the pinned Chromium version, this worker's port/profileDir, and NO license key on the Free path (AC3/AC4/AC5)", async () => {
    const { module, fakeBrowser } = makeFakeBrowserModule({ pid: 4242 });
    // Playwright is the default engine now, so force the cloakbrowser path by making Playwright
    // genuinely unimportable — exactly the "only CloakBrowser installed" situation this asserts.
    const loader = vi.fn(async (name: string) => {
      if (name.startsWith("playwright")) throw new Error("not installed");
      return module;
    });
    const slot = makeSlot({ workerId: 1, port: 9224, profileDir: "/tmp/worker-1" });

    delete process.env.CLOAKBROWSER_LICENSE_KEY;
    const worker = await launchBrowserWorker(slot, loader);

    expect(module.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        chromiumVersion: PINNED_CHROMIUM_VERSION,
        licenseKey: undefined, // AC5: Free path never sends a key
        userDataDir: "/tmp/worker-1",
        port: 9224,
      }),
    );
    expect(worker.workerId).toBe(1);
    expect(worker.port).toBe(9224);
    expect(worker.profileDir).toBe("/tmp/worker-1");
    expect(worker.driverName).toBe("cloakbrowser");
    expect(worker.pid).toBe(4242);
    void fakeBrowser; // referenced for clarity; already asserted via module.launch above
  });

  it("playwright fallback path: launches with --user-data-dir/--remote-debugging-port CLI args pinned to this worker's slot", async () => {
    const loader = vi.fn(async (name: string) => {
      if (name === "cloakbrowser") throw new Error("not installed");
      const { module } = makeFakeBrowserModule({ pid: 5555 });
      return module;
    });
    const slot = makeSlot({ workerId: 2, port: 9225, profileDir: "/tmp/worker-2" });
    const worker = await launchBrowserWorker(slot, loader);

    expect(worker.driverName).toBe("playwright");
    expect(worker.port).toBe(9225);
    expect(worker.pid).toBe(5555);
  });

  it("newContextForFlow() returns a FRESH context each call but the SAME process (AC4: new context per flow, process reused across the shard)", async () => {
    const { module } = makeFakeBrowserModule();
    const worker = await launchBrowserWorker(makeSlot(), async () => module);

    const s1 = await worker.newContextForFlow();
    const s2 = await worker.newContextForFlow();
    expect(s1.context).not.toBe(s2.context); // different context per flow
    expect(s1.browser).toBe(s2.browser); // SAME underlying process/browser
  });

  it("close() tears down the one process exactly once, best-effort (never throws even if close() itself rejects)", async () => {
    const { module, fakeBrowser } = makeFakeBrowserModule();
    const worker = await launchBrowserWorker(makeSlot(), async () => module);
    await worker.close();
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);

    fakeBrowser.close.mockRejectedValueOnce(new Error("already dead"));
    await expect(worker.close()).resolves.toBeUndefined(); // never throws
  });

  it("determinism (AC3): the reported browserVersion is IDENTICAL across 10 repeated launches against a fixed pinned build", async () => {
    const versions = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const { module } = makeFakeBrowserModule({ version: "145.0.7632" });
      const worker = await launchBrowserWorker(makeSlot({ workerId: i }), async () => module);
      versions.add(worker.browserVersion);
    }
    expect(versions.size).toBe(1); // exactly one distinct version across all 10 runs
  });

  it("Pro opt-in key hygiene (AC5): when CLOAKBROWSER_LICENSE_KEY IS set, it's threaded into launch() but never echoed back in the worker object itself", async () => {
    const { module } = makeFakeBrowserModule();
    // Force the cloakbrowser path (Playwright is the default engine) to exercise its key handling.
    const loader = vi.fn(async (name: string) => {
      if (name.startsWith("playwright")) throw new Error("not installed");
      return module;
    });
    process.env.CLOAKBROWSER_LICENSE_KEY = "super-secret-pro-key";
    try {
      const worker = await launchBrowserWorker(makeSlot(), loader);
      expect(module.launch).toHaveBeenCalledWith(expect.objectContaining({ licenseKey: "super-secret-pro-key" }));
      // The worker handle itself (what a caller might log/report) never contains the key value.
      expect(JSON.stringify(worker)).not.toContain("super-secret-pro-key");
    } finally {
      delete process.env.CLOAKBROWSER_LICENSE_KEY;
    }
  });

  it("never fakes success: rejects with a clear message when neither engine is importable", async () => {
    const loader = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(launchBrowserWorker(makeSlot(), loader)).rejects.toThrow(/cloakbrowser|playwright/i);
  });
});

describe("runBrowserStepWithRetry — same transient-failure heuristic as the mobile path (E2, reused not reimplemented)", () => {
  function fakeSessionWithFlakyGoto(failTimes: number): { session: BrowserSession; goto: ReturnType<typeof vi.fn> } {
    let calls = 0;
    const goto = vi.fn(async () => {
      calls += 1;
      if (calls <= failTimes) throw new Error("socket hang up"); // matches isTransientError's patterns
    });
    const page: any = { goto };
    return { session: { page, context: {}, browser: {}, driverName: "playwright", browserVersion: "145" }, goto };
  }

  it("retries an idempotent step once on a transient failure, then succeeds", async () => {
    const { session, goto } = fakeSessionWithFlakyGoto(1);
    // openLink isn't idempotent-BY-DEFAULT (shared/ir.ts's IDEMPOTENT_BY_DEFAULT set), so this
    // test marks it explicitly — proving the retry itself, not the default-idempotency table.
    const step = { id: "s1", action: "openLink", url: "https://example.com", idempotent: true } as FlowStep;
    const { outcome, attempts } = await runBrowserStepWithRetry(step, session);
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(goto).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-idempotent step even on a transient failure", async () => {
    const { session } = fakeSessionWithFlakyGoto(5);
    const step = { id: "s1", action: "openLink", url: "https://example.com", idempotent: false } as FlowStep;
    const { outcome, attempts } = await runBrowserStepWithRetry(step, session);
    expect(outcome.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("does NOT retry a non-transient (deterministic) failure regardless of idempotency", async () => {
    const page: any = { goto: vi.fn().mockRejectedValue(new Error("assertion: element not found")) };
    const session: BrowserSession = { page, context: {}, browser: {}, driverName: "playwright", browserVersion: "145" };
    const step = { id: "s1", action: "openLink", url: "https://example.com" } as FlowStep;
    const { outcome, attempts } = await runBrowserStepWithRetry(step, session);
    expect(outcome.ok).toBe(false);
    expect(attempts).toBe(1);
  });
});

describe("runBrowserFlow — one Flow against one fresh context (E16 AC4), RunSummary shape matches the mobile path", () => {
  function makeFlow(steps: FlowStep[], overrides: Partial<Flow> = {}): Flow {
    return {
      schemaVersion: 1,
      name: "Browser login",
      app: { bundleId: "browser-placeholder", platform: "ios-sim" },
      steps,
      ...overrides,
    } as Flow;
  }

  function makeFakeWorker(pageOverrides: Record<string, unknown> = {}): { worker: BrowserWorker; contexts: any[] } {
    const contexts: any[] = [];
    const worker: BrowserWorker = {
      workerId: 0,
      port: 9223,
      profileDir: "/tmp/w0",
      driverName: "playwright",
      browserVersion: "145",
      async newContextForFlow(): Promise<BrowserSession> {
        const page: any = {
          goto: vi.fn().mockResolvedValue(undefined),
          screenshot: vi.fn().mockResolvedValue(undefined),
          waitForTimeout: vi.fn().mockResolvedValue(undefined),
          getByText: vi.fn(() => ({ click: vi.fn().mockResolvedValue(undefined), isVisible: vi.fn().mockResolvedValue(true) })),
          ...pageOverrides,
        };
        const context = { close: vi.fn().mockResolvedValue(undefined) };
        contexts.push(context);
        return { page, context, browser: {}, driverName: "playwright", browserVersion: "145" };
      },
      async close() {},
    };
    return { worker, contexts };
  }

  it("runs a simple green flow end to end, producing a passed RunSummary", async () => {
    const { worker, contexts } = makeFakeWorker();
    const flow = makeFlow([{ id: "s1", action: "openLink", url: "https://example.com" } as FlowStep]);
    const events: RunEvent[] = [];
    const summary = await runBrowserFlow(worker, flow, {}, (e) => events.push(e));

    expect(summary.passed).toBe(true);
    expect(summary.status).toBe("passed");
    expect(summary.total).toBe(1);
    expect(summary.passedCount).toBe(1);
    expect(events.some((e) => e.type === "run:start")).toBe(true);
    expect(events.some((e) => e.type === "run:end")).toBe(true);
    // The context opened for this flow is closed afterward (AC4) — the worker itself is not.
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("a soft-flagged failing step doesn't halt the run (E2 AC5, proven again on the browser path)", async () => {
    const { worker } = makeFakeWorker({
      goto: vi.fn().mockRejectedValue(new Error("soft nav failure")),
    });
    const flow = makeFlow([
      { id: "s1", action: "openLink", url: "https://example.com", soft: true } as FlowStep,
      { id: "s2", action: "waitMs", ms: 1 } as FlowStep,
    ]);
    const summary = await runBrowserFlow(worker, flow, {}, () => {});
    expect(summary.softFailedCount).toBe(1);
    expect(summary.results[1].status).toBe("passed"); // the run kept going past the soft failure
  });

  it("a hard failing step halts the run and marks remaining steps skipped", async () => {
    const { worker } = makeFakeWorker({
      goto: vi.fn().mockRejectedValue(new Error("assertion: nope")),
    });
    const flow = makeFlow([
      { id: "s1", action: "openLink", url: "https://example.com" } as FlowStep,
      { id: "s2", action: "waitMs", ms: 1 } as FlowStep,
    ]);
    const summary = await runBrowserFlow(worker, flow, {}, () => {});
    expect(summary.passed).toBe(false);
    expect(summary.results[1].status).toBe("skipped");
  });

  it("cancelling THIS run's own context marks remaining steps skipped without affecting a sibling run (E15 AC3 on the browser path)", async () => {
    const { worker: workerA } = makeFakeWorker();
    const { worker: workerB } = makeFakeWorker();
    const flow = makeFlow([
      { id: "s1", action: "waitMs", ms: 1 } as FlowStep,
      { id: "s2", action: "waitMs", ms: 1 } as FlowStep,
    ]);
    const ctxA = { runId: "run-a", cancelled: false };
    const ctxB = { runId: "run-b", cancelled: false };
    ctxA.cancelled = true; // cancel A before it starts stepping
    const [summaryA, summaryB] = await Promise.all([
      runBrowserFlow(workerA, flow, {}, () => {}, ctxA),
      runBrowserFlow(workerB, flow, {}, () => {}, ctxB),
    ]);
    expect(summaryA.status).toBe("cancelled");
    expect(summaryB.status).toBe("passed"); // sibling run, untouched by A's cancel
  });

  it("writes a screenshot per step when artifactsDir is given (evidence, mirrors the mobile path)", async () => {
    const { worker } = makeFakeWorker();
    const flow = makeFlow([{ id: "s1", action: "openLink", url: "https://example.com" } as FlowStep]);
    const summary = await runBrowserFlow(worker, flow, {}, () => {}, undefined, "/tmp/artifacts/run-x");
    expect(summary.results[0].screenshot).toContain("/tmp/artifacts/run-x");
  });
});

describe("runBrowserSuite — driving many BrowserWorkers via E15's pool/concurrency/sharding (E16)", () => {
  function makeFlow(name: string): Flow {
    return {
      schemaVersion: 1,
      name,
      app: { bundleId: "browser-placeholder", platform: "ios-sim" },
      steps: [{ id: "s1", action: "waitMs", ms: 1 } as FlowStep],
    } as Flow;
  }

  function fakeLaunchWorkerFn(launchLog: number[]): (slot: BrowserWorkerSlot) => Promise<BrowserWorker> {
    return async (slot) => {
      launchLog.push(slot.workerId);
      return {
        workerId: slot.workerId,
        port: slot.port,
        profileDir: slot.profileDir,
        driverName: "playwright",
        browserVersion: "145",
        async newContextForFlow(): Promise<BrowserSession> {
          const page: any = { goto: vi.fn().mockResolvedValue(undefined), screenshot: vi.fn().mockResolvedValue(undefined) };
          return { page, context: { close: vi.fn().mockResolvedValue(undefined) }, browser: {}, driverName: "playwright", browserVersion: "145" };
        },
        async close() {},
      };
    };
  }

  it("merges every worker's results into ONE report (AC1/AC6)", async () => {
    const launchLog: number[] = [];
    const jobs: BrowserSuiteJob[] = Array.from({ length: 6 }, (_, i) => ({ flow: makeFlow(`flow-${i}`) }));
    const report = await runBrowserSuite(jobs, { concurrency: 3, launchWorkerFn: fakeLaunchWorkerFn(launchLog) });
    expect(report.results).toHaveLength(6);
    expect(report.workers.length).toBeGreaterThan(0);
  });

  it("launches exactly ONE process per worker/shard, reused across every job in that shard (AC4: process reused across the shard)", async () => {
    const launchLog: number[] = [];
    const jobs: BrowserSuiteJob[] = Array.from({ length: 9 }, (_, i) => ({ flow: makeFlow(`flow-${i}`) }));
    await runBrowserSuite(jobs, { concurrency: 3, launchWorkerFn: fakeLaunchWorkerFn(launchLog) });
    // 9 jobs over 3 workers, round-robin => 3 jobs per worker, but launchWorkerFn called ONCE per
    // worker id, not once per job.
    expect(launchLog.length).toBe(3);
    expect(new Set(launchLog).size).toBe(3);
  });

  it("empty job list short-circuits to an empty report without launching anything", async () => {
    const launchLog: number[] = [];
    const report = await runBrowserSuite([], { launchWorkerFn: fakeLaunchWorkerFn(launchLog) });
    expect(report.results).toEqual([]);
    expect(launchLog).toEqual([]);
  });

  it("cancelling one suite's run never cancels a concurrently running, separate suite (E15 AC3, browser path)", async () => {
    let capturedRunId: string | undefined;
    const slowLaunch = () => async (slot: BrowserWorkerSlot): Promise<BrowserWorker> => ({
      workerId: slot.workerId,
      port: slot.port,
      profileDir: slot.profileDir,
      driverName: "playwright",
      browserVersion: "145",
      async newContextForFlow(): Promise<BrowserSession> {
        const page: any = {
          goto: vi.fn().mockResolvedValue(undefined),
          waitForTimeout: vi.fn(async (ms: number) => new Promise((r) => setTimeout(r, ms))),
        };
        return { page, context: { close: vi.fn().mockResolvedValue(undefined) }, browser: {}, driverName: "playwright", browserVersion: "145" };
      },
      async close() {},
    });

    // Multiple steps, not one: cancellation is only checked BETWEEN steps (never aborts an
    // in-flight one), so a single-step flow could finish before the cancel signal ever lands.
    const flowA: Flow = {
      schemaVersion: 1,
      name: "slow-a",
      app: { bundleId: "x", platform: "ios-sim" },
      steps: [
        { id: "s1", action: "waitMs", ms: 60 } as FlowStep,
        { id: "s2", action: "waitMs", ms: 60 } as FlowStep,
        { id: "s3", action: "waitMs", ms: 60 } as FlowStep,
      ],
    } as Flow;
    const flowB = makeFlow("b");

    const suiteAPromise = runBrowserSuite([{ flow: flowA }], {
      concurrency: 1,
      launchWorkerFn: slowLaunch(),
      emit: (e) => {
        if (e.type === "run:start") capturedRunId = e.runId;
      },
    });
    const suiteBPromise = runBrowserSuite([{ flow: flowB }, { flow: flowB }], {
      concurrency: 2,
      launchWorkerFn: slowLaunch(),
    });

    // Poll (rather than a single fixed sleep) for suite A's "run:start" event to land before
    // cancelling — under heavy parallel test-suite load the event loop can be delayed enough that
    // a single short sleep fires before `capturedRunId` is ever set, silently skipping the cancel
    // entirely (the flakiness this replaced: a fixed 5ms wait occasionally lost this race). Each
    // step is also long enough (60ms) that the cancel still has plenty of room to land between
    // steps once it's actually issued.
    for (let i = 0; i < 40 && !capturedRunId; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedRunId).toBeTruthy(); // sanity: the race above must have resolved either way
    const { cancelRun } = await import("../bridge/orchestrator.ts");
    cancelRun(capturedRunId!);

    const [reportA, reportB] = await Promise.all([suiteAPromise, suiteBPromise]);
    expect(reportA.results[0].status).toBe("cancelled");
    expect(reportB.results.every((r) => r.status === "passed")).toBe(true);
  });
});
