import { describe, it, expect, vi } from "vitest";
import { recordCrash, type CrashEvent, type RecordCrashDeps } from "../src/telemetry.ts";

/**
 * E23 — crash telemetry (AC1: off by default, hard gate; AC2: all 4 required fields once
 * consent is granted). `recordCrash` is fully dependency-injectable (consent/store/transmit/
 * now/newId), so every test here exercises the REAL function with REAL logic — never a mock of
 * `recordCrash` itself — while never touching real `window.localStorage`/`navigator` (this repo
 * has no jsdom/happy-dom dependency, so DOM-touching code — `getTelemetryConsent`,
 * `installCrashHandlers`, etc. — is exercised by `tsc`/structurally, not unit-tested directly
 * here; same "pure logic tested, DOM glue not" split this codebase already uses for
 * src/bundle-io.ts's `stashBaseline`/`downloadBytes`).
 */

function baseDeps(overrides: Partial<RecordCrashDeps> = {}): RecordCrashDeps {
  return {
    consent: true,
    now: () => 1_700_000_000_000,
    newId: () => "fixed-id",
    store: vi.fn(),
    ...overrides,
  };
}

describe("recordCrash — AC1: telemetry is OFF by default, a hard gate", () => {
  it("returns undefined and calls neither store nor transmit when consent is false", () => {
    const store = vi.fn();
    const transmit = vi.fn();
    const result = recordCrash(
      { message: "boom" },
      { consent: false, store, transmit, remoteEndpoint: "https://example.com/telemetry" },
    );
    expect(result).toBeUndefined();
    expect(store).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("10 seeded crash scenarios with consent NOT granted: zero events emitted or transmitted", () => {
    const store = vi.fn();
    const transmit = vi.fn();
    const scenarios = Array.from({ length: 10 }, (_, i) => ({ message: `crash #${i}`, stack: `at fn${i}` }));
    for (const scenario of scenarios) {
      recordCrash(scenario, { consent: false, store, transmit, remoteEndpoint: "https://example.com/telemetry" });
    }
    expect(store).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("does nothing when consent is granted only via a remoteEndpoint being set (endpoint alone isn't consent)", () => {
    const store = vi.fn();
    const result = recordCrash({ message: "x" }, { consent: false, store, remoteEndpoint: "https://x.example.com" });
    expect(result).toBeUndefined();
    expect(store).not.toHaveBeenCalled();
  });
});

describe("recordCrash — AC2: once consent is granted, all 4 required fields are recorded", () => {
  it("records message/stack + appVersion + os + timestamp, and calls store with it", () => {
    const store = vi.fn();
    const result = recordCrash(
      { message: "Cannot read property of undefined", stack: "at foo (app.js:12:3)", appVersion: "1.4.2", os: "macOS 14" },
      baseDeps({ store }),
    );
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      message: "Cannot read property of undefined",
      stack: "at foo (app.js:12:3)",
      appVersion: "1.4.2",
      os: "macOS 14",
      timestamp: 1_700_000_000_000,
    });
    expect(store).toHaveBeenCalledWith(result);
  });

  it("never omits appVersion/os even when the caller doesn't supply them — falls back to 'unknown', never undefined", () => {
    const result = recordCrash({ message: "x" }, baseDeps());
    expect(result!.appVersion).toBe("unknown");
    expect(result!.os).toBe("unknown");
    expect(typeof result!.timestamp).toBe("number");
  });

  it("10 seeded crash scenarios with consent granted: EVERY one is captured with all 4 fields present", () => {
    const store = vi.fn();
    const scenarios = Array.from({ length: 10 }, (_, i) => ({
      message: `crash #${i}`,
      stack: `at fn${i} (file.js:${i}:1)`,
      appVersion: "2.0.0",
      os: "Windows 11",
    }));
    const recorded: (CrashEvent | undefined)[] = scenarios.map((s) => recordCrash(s, baseDeps({ store })));
    expect(recorded).toHaveLength(10);
    for (const event of recorded) {
      expect(event).toBeDefined();
      expect(event!.stack).toBeTruthy();
      expect(event!.appVersion).toBe("2.0.0");
      expect(event!.os).toBe("Windows 11");
      expect(typeof event!.timestamp).toBe("number");
    }
    expect(store).toHaveBeenCalledTimes(10);
  });

  it("assigns a fresh id per event via the injectable newId", () => {
    let n = 0;
    const result = recordCrash({ message: "x" }, baseDeps({ newId: () => `id-${++n}` }));
    expect(result!.id).toBe("id-1");
  });
});

describe("recordCrash — AC2: transmission only when a remote endpoint is configured", () => {
  it("does NOT call transmit when no remoteEndpoint is configured", () => {
    const transmit = vi.fn();
    recordCrash({ message: "x" }, baseDeps({ transmit, remoteEndpoint: undefined }));
    expect(transmit).not.toHaveBeenCalled();
  });

  it("calls transmit with the event and endpoint when one IS configured", async () => {
    const transmit = vi.fn().mockResolvedValue(undefined);
    const result = recordCrash({ message: "x" }, baseDeps({ transmit, remoteEndpoint: "https://telemetry.example.com/ingest" }));
    // transmit is fire-and-forget (not awaited by recordCrash) — flush microtasks before asserting.
    await Promise.resolve();
    expect(transmit).toHaveBeenCalledWith(result, "https://telemetry.example.com/ingest");
  });

  it("a transmit failure never throws out of recordCrash (fire-and-forget, never breaks the app)", () => {
    const transmit = vi.fn().mockRejectedValue(new Error("network down"));
    expect(() =>
      recordCrash({ message: "x" }, baseDeps({ transmit, remoteEndpoint: "https://unreachable.example.com" })),
    ).not.toThrow();
  });
});
