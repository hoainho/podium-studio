import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `node:sqlite` is a genuine, stable Node built-in (confirmed working directly under plain
 * `node`) — but the pinned vitest@2.1.9/vite-node toolchain in THIS repo has a hardcoded
 * builtin-prefix allowlist (`vite-node/dist/utils.mjs`'s `prefixedBuiltins` Set only contains
 * `"node:test"`) that strips the `"node:"` prefix off every OTHER builtin specifier before
 * checking whether it's external, so `import ... from "node:sqlite"` gets misresolved to a bare
 * `"sqlite"` package and fails to load — purely a test-tooling limitation of this vitest
 * version, not a bug in the product code (bridge/db/* runs correctly under plain Node, which is
 * how the real bridge server executes it).
 *
 * Rather than bump vitest across a major version (out of scope / too much blast radius for a
 * high-risk storage epic touched by several concurrent workers) or patch node_modules, every
 * test that needs `node:sqlite` runs its actual logic in a genuine child `node` process (which
 * this repo's Node version runs .ts files in natively, no build step) via one of the
 * `fixtures/*.ts` scripts, and only PARSES the child's JSON result back in the vitest process.
 * This is incidentally exactly the kind of real multi-process execution E9 AC5's stress test
 * needs anyway.
 */

export interface FixtureCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface FixtureResult {
  checks: FixtureCheck[];
  /** Present only when the fixture script itself crashed/threw before producing checks. */
  error?: string;
}

/** Run a fixture script (relative to test/db/fixtures/) with the given argv, parsing its final
 * stdout line as a FixtureResult. Never throws — a crash is reported as `{checks: [], error}`
 * so the caller can assert on it like any other result. */
export function runFixture(fixtureFile: string, args: string[] = []): FixtureResult {
  const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFile}`, import.meta.url));
  const res = spawnSync(process.execPath, [fixturePath, ...args], { encoding: "utf8" });
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    return { checks: [], error: `fixture "${fixtureFile}" produced no output (exit ${res.status}). stderr: ${res.stderr}` };
  }
  try {
    return JSON.parse(lastLine) as FixtureResult;
  } catch {
    return { checks: [], error: `fixture "${fixtureFile}" output was not valid JSON: ${lastLine}\nstderr: ${res.stderr}` };
  }
}

/** Look up one named check, throwing a clear error if the fixture never reported it (e.g. the
 * fixture crashed before reaching that point) rather than silently passing. */
export function getCheck(result: FixtureResult, name: string): FixtureCheck {
  const c = result.checks.find((x) => x.name === name);
  if (!c) throw new Error(`fixture never reported check "${name}" (fixture error: ${result.error ?? "none"})`);
  return c;
}
