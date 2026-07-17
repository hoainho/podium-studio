import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * E20 AC4 — "no device-farm SDK/dependency is introduced... confirming the local-device-first
 * scope boundary" (PODIUM-STUDIO-PLAN.md §7 decision #2: local USB device first, device-farm
 * deferred). A real grep over package.json, run as a test so a regression (someone adding one
 * later) fails CI rather than relying on a human remembering to check before merge.
 */

// Known device-farm / cloud-device-lab client SDKs a "local device first" scope must never pull
// in — this list is deliberately generic (the point is "any of these categories", not an
// exhaustive enumeration of every vendor that has ever existed).
const DEVICE_FARM_PACKAGE_PATTERNS = [
  /browserstack/i,
  /saucelabs/i,
  /sauce-connect/i,
  /perfecto/i,
  /lambdatest/i,
  /aws-device-farm/i,
  /firebase.*test.*lab/i,
  /kobiton/i,
  /appium-device-farm/i,
  /bitbar/i,
];

describe("E20 AC4 — no device-farm SDK is introduced (local, USB-connected device only)", () => {
  it("package.json's dependencies + devDependencies contain zero device-farm client libraries", async () => {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw);
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const names = Object.keys(allDeps);

    const matches = names.filter((name) => DEVICE_FARM_PACKAGE_PATTERNS.some((pattern) => pattern.test(name)));
    expect(matches).toEqual([]);
  });

  it("the Android driver targets a device purely by an opaque serial string — no device-farm client object anywhere in its module", async () => {
    const source = await readFile(new URL("../bridge/android-driver.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/browserstack|saucelabs|device.?farm|kobiton|lambdatest|perfecto|bitbar/i);
  });
});
