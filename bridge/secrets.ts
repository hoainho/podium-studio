import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { containerChildren, type Flow, type FlowStep } from "../shared/ir.ts";
import type { RunEvent, RunSummary, StepResult } from "../shared/protocol.ts";

/**
 * secrets.ts — the `${secret:...}` resolution seam (E12, janus-specs/R2-desktop-android/E12-secrets-seam.md).
 *
 * HIGH-RISK / security-load-bearing (per the epic's own risk flag) — this is the ONE file a
 * security reviewer needs to read top to bottom to audit the whole seam. It is deliberately
 * kept ARCHITECTURALLY SEPARATE from AI/CloakBrowser provider-key handling
 * (`bridge/browser-driver.ts`'s `CLOAKBROWSER_LICENSE_KEY`, and any future AI provider key
 * registry, E24): different env-var namespace (`PODIUM_SECRET_*`, never `CLOAKBROWSER_*` or an
 * AI provider's own var), different resolution function, zero shared code path. A leak of one
 * kind of credential can never happen "via" the other's plumbing because there is no shared
 * plumbing.
 *
 * A `${secret:name}` reference:
 *   - lives ONLY as that literal token in a flow's JSON (steps, fixtures) — flows-store.ts
 *     never sees a resolved value, so the persisted file is exactly what spec AC1/AC2 require.
 *   - is resolved at RUN TIME, once per distinct name per run, from (in order): an env var
 *     (`PODIUM_SECRET_<NAME>`, the CI-injection path — spec AC5) then the macOS keychain
 *     (local dev). Env-first means a CI box with no keychain still works, and a developer can
 *     always override locally with an env var without touching the keychain.
 *   - throws `MissingSecretError` — a clear, actionable message containing the secret's NAME
 *     but never any value — if neither source has it (spec AC3: fail loudly, never hang,
 *     never leak a partial value in the error itself).
 *   - is stripped from any log/error text via `redactSecrets()` before that text is emitted,
 *     so even a step that successfully used a secret and then failed for an unrelated reason
 *     never lets the resolved value reach a log line (spec AC3/AC5).
 */

export const SECRET_TOKEN_SOURCE = "\\$\\{secret:([a-zA-Z0-9_.-]+)\\}";

/** Fresh RegExp per call — a shared `g`-flagged RegExp object has stateful `lastIndex` footguns. */
function secretTokenRegex(): RegExp {
  return new RegExp(SECRET_TOKEN_SOURCE, "g");
}

export class MissingSecretError extends Error {
  constructor(public readonly secretName: string) {
    super(
      `Secret "${secretName}" not found. Set it as the environment variable ` +
        `${envVarName(secretName)} (for CI), or add it to the macOS keychain: ` +
        `security add-generic-password -a "$USER" -s "${keychainService(secretName)}" -w`,
    );
    this.name = "MissingSecretError";
  }
}

