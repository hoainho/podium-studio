import type { FlowStep } from "../shared/ir.ts";

/**
 * The Driver interface (Pillar J: "Browser is a new Driver behind the existing Driver
 * interface, not a fork of the product"). Every platform — the existing mobile/Maestro path
 * (wrapped below as `mobileDriver`, delegating to bridge/runner.ts's `executeStep`) and the new
 * browser path (bridge/browser-driver.ts's `browserDriver`) — implements this same seam, so
 * the Flow IR, authoring, and (eventually) the retry/idempotency/flaky-bucketing/soft-assert
 * logic in bridge/runner.ts (E2) stay platform-agnostic rather than being reimplemented per
 * driver.
 *
 * E7 scope note: this file only INTRODUCES the interface and a mobile-path adapter — it does
 * NOT rewire `runFlow`'s step loop to dispatch through `Driver` generically (that's a larger,
 * riskier refactor belonging to the full browser E2E orchestrator, E16/R3, per
 * PILLAR-BROWSER-E2E.md §4 item 2). `runFlow` keeps calling `executeStep`/`runStepWithRetry`
 * exactly as it did before this epic — zero behavior change to the mobile path.
 */

export type Platform = "mobile" | "browser";

export interface StepOutcome {
  ok: boolean;
  detail?: string;
  error?: string;
  backend?: string;
}

/**
 * Per-step context a Driver needs. Only the fields relevant to that Driver's platform are
 * populated — mobile drivers need `udid`/`bundleId`; the browser driver ignores those and
 * manages its own session internally (see bridge/browser-driver.ts). Kept generic + optional
 * so both platforms share one interface without either leaking its internals into the other.
 */
export interface DriverContext {
  fixtures?: Record<string, unknown>;
  /** Variables captured earlier in the run, also injected as a Maestro `env:` block on the
   * mobile path (E2 AC4 / IR-SPEC.md §4). */
  env?: Record<string, string>;
  /** Already-resolved `${secret:name}` → value map (E12, bridge/secrets.ts) — deliberately a
   * SEPARATE field from `fixtures`/`env`, never merged into either, so a secret value can
   * never travel through the same object a caller might persist or inject into a Maestro
   * `env:` block meant for captured (non-secret) run variables. */
  secrets?: Record<string, string>;
  /** Mobile: the simulator/emulator udid. */
  udid?: string;
  /** Mobile: the app bundle id. */
  bundleId?: string;
  /** Browser: where to save a screenshot, if the step requests one. */
  screenshotPath?: string;
}

export interface DriverAvailability {
  ok: boolean;
  /** Present when ok === false — a clear, human-readable reason (never fake success). */
  reason?: string;
}

export interface Driver {
  readonly platform: Platform;
  /** Human-readable driver name for logs/reports (e.g. "podium-maestro", "cloakbrowser", "playwright"). */
  readonly name: string;
  /** Is this driver's runtime actually available right now (binary/package/license present)? */
  isAvailable(): Promise<DriverAvailability>;
  /** Execute ONE IR step against this driver's target. */
  executeStep(step: FlowStep, ctx: DriverContext): Promise<StepOutcome>;
}
