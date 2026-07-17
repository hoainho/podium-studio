import type { EnvironmentName, EnvironmentSummary, SeedResetResult, TestAccountSummary } from "../shared/protocol.ts";

/**
 * bridge/test-data.ts — Test-data & environment layer (E11, janus-specs/R2-desktop-android/E11-testdata-env.md).
 *
 * Pillar L: flows reference *roles* and *hooks*, never hardcoded environment strings or raw
 * credentials. This module owns:
 *   - a small stg/qa/prod environment registry (base URL + named test accounts per env);
 *   - known-state seeding/reset hooks (coin balance, daily bonus, ...) that call a real
 *     backend endpoint — degrading to a clear "needs manual reset" result on failure, NEVER
 *     silently no-opping (spec risk flag: the live stg/qa reset API may not exist yet);
 *   - the "current environment" selector itself, kept as bridge-side config, NOT a flow field
 *     (spec AC2: switching env must be a config-only change — zero flow JSON diff).
 *
 * Explicitly OUT of scope (owned elsewhere): secret storage/resolution mechanics — a
 * TestAccount's password is ALWAYS the literal `${secret:...}` reference string, resolved by
 * bridge/secrets.ts's existing seam (collectSecretRefs/resolveSecrets, wired into
 * bridge/runner.ts's runFlow preflight) once this module's fixtures are merged into a flow's
 * `fixtures` object — this module never resolves a secret itself, so there is exactly one
 * secret-resolution code path in the whole app (no duplicate/divergent logic, per this epic's
 * own risk-flag note: "do not duplicate secret-resolution logic").
 */

export type { EnvironmentName };

export interface TestAccount {
  role: string;
  username: string;
  /** ALWAYS a `${secret:...}` reference — never a literal credential (spec AC1 / non-negotiable §3.5). */
  passwordRef: string;
}

export interface EnvironmentConfig {
  name: EnvironmentName;
  baseUrl: string;
  accounts: Record<string, TestAccount>;
}

/**
 * Built-in registry. Real base URLs / account rosters are a per-deployment editing task — the
 * point of this epic is the SEAM (role/env indirection + secret-ref convention + reset-hook
 * contract), not the demo app's actual QA account roster (that's E13's job, explicitly Out of
 * scope here). Every password is a `${secret:...}` reference, never a literal value.
 */
const ENVIRONMENTS: Record<EnvironmentName, EnvironmentConfig> = {
  stg: {
    name: "stg",
    baseUrl: "https://stg.demoapp.example",
    accounts: {
      user_low_balance: {
        role: "user_low_balance",
        username: "qa-stg-low-balance",
        passwordRef: "${secret:stg-low-balance}",
      },
      user_daily_bonus: {
        role: "user_daily_bonus",
        username: "qa-stg-daily-bonus",
        passwordRef: "${secret:stg-daily-bonus}",
      },
    },
  },
  qa: {
    name: "qa",
    baseUrl: "https://qa.demoapp.example",
    accounts: {
      user_low_balance: {
        role: "user_low_balance",
        username: "qa-qa-low-balance",
        passwordRef: "${secret:qa-low-balance}",
      },
      user_daily_bonus: {
        role: "user_daily_bonus",
        username: "qa-qa-daily-bonus",
        passwordRef: "${secret:qa-daily-bonus}",
      },
    },
  },
  prod: {
    name: "prod",
    baseUrl: "https://demoapp.example",
    // Deliberately empty — "production real-account management" is explicitly OUT of scope
    // for this epic (spec §Scope); a real prod test-account convention needs a human decision,
    // not a placeholder invented here.
    accounts: {},
  },
};

let currentEnvironment: EnvironmentName = "stg";

export function getCurrentEnvironment(): EnvironmentName {
  return currentEnvironment;
}

/** Config-only switch (spec AC2) — never touches a flow file. Throws on an unknown name rather than silently defaulting. */
export function setCurrentEnvironment(name: EnvironmentName): EnvironmentName {
  if (!ENVIRONMENTS[name]) {
    throw new Error(`Unknown environment "${name}" — expected one of: ${Object.keys(ENVIRONMENTS).join(", ")}`);
  }
  currentEnvironment = name;
  return currentEnvironment;
}

export function getEnvironmentConfig(name: EnvironmentName): EnvironmentConfig {
  const env = ENVIRONMENTS[name];
  if (!env) throw new Error(`Unknown environment "${name}"`);
  return env;
}

function summarizeEnvironment(name: EnvironmentName): EnvironmentSummary {
  const env = getEnvironmentConfig(name);
  return { name: env.name, baseUrl: env.baseUrl, accountRoles: Object.keys(env.accounts) };
}

export function listEnvironments(): EnvironmentSummary[] {
  return (Object.keys(ENVIRONMENTS) as EnvironmentName[]).map(summarizeEnvironment);
}

/** Every test-account role known for one environment — passwords are ALWAYS the unresolved
 * `${secret:...}` reference, never a value, so this is safe to expose to the UI/API as-is. */
export function listTestAccounts(env: EnvironmentName): TestAccountSummary[] {
  return Object.values(getEnvironmentConfig(env).accounts).map((a) => ({
    role: a.role,
    username: a.username,
    passwordRef: a.passwordRef,
  }));
}

