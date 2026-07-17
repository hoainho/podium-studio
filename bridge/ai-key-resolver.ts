import { execFile } from "node:child_process";
import { userInfo } from "node:os";

/**
 * ai-key-resolver.ts — resolves an AI provider's `apiKeyRef` (E24,
 * janus-specs/R5-R6-ai-cloud/E24-ai-providers.md, non-negotiable #5: "Provider API keys via
 * keychain/env (apiKeyRef) only; never written to JSON flows, fixtures, or prompt logs in
 * plaintext").
 *
 * Deliberately ARCHITECTURALLY SEPARATE from bridge/secrets.ts's `${secret:...}` seam (E12) —
 * that module's own doc comment calls this out explicitly: different env-var namespace
 * (`PODIUM_AI_KEY_*` here, never `PODIUM_SECRET_*`), different keychain service-name convention,
 * different resolution function, zero shared code path. A leak of one kind of credential can
 * never happen "via" the other's plumbing because there is no shared plumbing. This mirrors
 * bridge/secrets.ts's own env-first-then-keychain order and MissingSecretError-style clear
 * failure, but is its own independent implementation, not a thin wrapper around it.
 *
 * `apiKeyRef` format (PILLAR-9-adaptive-ai.md §5.2's own config examples):
 *   - `"env:NAME"` — read the RAW env var `NAME` directly (unlike bridge/secrets.ts, this is NOT
 *     auto-prefixed — a provider config author writes the exact var name they've set, e.g.
 *     `"env:CLIPROXY_KEY"` reads `process.env.CLIPROXY_KEY` verbatim, matching the spec's own
 *     literal example).
 *   - `"keychain:service"` — read from the macOS keychain under a namespaced service string.
 *   - `null`/absent — no key needed at all (e.g. a local Ollama instance with no auth).
 */

export class MissingAiProviderKeyError extends Error {
  constructor(public readonly ref: string) {
    super(
      `AI provider key "${ref}" not found. For an "env:NAME" ref, set that exact environment ` +
        `variable. For a "keychain:service" ref, add it: security add-generic-password -a "$USER" ` +
        `-s "${ref.startsWith("keychain:") ? keychainService(ref.slice("keychain:".length)) : ref}" -w`,
    );
    this.name = "MissingAiProviderKeyError";
  }
}

export class InvalidApiKeyRefError extends Error {
  constructor(ref: string) {
    super(`Invalid apiKeyRef "${ref}" — must be "env:NAME" or "keychain:service".`);
    this.name = "InvalidApiKeyRefError";
  }
}

/** Namespaced keychain service string — distinct from bridge/secrets.ts's `keychainService()`
 * naming (`podium-studio-secret-*`) so the two credential kinds can never collide in the same
 * keychain even if a user reused a name across both. */
export function keychainService(name: string): string {
  return `podium-studio-ai-key-${name}`;
}

export type KeychainReadFn = (account: string, service: string) => Promise<string | undefined>;
export type KeychainWriteFn = (account: string, service: string, value: string) => Promise<void>;

function defaultKeychainWrite(account: string, service: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Storing an API key in the Keychain is only available on macOS."));
      return;
    }
    // `-U` updates the entry if it already exists (re-entering/rotating a key). NOTE: `security`
    // has no stdin path for add-generic-password, so the value is passed as an argv item — briefly
    // visible via `ps` to THIS same local user during the call. Acceptable for a single-user local
    // desktop app storing the user's own key (and strictly better than the previous state: the raw
    // key sitting in the registry JSON + call log). The value is never logged by us.
    execFile("security", ["add-generic-password", "-a", account, "-s", service, "-w", value, "-U"], (err) => {
      if (err) {
        reject(new Error("Failed to store the API key in the macOS Keychain."));
        return;
      }
      resolve();
    });
  });
}

/** Store a provider's API key in the macOS Keychain under this module's namespaced service, so a
 * non-technical QA can paste their key into the app once and have it resolve at call time via the
 * matching `keychain:<name>` `apiKeyRef` — no terminal, no env var, and the raw key never touches
 * the registry JSON, flow files, or the AI call log (non-negotiable #5). The `name` is the same
 * token the `apiKeyRef` carries after `keychain:` (the app uses the provider's id), and
 * `resolveApiKeyRef` reads it back through the identical `keychainService(name)` transform. */
export async function writeAiProviderKey(
  name: string,
  value: string,
  write: KeychainWriteFn = defaultKeychainWrite,
): Promise<void> {
  await write(userInfo().username, keychainService(name), value);
}

function defaultKeychainRead(account: string, service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
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

export interface AiKeyResolverDeps {
  keychainRead: KeychainReadFn;
  getEnv: (name: string) => string | undefined;
}

export function defaultAiKeyResolverDeps(): AiKeyResolverDeps {
  return { keychainRead: defaultKeychainRead, getEnv: (name) => process.env[name] };
}

/**
 * Resolve one `apiKeyRef` to its real value. Never returns a placeholder — throws
 * `MissingAiProviderKeyError` when genuinely absent, `InvalidApiKeyRefError` for a malformed ref
 * (neither "env:" nor "keychain:" prefixed) — a provider config can never silently run with an
 * unresolved/empty key.
 */
export async function resolveApiKeyRef(ref: string, deps: AiKeyResolverDeps = defaultAiKeyResolverDeps()): Promise<string> {
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const value = deps.getEnv(name);
    if (value !== undefined && value !== "") return value;
    throw new MissingAiProviderKeyError(ref);
  }
  if (ref.startsWith("keychain:")) {
    const service = keychainService(ref.slice("keychain:".length));
    const value = await deps.keychainRead(userInfo().username, service);
    if (value !== undefined && value !== "") return value;
    throw new MissingAiProviderKeyError(ref);
  }
  throw new InvalidApiKeyRefError(ref);
}

/** Mask a resolved key value out of `text` — never lets a resolved key reach a log line or the
 * AI call log (AC9: "keys resolved only from keychain/env... never synced"; the call log stores
 * prompt/response text, which could otherwise echo a key back if a provider's error message
 * includes it verbatim). */
export function redactApiKey(text: string, resolvedValue: string | undefined): string {
  if (!resolvedValue) return text;
  return text.split(resolvedValue).join("[ai-key redacted]");
}
