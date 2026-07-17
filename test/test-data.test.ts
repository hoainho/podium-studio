import { describe, it, expect, beforeEach } from "vitest";
import type { Flow } from "../shared/ir.ts";
import { interpolate, toPodiumSteps } from "../shared/ir.ts";
import {
  buildTestAccountFixtures,
  getCurrentEnvironment,
  getEnvironmentConfig,
  getTestAccount,
  isSeedResetHookName,
  listEnvironments,
  listTestAccounts,
  runSeedResetHook,
  runSeedResetHooks,
  setCurrentEnvironment,
  type FetchFn,
} from "../bridge/test-data.ts";

/**
 * E11 (Test-data & environment layer). No live stg/qa reset API exists in this environment
 * (per the epic's own risk flag) — every seed-reset test here mocks the HTTP boundary
 * (`FetchFn`, mirrors bridge/doctor.ts's ExecFn / bridge/secrets.ts's KeychainReadFn) and
 * exercises the REAL resolution/dispatch/degrade logic around it. A real backend round-trip
 * (AC1/AC4 against the demo app's actual stg/qa reset endpoints) needs a human with real
 * infrastructure — see the completion report for that split.
 */

// Reset the module-level "current environment" between tests so they don't leak into each other.
beforeEach(() => {
  setCurrentEnvironment("stg");
});

describe("environment registry", () => {
  it("defaults to stg", () => {
    expect(getCurrentEnvironment()).toBe("stg");
  });

  it("switching is config-only: setCurrentEnvironment changes resolution without touching any flow object", () => {
    const flow: Flow = {
      schemaVersion: 1,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      fixtures: { testAccountRole: "user_low_balance" },
      steps: [{ id: "s1", action: "tap", x: 1, y: 1 } as any],
    };
    const beforeJson = JSON.stringify(flow);

    const stgAccount = getTestAccount(getCurrentEnvironment(), "user_low_balance");
    setCurrentEnvironment("qa");
    const qaAccount = getTestAccount(getCurrentEnvironment(), "user_low_balance");

    // Different accounts resolve for the same role across environments...
    expect(stgAccount?.username).not.toBe(qaAccount?.username);
    // ...but the flow object itself is byte-for-byte untouched by the switch.
    expect(JSON.stringify(flow)).toBe(beforeJson);
    expect(JSON.stringify(flow)).not.toMatch(/qa\.demoapp|stg\.demoapp/);
  });

  it("rejects an unknown environment name rather than silently defaulting", () => {
    expect(() => setCurrentEnvironment("nope" as any)).toThrow(/Unknown environment/);
    // The current environment is unchanged after a rejected switch.
    expect(getCurrentEnvironment()).toBe("stg");
  });

  it("lists every environment with its account roles (no credentials)", () => {
    const envs = listEnvironments();
    const names = envs.map((e) => e.name).sort();
    expect(names).toEqual(["prod", "qa", "stg"]);
    const stg = envs.find((e) => e.name === "stg")!;
    expect(stg.accountRoles).toContain("user_low_balance");
    expect(JSON.stringify(envs)).not.toMatch(/secret:.*hunter|password.*=.*[a-z0-9]{8}/i);
  });

  it("getEnvironmentConfig throws for an unknown name", () => {
    expect(() => getEnvironmentConfig("nope" as any)).toThrow(/Unknown environment/);
  });
});