/** Look up one account by role within an environment. Returns undefined (never throws) so a
 * caller can decide how to report "flow references a role this environment doesn't define". */
export function getTestAccount(env: EnvironmentName, role: string): TestAccount | undefined {
  return getEnvironmentConfig(env).accounts[role];
}

/**
 * Build the fixtures a flow needs to actually use a role-based account: literal username +
 * the STILL-UNRESOLVED secret reference for the password. The caller (bridge/server.ts's
 * /api/run handler) merges this into a TRANSIENT copy of a flow's `fixtures` — never the
 * persisted flow file (spec AC2) — which is what makes the existing secrets seam
 * (bridge/secrets.ts, wired in bridge/runner.ts) resolve the password automatically. This
 * function does NOT resolve anything itself.
 */
export function buildTestAccountFixtures(account: TestAccount): Record<string, unknown> {
  return {
    testAccountRole: account.role,
    testAccountUsername: account.username,
    testAccountPassword: account.passwordRef,
  };
}

// ── Known-state seeding/reset hooks ─────────────────────────────────────────────

export type SeedResetHookName = "resetCoinBalance" | "resetDailyBonus";

export const SEED_RESET_HOOKS: readonly SeedResetHookName[] = ["resetCoinBalance", "resetDailyBonus"];

export function isSeedResetHookName(value: unknown): value is SeedResetHookName {
  return typeof value === "string" && (SEED_RESET_HOOKS as readonly string[]).includes(value);
}

/** Injectable HTTP primitive (mirrors bridge/doctor.ts's ExecFn / bridge/secrets.ts's
 * KeychainReadFn) — tests supply a mock, never hit a real network. Defaults to the global
 * `fetch` (Node 18+). */
export type FetchFn = typeof fetch;

/**
 * Convention endpoint shape for a real stg/qa reset API — NOT itself the demo app's actual
 * contract (a per-environment integration detail for whoever wires a real backend against this
 * seam); this is the shape a real implementation plugs into. Reads state (GET), resets (POST),
 * then reads state again — always attempts the real calls, never fabricates a result.
 */
async function callResetEndpoint(
  fetchImpl: FetchFn,
  env: EnvironmentConfig,
  hook: SeedResetHookName,
  role: string,
): Promise<{ preState: Record<string, unknown>; postState: Record<string, unknown> }> {
  const stateUrl = `${env.baseUrl}/qa-tools/state?role=${encodeURIComponent(role)}&hook=${encodeURIComponent(hook)}`;
  const resetUrl = `${env.baseUrl}/qa-tools/reset`;

  const preRes = await fetchImpl(stateUrl);
  if (!preRes.ok) throw new Error(`pre-state read failed: ${preRes.status} ${preRes.statusText}`);
  const preState = (await preRes.json()) as Record<string, unknown>;

  const resetRes = await fetchImpl(resetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, hook }),
  });
  if (!resetRes.ok) throw new Error(`reset call failed: ${resetRes.status} ${resetRes.statusText}`);

  const postRes = await fetchImpl(stateUrl);
  if (!postRes.ok) throw new Error(`post-state read failed: ${postRes.status} ${postRes.statusText}`);
  const postState = (await postRes.json()) as Record<string, unknown>;

  return { preState, postState };
}

/**
 * Run ONE seeding/reset hook against a real (or mocked-for-test) backend. Always attempts the
 * real call — on any network/HTTP failure, returns `{ ok: false, degraded: true, error }` with
 * an actionable manual-reset message, exactly per this epic's own risk flag: "if that API is
 * unavailable, seeding hooks must degrade to a documented manual-reset fallback rather than
 * silently no-op." A degraded result is never mistaken for success by a caller checking `ok`.
 */
export async function runSeedResetHook(
  hook: SeedResetHookName,
  env: EnvironmentConfig,
  account: TestAccount,
  fetchImpl: FetchFn = fetch,
): Promise<SeedResetResult> {
  try {
    const { preState, postState } = await callResetEndpoint(fetchImpl, env, hook, account.role);
    return { ok: true, hook, role: account.role, degraded: false, preState, postState };
  } catch (err: any) {
    // Task #48: never bake a human sentence in here — `errorCode` + `errorParams` are the wire
    // contract; the client (src/components/EnvironmentPanel.tsx's localizedSeedResetError) is
    // what turns this into a VI/EN sentence.
    return {
      ok: false,
      hook,
      role: account.role,
      degraded: true,
      errorCode: "resetApiUnreachable",
      errorParams: {
        hook,
        role: account.role,
        env: env.name,
        username: account.username,
        baseUrl: env.baseUrl,
        message: err?.message ?? String(err),
      },
    };
  }
}

/** Run several hooks in sequence (one flow can declare more than one, e.g. coin balance AND
 * daily bonus). Never fail-fast — a later hook still runs even if an earlier one degraded, so
 * the caller gets a complete picture of what needs manual attention, not just the first gap. */
export async function runSeedResetHooks(
  hooks: readonly SeedResetHookName[],
  env: EnvironmentConfig,
  account: TestAccount,
  fetchImpl: FetchFn = fetch,
): Promise<SeedResetResult[]> {
  const results: SeedResetResult[] = [];
  for (const hook of hooks) {
    results.push(await runSeedResetHook(hook, env, account, fetchImpl));
  }
  return results;
}
