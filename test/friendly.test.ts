import { describe, it, expect } from "vitest";
import { friendlyLaunchError } from "../src/friendly.ts";
import { vi as viMessages } from "../src/i18n/locales/vi.ts";

/**
 * Bug fix: a raw simctl/FBSOpenApplicationServiceErrorDomain launch failure ("launch failed
 * (code 4)... failed to launch safari") must never be shown to a QA verbatim — `friendlyLaunchError`
 * maps it to one plain sentence that names the single most common cause (a plain app name instead
 * of a real bundle id). It now goes through i18n (takes `t`); this suite drives it with the real
 * Vietnamese dictionary so a missing/renamed key would surface as a failure here.
 */
function makeT(messages: unknown) {
  return (path: string): string => {
    let cur: unknown = messages;
    for (const seg of path.split(".")) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else return path; // missing key → return the path so tests notice
    }
    return typeof cur === "string" ? cur : path;
  };
}
const tVi = makeT(viMessages);

describe("friendlyLaunchError", () => {
  it("maps the exact reported bug scenario (code 4 / FBSOpenApplicationServiceErrorDomain) to a plain message about the bundle id", () => {
    const raw =
      'launch failed (code 4): Domain=FBSOpenApplicationServiceErrorDomain Code=4 "failed to launch safari" ' +
      "UserInfo={NSLocalizedFailureReason=... a long nested stack ...}";
    const result = friendlyLaunchError(tVi, raw);
    expect(result).toContain("Bundle id");
    expect(result).toContain("com.apple.mobilesafari");
    expect(result).not.toContain("FBSOpenApplicationServiceErrorDomain"); // the raw jargon never leaks through
    expect(result).not.toContain("code 4");
  });

  it("recognizes each of the three raw signals independently (fbsopenapplication / code 4 / launch failed)", () => {
    expect(friendlyLaunchError(tVi, "Domain=FBSOpenApplicationServiceErrorDomain")).toContain("Bundle id");
    expect(friendlyLaunchError(tVi, "something something code 4 something")).toContain("Bundle id");
    expect(friendlyLaunchError(tVi, "launch failed for unknown reasons")).toContain("Bundle id");
  });

  it("maps a not-installed error to its own distinct message", () => {
    expect(friendlyLaunchError(tVi, "Error: app is not installed on the simulator")).toMatch(/chưa được cài/);
  });

  it("maps a not-booted simulator error to its own distinct message", () => {
    expect(friendlyLaunchError(tVi, "simulator is shutdown")).toMatch(/chưa khởi động/);
  });

  it("falls back to a calm generic sentence for an unrecognized error, never throws", () => {
    expect(() => friendlyLaunchError(tVi, "some totally unrelated engine error")).not.toThrow();
    expect(friendlyLaunchError(tVi, "some totally unrelated engine error").length).toBeGreaterThan(0);
  });

  it("handles null/undefined/empty input without throwing", () => {
    expect(friendlyLaunchError(tVi, null)).toBeTruthy();
    expect(friendlyLaunchError(tVi, undefined)).toBeTruthy();
    expect(friendlyLaunchError(tVi, "")).toBeTruthy();
    expect(friendlyLaunchError(tVi, "   ")).toBeTruthy();
  });

  it("is case-insensitive when matching the launch-failure signal", () => {
    expect(friendlyLaunchError(tVi, "LAUNCH FAILED (CODE 4)")).toContain("Bundle id");
  });

  it("every launchError key resolves in the Vietnamese dictionary (no missing keys)", () => {
    for (const key of ["generic", "badBundle", "notInstalled", "notBooted", "fallback"]) {
      expect(tVi(`friendly.launchError.${key}`)).not.toBe(`friendly.launchError.${key}`);
    }
  });
});