describe("test accounts — role-based reference, never a raw credential", () => {
  it("a flow references an account by role, and getTestAccount resolves it for the active environment", () => {
    const flow: Flow = {
      schemaVersion: 1,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      fixtures: { testAccountRole: "user_low_balance" },
      steps: [{ id: "s1", action: "tap", x: 1, y: 1 } as any],
    };
    const role = flow.fixtures!.testAccountRole as string;
    const account = getTestAccount(getCurrentEnvironment(), role);
    expect(account).toBeDefined();
    expect(account!.role).toBe("user_low_balance");
  });

  it("returns undefined (never throws) for an unknown role", () => {
    expect(getTestAccount("stg", "not_a_real_role")).toBeUndefined();
  });

  it("every listed account's password is ALWAYS a ${secret:...} reference, never a literal value", () => {
    for (const env of listEnvironments()) {
      for (const account of listTestAccounts(env.name)) {
        expect(account.passwordRef).toMatch(/^\$\{secret:[a-zA-Z0-9_.-]+\}$/);
      }
    }
  });

  it("buildTestAccountFixtures returns the username literally and the password as the unresolved secret ref", () => {
    const account = getTestAccount("stg", "user_low_balance")!;
    const fixtures = buildTestAccountFixtures(account);
    expect(fixtures.testAccountRole).toBe("user_low_balance");
    expect(fixtures.testAccountUsername).toBe(account.username);
    expect(fixtures.testAccountPassword).toBe(account.passwordRef);
    expect(String(fixtures.testAccountPassword)).toMatch(/^\$\{secret:/);
  });

  it("test-account passwords resolve via the EXISTING secret seam (mocked) — this module never resolves anything itself", () => {
    const account = getTestAccount("stg", "user_low_balance")!;
    const fixtures = buildTestAccountFixtures(account);
    // Mock a resolved secrets map exactly as bridge/runner.ts's preflight would produce it —
    // reusing shared/ir.ts's interpolate(), never a duplicate resolution path in this module.
    const secretName = account.passwordRef.match(/\$\{secret:([a-zA-Z0-9_.-]+)\}/)![1];
    const resolved = interpolate(String(fixtures.testAccountPassword), {}, { [secretName]: "hunter2" });
    expect(resolved).toBe("hunter2");
  });

  it("a flow's fixtures.testAccountRole survives toPodiumSteps() untouched (it's not a {{}}/secret token, just plain routing data)", () => {
    const flow: Flow = {
      schemaVersion: 1,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      fixtures: { testAccountRole: "user_low_balance" },
      steps: [{ id: "s1", action: "type", text: "{{testAccountUsername}}" } as any],
    };
    const account = getTestAccount("stg", flow.fixtures!.testAccountRole as string)!;
    const merged = { ...flow.fixtures, ...buildTestAccountFixtures(account) };
    const [step] = toPodiumSteps(flow, merged);
    expect(step.text).toBe(account.username);
  });
});

describe("isSeedResetHookName", () => {
  it("accepts the known hook names", () => {
    expect(isSeedResetHookName("resetCoinBalance")).toBe(true);
    expect(isSeedResetHookName("resetDailyBonus")).toBe(true);
  });

  it("rejects anything else, including presentation-shaped strings", () => {
    expect(isSeedResetHookName("resetSomethingElse")).toBe(false);
    expect(isSeedResetHookName(123)).toBe(false);
    expect(isSeedResetHookName(undefined)).toBe(false);
  });
});

describe("runSeedResetHook / runSeedResetHooks — never a silent no-op", () => {
  const env = getEnvironmentConfig("stg");
  const account = getTestAccount("stg", "user_low_balance")!;

  function mockFetchSuccess(stateSequence: Record<string, unknown>[]): FetchFn {
    let call = 0;
    return (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as Response;
      }
      const state = stateSequence[Math.min(call, stateSequence.length - 1)];
      call += 1;
      return { ok: true, status: 200, statusText: "OK", json: async () => state } as Response;
    }) as FetchFn;
  }

  function mockFetchNetworkFailure(): FetchFn {
    return (async () => {
      throw new Error("ECONNREFUSED — no server listening");
    }) as FetchFn;
  }

  it("real reset call: reads pre-state, resets, reads post-state, returns ok:true with both states", async () => {
    const fetchImpl = mockFetchSuccess([{ coins: 500 }, { coins: 0 }]);
    const result = await runSeedResetHook("resetCoinBalance", env, account, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.preState).toEqual({ coins: 500 });
    expect(result.postState).toEqual({ coins: 0 });
    expect(result.hook).toBe("resetCoinBalance");
    expect(result.role).toBe(account.role);
  });

  it("never silently no-ops when the reset API is unreachable — degrades with a stable code + params a client localizes (task #48)", async () => {
    const result = await runSeedResetHook("resetCoinBalance", env, account, mockFetchNetworkFailure());
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    // Never a hardcoded sentence on the wire — a stable code + data params instead.
    expect(result.errorCode).toBe("resetApiUnreachable");
    expect(result.errorParams).toBeDefined();
    expect(result.errorParams?.hook).toBe("resetCoinBalance");
    expect(result.errorParams?.role).toBe(account.role);
    expect(result.errorParams?.env).toBe(env.name);
    expect(result.errorParams?.username).toBe(account.username);
    expect(result.errorParams?.baseUrl).toBe(env.baseUrl);
    expect(result.errorParams?.message).toBeTruthy();
    // No field on the result ever contains a credential value.
    expect(JSON.stringify(result.errorParams)).not.toContain(account.passwordRef.replace(/[${}]/g, ""));
  });

  it("a non-2xx HTTP response is treated as a failure, not swallowed as success", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }) as Response) as FetchFn;
    const result = await runSeedResetHook("resetDailyBonus", env, account, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it("runSeedResetHooks runs every declared hook even after an earlier one degrades (never fail-fast)", async () => {
    let calls = 0;
    // callResetEndpoint throws on the FIRST failing fetch it makes for a hook (no internal
    // retry), so hook 1 consumes exactly 1 call before degrading; only that one call needs to
    // fail for hook 2's full 3-call round trip (GET/POST/GET) to proceed untouched.
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls <= 1) throw new Error("network down");
      if (init?.method === "POST") return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as Response;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ coins: 0 }) } as Response;
    }) as FetchFn;

    const results = await runSeedResetHooks(["resetCoinBalance", "resetDailyBonus"], env, account, fetchImpl);
    expect(results).toHaveLength(2);
    expect(results[0].degraded).toBe(true); // first hook's pre-state read fails
    expect(results[1].ok).toBe(true); // second hook still ran and succeeded
  });

  it("idempotent back-to-back reset: calling the SAME hook twice against a backend that always resets to the same known value produces the same postState both times (AC4, unit-level)", async () => {
    // The mock backend always resets coins to 0 regardless of current balance — the
    // real-backend equivalent of "known-state reset", not an incremental decrement.
    const fetchImpl: FetchFn = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as Response;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ coins: 0 }) } as Response;
    }) as FetchFn;

    const first = await runSeedResetHook("resetCoinBalance", env, account, fetchImpl);
    const second = await runSeedResetHook("resetCoinBalance", env, account, fetchImpl);
    expect(first.postState).toEqual(second.postState);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