/** `PODIUM_SECRET_<NAME>`, uppercased and sanitized to a valid env-var name. */
export function envVarName(secretName: string): string {
  return `PODIUM_SECRET_${secretName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Namespaced keychain service string so this never collides with another app's entries. */
export function keychainService(secretName: string): string {
  return `podium-studio-secret-${secretName}`;
}

/** Shell-out primitive for the keychain, injected so tests never touch a real keychain (mirrors bridge/doctor.ts's ExecFn). */
export type KeychainReadFn = (account: string, service: string) => Promise<string | undefined>;

function defaultKeychainRead(account: string, service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // macOS only. On any other platform (or if `security` isn't found), resolve undefined —
    // callers fall back to the env var, they never treat "keychain unavailable" as an error.
    if (process.platform !== "darwin") {
      resolve(undefined);
      return;
    }
    execFile("security", ["find-generic-password", "-a", account, "-s", service, "-w"], (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export interface SecretResolverDeps {
  keychainRead: KeychainReadFn;
  getEnv: (name: string) => string | undefined;
}

export function defaultSecretResolverDeps(): SecretResolverDeps {
  return { keychainRead: defaultKeychainRead, getEnv: (name) => process.env[name] };
}

/** Resolve ONE secret by name. Never returns a placeholder/fake value — throws when genuinely missing. */
export async function resolveSecret(name: string, deps: SecretResolverDeps = defaultSecretResolverDeps()): Promise<string> {
  const fromEnv = deps.getEnv(envVarName(name));
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fromKeychain = await deps.keychainRead(userInfo().username, keychainService(name));
  if (fromKeychain !== undefined && fromKeychain !== "") return fromKeychain;

  throw new MissingSecretError(name);
}

/** Resolve every name in `names` (deduped by the caller), returning a name→value map. Throws on the first missing one. */
export async function resolveSecrets(
  names: readonly string[],
  deps: SecretResolverDeps = defaultSecretResolverDeps(),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = await resolveSecret(name, deps);
  }
  return out;
}

/** Every distinct `${secret:name}` referenced anywhere in `text`. */
export function extractSecretNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(secretTokenRegex())) names.add(m[1]);
  return [...names];
}

/** Presentation-only step fields, never sent through `interpolate()` by `toPodiumSteps`/`stepToPodium`
 * (shared/ir.ts) — excluded here too, so a QA's free-text label/note can never be misread as a secret
 * reference that then fails the run for a name that was never actually going to be resolved/used. */
const PRESENTATION_FIELDS = new Set(["id", "label", "note", "disabled", "idempotent", "soft", "captureAs"]);

/**
 * Every distinct `${secret:name}` referenced anywhere in a flow — its `fixtures` object AND
 * every step's functional (non-presentation) string fields, recursing into `if`/`repeat`
 * containers (E4) via `containerChildren`. This is the flow-level preflight scan
 * `bridge/runner.ts` calls once per run to resolve every needed secret up front (spec
 * AC1/AC3), rather than resolving lazily per-step (which could let a run start, do partial
 * work, and fail deep into a flow on a missing secret instead of failing fast and clearly).
 */
export function collectSecretRefs(flow: Flow): string[] {
  const names = new Set<string>();
  function scanValue(v: unknown) {
    if (typeof v === "string") {
      for (const n of extractSecretNames(v)) names.add(n);
    } else if (v && typeof v === "object") {
      for (const child of Object.values(v as Record<string, unknown>)) scanValue(child);
    }
  }
  function scanSteps(steps: FlowStep[]) {
    for (const step of steps) {
      for (const [key, v] of Object.entries(step)) {
        if (PRESENTATION_FIELDS.has(key)) continue;
        scanValue(v);
      }
      const children = containerChildren(step);
      if (children) scanSteps(children);
    }
  }
  scanSteps(flow.steps);
  scanValue(flow.fixtures ?? {});
  return [...names];
}

/** Mask ONE resolved secret value out of `text` — never logs a resolved secret verbatim. */
export function redactValue(text: string, secretValue: string): string {
  if (!secretValue) return text;
  return text.split(secretValue).join("[secret redacted]");
}

/** Mask every currently-resolved secret value out of `text` (spec AC3/AC5: 0 leakage in logs/errors). */
export function redactSecrets(text: string, resolvedValues: Readonly<Record<string, string>>): string {
  return Object.values(resolvedValues).reduce((acc, v) => redactValue(acc, v), text);
}

function redactStepResult(r: StepResult, secrets: Readonly<Record<string, string>>): StepResult {
  return {
    ...r,
    detail: r.detail !== undefined ? redactSecrets(r.detail, secrets) : r.detail,
    error: r.error !== undefined ? redactSecrets(r.error, secrets) : r.error,
  };
}

/**
 * Redact every currently-resolved secret value out of a `RunSummary`'s per-step results.
 * Exported (R2 review fix — security BLOCKER) so `bridge/runner.ts` can redact the summary it
 * RETURNS/persists, not just the copy it emits over the WS — `redactRunEvent` below only ever
 * touched the event handed to `emit()`; the raw `summary` object `runFlow` returned (and that
 * `bridge/server.ts` both persisted via `primaryStore.insertRun()` and sent back as the HTTP
 * response) was never redacted at all, which is a real credential-leak path distinct from the
 * WS log stream.
 */
export function redactSummary(s: RunSummary, secrets: Readonly<Record<string, string>>): RunSummary {
  if (Object.keys(secrets).length === 0) return s;
  return { ...s, results: s.results.map((r) => redactStepResult(r, secrets)) };
}

/**
 * Redact every currently-resolved secret value out of a `RunEvent`'s text-bearing fields
 * before it's handed to the UI/CI log (spec AC3: "no partial credential fragment" in
 * error/log output; spec AC5: same for CI log output). `bridge/runner.ts` wraps its `emit`
 * callback with this so NO emission path — log line, a step's own detail/error, or the
 * final run summary — can ever carry a resolved secret verbatim, even when the step that
 * used the secret went on to fail for an unrelated reason.
 */
export function redactRunEvent(e: RunEvent, secrets: Readonly<Record<string, string>>): RunEvent {
  if (Object.keys(secrets).length === 0) return e; // nothing resolved yet this run — no-op
  switch (e.type) {
    case "log":
      return { ...e, message: redactSecrets(e.message, secrets) };
    case "step:result":
      return { ...e, result: redactStepResult(e.result, secrets) };
    case "run:end":
      return { ...e, summary: redactSummary(e.summary, secrets) };
    default:
      return e;
  }
}
