import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import type { RunEvent } from "../shared/protocol.ts";
import { engine } from "./podium.ts";
import { runDoctor } from "./doctor.ts";
import { runFlow, executeStep, createRunContext, ARTIFACTS_DIR } from "./runner.ts";
import { cancelRun, registerRun, runSuite, unregisterRun, type SuiteJob } from "./orchestrator.ts";
import { runBrowserSuite, type BrowserSuiteJob } from "./browser-driver.ts";
import { attachToWebView, inspectWebViewTree, pickWebViewLocatorAt } from "./webview-driver.ts";
import { DEMO_APP_PROFILE } from "./target-profile.ts";
import { writeRunReport } from "./report.ts";
import { createLiveSelfHealHooks } from "./selfheal-live-hooks.ts";
import { createLiveAiRecoveryHooks } from "./ai-recovery-live-hooks.ts";
import { completeWithFallback, resolveRoleChain, validateProviderRegistry, validateStartupRegistry } from "./ai-registry.ts";
import { writeAiProviderKey } from "./ai-key-resolver.ts";
import { ProviderRegistryError, scrubSecrets } from "../shared/ai-types.ts";
import { draftCoPilotSuggestion } from "./ai-copilot.ts";
import { sep } from "node:path";
import { listFlows, loadFlow, saveFlow } from "./flows-store.ts";
import { validateFlow, type Flow, type FlowStep } from "../shared/ir.ts";
import { expandFlow, type ResolveFlowFile } from "../shared/subflow.ts";
import { flowToMaestroYaml } from "../shared/maestro.ts";
import { lintFlow, dryRunFlow, type ScreenElement } from "../shared/lint.ts";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { workspaceRoot } from "./workspace.ts";
import type { DbHealthReport, DbTierHealth, EnvironmentName } from "../shared/protocol.ts";
import { derivedCache, openStores, planGc, primaryStore, runGc } from "./db/index.ts";
import {
  buildTestAccountFixtures,
  getCurrentEnvironment,
  getEnvironmentConfig,
  getTestAccount,
  isSeedResetHookName,
  listEnvironments,
  listTestAccounts,
  runSeedResetHooks,
  setCurrentEnvironment,
} from "./test-data.ts";

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "log", level: "info", message: "connected to Podium Studio bridge" } satisfies RunEvent));
});

function broadcast(event: RunEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

/** QA audit API-1: a validation/client-input failure — carries HTTP 400 so `wrap()` (and the
 * client's `friendlyApiError`) can tell it apart from a genuine unexpected server fault (500).
 * A plain `throw new Error(...)` still maps to 500 (unchanged) — this is opt-in for the guards
 * that are truly "the caller sent something invalid". */
class ClientError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

/** Pick the HTTP status for a thrown error: an explicit `.status` (ClientError, or any error that
 * sets one) wins; a `ProviderRegistryError` (bad AI config submitted by the caller) is a 400; every
 * other/unknown throw stays a 500 (a real server fault). */
function statusForError(err: any): number {
  if (typeof err?.status === "number" && err.status >= 400 && err.status <= 599) return err.status;
  if (err instanceof ProviderRegistryError) return 400;
  return 500;
}

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      res.status(statusForError(err)).json({ error: err?.message ?? String(err) });
    });
  };

// ─── Sub-flow expansion (E13), applied server-side too (follow-up) ────────────────────────────
// src/prepare-run.ts already expands `callSubFlow` steps CLIENT-SIDE before POSTing to /api/run
// or /api/suite — this covers the app's own UI. But a headless/CLI caller, or the Maestro/JUnit
// export path, can hand a flow to this server directly, bypassing that client step entirely; a
// `callSubFlow` step reaching `flowToMaestroYaml`/`runFlow` unexpanded is not something either
// knows how to execute (shared/subflow.ts's own docs: "the runner/bridge needs ZERO changes,
// because by the time it receives a flow, every callSubFlow step is already gone"). Calling
// `expandFlow` here too — defense-in-depth, single source of truth (shared/subflow.ts, not
// reimplemented) — makes that guarantee hold for EVERY entry point, not just the client's own.
// A no-op when the client already expanded (zero callSubFlow steps left to resolve).
const resolveFlowFile: ResolveFlowFile = async (file) => {
  try {
    return await loadFlow(file);
  } catch {
    return undefined; // expandFlow reports this as its own "sub-flow not found" error, in Vietnamese
  }
};

/** Expand `flow`'s callSubFlow steps (if any); throws with the (already-Vietnamese) expansion
 * errors joined together on failure, matching this file's existing `throw new Error(...)` +
 * `wrap()` convention for a 400/500-with-message response. */
async function expandOrThrow(flow: Flow): Promise<Flow> {
  const { flow: expanded, errors } = await expandFlow(flow, resolveFlowFile);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  return expanded;
}

// ─── Health & devices ─────────────────────────────────────────────────────────
app.get("/api/health", wrap(async (_req, res) => {
  try {
    const podium = await engine.health();
    res.json({ ok: true, podium });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message ?? String(err) });
  }
}));

app.get("/api/devices", wrap(async (_req, res) => {
  res.json(await engine.deviceList());
}));

// Environment Doctor (E5): red/green preflight for Xcode CLT, idb, JRE, a booted
// simulator, and the pinned Podium engine — each a real machine probe, never a stub.
app.get("/api/doctor", wrap(async (_req, res) => {
  res.json(await runDoctor());
}));

app.post("/api/boot", wrap(async (req, res) => {
  const { udid } = req.body ?? {};
  if (!udid) throw new Error("udid required");
  res.json(await engine.bootDevice(udid));
}));

app.get("/api/apps", wrap(async (req, res) => {
  const udid = String(req.query.udid ?? "");
  if (!udid) throw new Error("udid required");
  res.json({ apps: await engine.appList(udid) });
}));

app.get("/api/app-state", wrap(async (req, res) => {
  const udid = String(req.query.udid ?? "");
  const bundleId = String(req.query.bundleId ?? "");
  if (!udid || !bundleId) throw new Error("udid and bundleId required");
  res.json(await engine.appState(udid, bundleId));
}));

app.post("/api/launch", wrap(async (req, res) => {
  const { udid, bundleId } = req.body ?? {};
  if (!udid || !bundleId) throw new Error("udid and bundleId required");
  res.json(await engine.launchApp(udid, bundleId));
}));

app.post("/api/inspect", wrap(async (req, res) => {
  const { udid } = req.body ?? {};
  if (!udid) throw new Error("udid required");
  res.json(await engine.inspectScreen(udid));
}));

app.post("/api/screenshot", wrap(async (req, res) => {
  const { udid, saveTo } = req.body ?? {};
  if (!udid || !saveTo) throw new Error("udid and saveTo required");
  res.json(await engine.screenshot(udid, saveTo));
}));

// ─── Record mode: live mirror + single-step execution ────────────────────────
const LIVE_DIR = join(ARTIFACTS_DIR, "live");

// iOS point scale factor: iPads render @2x, the iPhone families here @3x. Used to
// convert a click on the pixel screenshot into the logical points Podium taps expect.
async function deviceScale(udid: string): Promise<number> {
  try {
    const { ios } = await engine.deviceList();
    const d = ios.find((x) => x.udid === udid);
    return d && /ipad/i.test(d.name) ? 2 : 3;
  } catch {
    return 3;
  }
}

// GET /api/screen?udid= — capture a fresh mirror frame; returns its path + device scale.
app.get("/api/screen", wrap(async (req, res) => {
  const udid = String(req.query.udid ?? "");
  if (!udid) throw new Error("udid required");
  await mkdir(LIVE_DIR, { recursive: true });
  const path = join(LIVE_DIR, `${udid}.png`);
  await engine.screenshot(udid, path);
  res.json({ path, scale: await deviceScale(udid), ts: Date.now() });
}));

// POST /api/act {udid, step, bundleId?} — execute ONE step live, then return a fresh
// mirror frame. This is the engine behind record mode: each recorded action is really
// performed on the device, so the QA records by doing, and the app advances as expected.
app.post("/api/act", wrap(async (req, res) => {
  const { udid, step, bundleId } = req.body ?? {};
  if (!udid || !step) throw new Error("udid and step required");
  const outcome = await executeStep(udid, step as FlowStep, bundleId, {});
  await mkdir(LIVE_DIR, { recursive: true });
  const path = join(LIVE_DIR, `${udid}.png`);
  try {
    await engine.screenshot(udid, path);
  } catch {
    /* screenshot best-effort */
  }
  res.json({
    ok: outcome.ok,
    detail: outcome.detail ?? null,
    error: outcome.ok ? null : (outcome.error ?? "step failed"),
    screen: path,
    scale: await deviceScale(udid),
    ts: Date.now(),
  });
}));

// ─── Flows CRUD ─────────────────────────────────────────────────────────────
app.get("/api/flows", wrap(async (_req, res) => {
  res.json({ flows: await listFlows() });
}));

app.get("/api/flows/:file", wrap(async (req, res) => {
  res.json(await loadFlow(req.params.file));
}));

app.post("/api/flows", wrap(async (req, res) => {
  // QA audit AUTH-2: accept either a bare flow (legacy) or `{ flow, fileName }`. When `fileName`
  // (the file the flow was loaded from) is given, saveFlow writes back to THAT file — so renaming
  // a flow updates it in place instead of creating a slug-of-new-name duplicate and orphaning the
  // original. A `Flow` never has a top-level `flow` property, so the wrapper is unambiguous.
  const body = req.body ?? {};
  const isWrapper = body && typeof body === "object" && "flow" in body;
  const flow = isWrapper ? (body as any).flow : body;
  const fileName = isWrapper && typeof (body as any).fileName === "string" ? (body as any).fileName : undefined;
  res.json(await saveFlow(flow, fileName));
}));

// ─── Export to durable Maestro (engineer→QA bridge) ───────────────────────────
app.post("/api/export", wrap(async (req, res) => {
  const v = validateFlow(req.body);
  if (!v.ok || !v.flow) throw new ClientError(`Invalid flow: ${v.errors.join("; ")}`);
  const expanded = await expandOrThrow(v.flow);
  const yaml = flowToMaestroYaml(expanded);
  // Coordinate-based taps/swipes are the only steps that don't transpile durably.
  const warnings = expanded.steps
    .filter((s) => !s.disabled && (s.action === "tap" || (s.action === "swipe" && s.startX !== undefined)))
    .map((s) => `Step "${s.label ?? s.action}" uses raw coordinates — may be brittle across screen sizes; prefer a text/id target.`);
  res.json({ yaml, warnings, lossySteps: warnings.length });
}));

// Stop a specific in-flight run (cooperative; no further steps start). E15: targets ONE run by
// id via the orchestrator's registry — cancelling run A never touches run B's in-flight worker,
// unlike the old global "the current run" flag this replaced (see bridge/runner.ts's RunContext
// / bridge/orchestrator.ts's cancelRun()). `found: false` just means that id isn't active
// anymore (already finished, or unknown) — cooperative and best-effort, same as before.
app.post("/api/cancel", wrap(async (req, res) => {
  const { runId } = req.body ?? {};
  if (!runId) throw new Error("runId required");
  const found = cancelRun(String(runId));
  res.json({ ok: true, found });
}));

// ─── Pre-run lint / dry-run (E3) ───────────────────────────────────────────────
// Best-effort flattening of Podium's inspect_screen accessibility tree into the flat
// ScreenElement[] shape lintFlow needs. inspect_screen's exact payload shape is a property of
// the Podium engine itself (not fixed by this repo), so this walks common field names
// defensively rather than assuming one schema.
function flattenScreenElements(node: unknown, out: ScreenElement[] = []): ScreenElement[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  const text = n.text ?? n.label ?? n.accessibilityLabel ?? n.name;
  const accessibilityId = n.id ?? n.accessibilityId ?? n.resourceId;
  if (typeof text === "string" || typeof accessibilityId === "string") {
    out.push({
      text: typeof text === "string" ? text : undefined,
      accessibilityId: typeof accessibilityId === "string" ? accessibilityId : undefined,
    });
  }
  const children = n.children ?? n.elements ?? [];
  if (Array.isArray(children)) for (const c of children) flattenScreenElements(c, out);
  return out;
}

// POST /api/lint {flow, udid?} — dry-run (schema-only, zero side effects) + static lint,
// plus live selector-match lint against the CURRENT screen when `udid` is given. Never taps,
// types, or launches anything — inspect_screen only READS the accessibility tree (AC5).
// Known limitation: a live check only has ONE screen snapshot (the current one) to check
// every selector-bearing step against, since actually running steps to reach later screens
// would violate "zero device/app side effects" — so the live no-match/ambiguous-match checks
// are most meaningful for the flow's first screen; later steps still get the structural
// (unreachable / no-assertion) checks regardless.
app.post("/api/lint", wrap(async (req, res) => {
  const { flow, udid } = req.body ?? {};
  const dryRun = dryRunFlow(flow);
  if (!dryRun.ok) {
    res.json({ dryRun, lint: { ok: false, findings: [], durationMs: 0 } });
    return;
  }
  const v = validateFlow(flow);
  let elements: ScreenElement[] | undefined;
  if (udid && v.flow) {
    try {
      const raw = await engine.inspectScreen(String(udid));
      elements = flattenScreenElements(raw);
    } catch {
      elements = undefined; // no live screen available — lint skips the device-dependent checks
    }
  }
  const lint = lintFlow(v.flow!, elements ? () => elements : undefined);
  res.json({ dryRun, lint });
}));

// ─── SQLite two-tier storage (E9) ──────────────────────────────────────────────
// Tier 1 (cache) vs Tier 2 (primary) is enforced in bridge/db/ itself, not here — this section
// is thin HTTP plumbing over that module, following the same wrap()/route-per-concern style as
// the rest of this file.

function tierHealth(path: string, ok: boolean, extra: Partial<DbTierHealth> = {}): DbTierHealth {
  return { ok, path, ...extra };
}

app.get("/api/db/health", wrap(async (_req, res) => {
  const primary = primaryStore.raw?.isOpen
    ? tierHealth(primaryStore.path, true, {
        schemaVersion: primaryStore.schemaVersion,
        recoveredFromBackup: primaryStore.recoveredFromBackup,
      })
    : tierHealth(primaryStore.path, false, { error: "primary store is not open — see server startup log" });
  const cache = derivedCache.isOpen()
    ? tierHealth(derivedCache.path, true)
    : tierHealth(derivedCache.path, false, { error: "derived cache is not open — see server startup log" });
  res.json({ cache, primary } satisfies DbHealthReport);
}));

app.get("/api/db/runs", wrap(async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  res.json({ runs: primaryStore.listRuns(limit) });
}));

// Manually trigger a primary-store backup (E9 AC3). Returns the backup file path.
app.post("/api/db/backup", wrap(async (_req, res) => {
  const path = await primaryStore.backup();
  res.json({ ok: true, path });
}));

// Restore the primary store from a specific backup file (E9 AC3/AC6). Destructive — overwrites
// the live primary store — so it always requires an explicit backupPath, never "latest" by
// default, to avoid an accidental silent rollback.
app.post("/api/db/restore", wrap(async (req, res) => {
  const { backupPath } = req.body ?? {};
  if (!backupPath) throw new Error("backupPath required");
  await primaryStore.restore(String(backupPath));
  res.json({ ok: true, recoveredFromBackup: primaryStore.recoveredFromBackup, schemaVersion: primaryStore.schemaVersion });
}));

// Rebuild the derived cache from the canonical JSON flows (E9 AC1) — safe to call any time,
// including after deleting cache.sqlite by hand.
app.post("/api/db/rebuild-cache", wrap(async (_req, res) => {
  const listing = await listFlows();
  const entries = [];
  for (const { file } of listing) {
    try {
      entries.push({ file, flow: await loadFlow(file) });
    } catch {
      /* skip an unreadable/invalid flow file rather than failing the whole rebuild */
    }
  }
  await derivedCache.rebuildFromFlows(entries);
  res.json({ ok: true, count: derivedCache.count() });
}));

// Read-only: what WOULD be pruned right now (E9 AC7) — never touches anything.
app.get("/api/db/gc-plan", wrap(async (req, res) => {
  const quotaBytes = Number(req.query.quotaBytes ?? 0);
  if (!quotaBytes) throw new Error("quotaBytes required");
  res.json(planGc(primaryStore, quotaBytes));
}));

// Execute retention/GC (E9 AC7). Requires `exportDir` (auto-export pruned artifacts first) or
// `force: true` (the caller already offered export and the user declined) — runGc itself
// refuses to delete anything otherwise, so that guarantee doesn't depend on this route
// remembering to ask.
app.post("/api/db/gc", wrap(async (req, res) => {
  const { quotaBytes, exportDir, force } = req.body ?? {};
  if (!quotaBytes) throw new Error("quotaBytes required");
  const plan = planGc(primaryStore, Number(quotaBytes));
  const result = await runGc(primaryStore, plan, { exportDir, force: !!force });
  res.json({ plan, result });
}));

// ─── Test-data & environment layer (E11) ───────────────────────────────────────
// stg/qa/prod is a bridge-side config selector, never a flow-level edit (spec AC2) — switching
// it changes NOTHING about any persisted flow file. A flow only ever references a test-account
// *role* (a plain fixtures string), never a raw credential or a hardcoded environment string
// (spec AC1/AC3). Credential resolution itself is out of scope here — see bridge/secrets.ts.

app.get("/api/environment", wrap(async (_req, res) => {
  res.json({ current: getCurrentEnvironment(), available: listEnvironments() });
}));

app.post("/api/environment", wrap(async (req, res) => {
  const { name } = req.body ?? {};
  if (!name) throw new Error("name required");
  setCurrentEnvironment(name as EnvironmentName);
  res.json({ current: getCurrentEnvironment(), available: listEnvironments() });
}));

// GET /api/test-accounts?env=stg — role/username only, never a resolved credential (passwordRef
// is always the still-unresolved `${secret:...}` token — see shared/protocol.ts's TestAccountSummary).
app.get("/api/test-accounts", wrap(async (req, res) => {
  const env = (String(req.query.env ?? "") || getCurrentEnvironment()) as EnvironmentName;
  res.json({ env, accounts: listTestAccounts(env) });
}));

// Run one or more known-state seeding/reset hooks for a role, independent of a flow run —
// mainly so the UI can show/confirm reset state before a run, or a QA can re-seed by hand.
app.post("/api/test-data/seed-reset", wrap(async (req, res) => {
  const { env: envName, role, hooks } = req.body ?? {};
  if (!role) throw new Error("role required");
  if (!Array.isArray(hooks) || hooks.length === 0) throw new Error("hooks (non-empty array) required");
  const badHook = hooks.find((h: unknown) => !isSeedResetHookName(h));
  if (badHook !== undefined) throw new Error(`Unknown seed-reset hook "${badHook}"`);
  const env = getEnvironmentConfig((envName || getCurrentEnvironment()) as EnvironmentName);
  const account = getTestAccount(env.name, String(role));
  if (!account) throw new Error(`No test account for role "${role}" on environment "${env.name}"`);
  const results = await runSeedResetHooks(hooks, env, account);
  res.json({ results });
}));

// ─── Run (streams events over WS, returns final summary) ──────────────────────
app.post("/api/run", wrap(async (req, res) => {
  const { udid, flow, fixtures, environment, selfHeal: selfHealEnabled, aiRecovery: aiRecoveryEnabled } = req.body ?? {};
  if (!udid) throw new Error("udid required");
  const v = validateFlow(flow);
  if (!v.ok || !v.flow) throw new ClientError(`Invalid flow: ${v.errors.join("; ")}`);
  // Follow-up (E13 defense-in-depth): expand callSubFlow steps server-side too, in case this
  // caller bypassed the client's own prepareFlowForRun() expansion — a no-op when it didn't.
  const expandedFlow = await expandOrThrow(v.flow);

  // E11: if the flow declares a test-account role (fixtures.testAccountRole — a plain string,
  // never a raw credential), resolve it against the active environment, run any declared
  // seeding/reset hooks (fixtures.seedResetHooks), and merge the account's fixtures into a
  // TRANSIENT copy of the flow — never written back to the persisted flow file (spec AC2). The
  // merged password is still just the `${secret:...}` reference; the EXISTING secrets seam
  // (bridge/secrets.ts, already wired into runFlow's preflight) resolves it, not this code.
  const env = getEnvironmentConfig((environment || getCurrentEnvironment()) as EnvironmentName);
  let flowForRun = expandedFlow;
  const role = expandedFlow.fixtures?.testAccountRole;
  if (typeof role === "string" && role) {
    const account = getTestAccount(env.name, role);
    if (!account) throw new Error(`Flow references test-account role "${role}", which is not defined for environment "${env.name}".`);
    const hooksRaw = expandedFlow.fixtures?.seedResetHooks;
    const hooks = Array.isArray(hooksRaw) ? hooksRaw.filter(isSeedResetHookName) : [];
    if (hooks.length > 0) {
      const seedResults = await runSeedResetHooks(hooks, env, account);
      for (const r of seedResults) {
        broadcast({
          type: "log",
          level: r.ok ? "info" : "warn",
          // The run-log stream is plain technical text (like every other broadcast log line), not
          // an i18n UI surface — the LOCALIZED seed-reset error lives in EnvironmentPanel via
          // errorCode (task #48). Keep the diagnostic detail that `error` used to carry by
          // appending errorParams.message.
          message: r.ok
            ? `Seed-reset "${r.hook}" for role "${r.role}" on ${env.name}: OK`
            : `Seed-reset "${r.hook}" for role "${r.role}" on ${env.name} degraded — manual reset needed${r.errorParams?.message ? ` (${r.errorParams.message})` : ""}`,
        });
      }
    }
    // Spread `expandedFlow` (not `v.flow`) as the base — otherwise this would silently discard
    // the sub-flow expansion above and revert to the original, unexpanded steps.
    flowForRun = { ...expandedFlow, fixtures: { ...expandedFlow.fixtures, ...buildTestAccountFixtures(account) } };
  }

  // E15: register this run's own context with the orchestrator so /api/cancel can target it
  // by id (the client learns the id from the "run:start" WS event, emitted before any step
  // runs). Always unregistered afterward, success or throw, so a failed/aborted run never
  // leaves a stale entry another (unrelated) runId could never collide with anyway, but which
  // would otherwise sit in the registry forever.
  const ctx = createRunContext();
  registerRun(ctx);
  // E19, opt-in (default off — omitting `selfHeal` from the request is IDENTICAL to every
  // /api/run call before this epic existed): rungs 1-3 only ever replay a PINNED lesson (AC6) or
  // re-resolve a locator that ACTUALLY currently resolves, so enabling this can only help a
  // borderline-flaky step pass more reliably — never make a genuinely-broken one pass.
  const selfHeal = selfHealEnabled ? createLiveSelfHealHooks(udid, primaryStore, flowForRun.name) : undefined;
  // E24, opt-in (default off), ADDITIVE to `selfHeal` above — rung 4 (AI) is only ever reached
  // when BOTH flags are set AND rungs 1-3 already failed (bridge/runner.ts enforces the ordering;
  // this is just "is the hooks object present at all"). Strict mode simply never sends this flag.
  const aiRecovery = aiRecoveryEnabled ? createLiveAiRecoveryHooks(primaryStore, flowForRun.name) : undefined;
  let summary: Awaited<ReturnType<typeof runFlow>>;
  try {
    summary = await runFlow(udid, flowForRun, fixtures ?? {}, broadcast, ctx, selfHeal, aiRecovery);
  } finally {
    unregisterRun(ctx.runId);
  }
  // E9: persist run history + per-step results into the primary store (Tier 2 — NOT
  // rebuildable from JSON, unlike the flow files themselves). Best-effort: a storage hiccup
  // must never take down an otherwise-successful run response — the run already happened.
  try {
    await primaryStore.insertRun(summary);
  } catch (err: any) {
    console.error("[podium-studio] failed to persist run to primary store:", err?.message ?? err);
  }
  // E18 AC4: trace + a minimal HTML report, written alongside this run's own screenshots.
  // Best-effort, same reasoning as the primaryStore write above — never blocks the response.
  try {
    await writeRunReport(flowForRun, summary);
  } catch (err: any) {
    console.error("[podium-studio] failed to write run report:", err?.message ?? err);
  }
  res.json(summary);
}));

// ─── Suite (E15): parallel orchestrated runs, merged into ONE report ──────────────────────────
// Driver-agnostic at the orchestrator layer (bridge/orchestrator.ts) — this route is the
// mobile-specific glue that turns each job request into a `runFlow` call; a future browser-suite
// route (E16) would supply a different `run()` callback over the SAME `runSuite()`.
app.post("/api/suite", wrap(async (req, res) => {
  const { jobs, concurrency, shard } = req.body ?? {};
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("jobs (non-empty array) required");

  const suiteJobs: SuiteJob<Awaited<ReturnType<typeof runFlow>>>[] = await Promise.all(jobs.map(async (job: any, i: number) => {
    if (!job?.udid) throw new Error(`jobs[${i}].udid required`);
    const v = validateFlow(job.flow);
    if (!v.ok || !v.flow) throw new Error(`jobs[${i}] has an invalid flow: ${v.errors.join("; ")}`);
    // Follow-up (E13 defense-in-depth): expand callSubFlow steps server-side too — a no-op when
    // the client already did (src/prepare-run.ts).
    const expandedFlow = await expandOrThrow(v.flow);
    return {
      tag: job.tag,
      // Task #44 — human-readable seed for this job's stable jobId (runSuite prefixes it with
      // `${suiteId}:${index}` to guarantee uniqueness even if two jobs share a udid+flowName,
      // e.g. the same flow run twice in one stability run-set).
      jobId: `${job.udid}:${expandedFlow.name}`,
      run: async (ctx) => {
        const summary = await runFlow(job.udid, expandedFlow, job.fixtures ?? {}, broadcast, ctx);
        // E18 AC4: written HERE (inside this job's own closure, not the outer loop below) so the
        // trace is always built against the CORRECT originating flow — `report.results`' order
        // isn't guaranteed to match `jobs`' order once sharded across workers.
        try {
          await writeRunReport(expandedFlow, summary);
        } catch (err: any) {
          console.error("[podium-studio] failed to write suite run report:", err?.message ?? err);
        }
        return summary;
      },
    };
  }));

  const report = await runSuite(suiteJobs, { concurrency, shard });
  // Best-effort persistence of every worker's runs, same as the single-run path above.
  for (const summary of report.results) {
    try {
      await primaryStore.insertRun(summary);
    } catch (err: any) {
      console.error("[podium-studio] failed to persist suite run to primary store:", err?.message ?? err);
    }
  }
  res.json(report);
}));

// ─── Browser suite (E16): parallel browser-flow runs, same E15 orchestrator, no orchestrator
// changes ───────────────────────────────────────────────────────────────────────────────────
// Mirrors /api/suite's shape above exactly, minus `udid` (a browser worker has none) — the
// glue that turns each job request into a `runBrowserFlow` call, supplied to the SAME
// `runSuite`-shaped pool/concurrency/sharding machinery bridge/browser-driver.ts's
// `runBrowserSuite` re-derives from bridge/orchestrator.ts's exported primitives.
app.post("/api/browser-suite", wrap(async (req, res) => {
  const { jobs, concurrency, shard } = req.body ?? {};
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("jobs (non-empty array) required");

  const browserJobs: BrowserSuiteJob[] = await Promise.all(jobs.map(async (job: any, i: number) => {
    const v = validateFlow(job.flow);
    if (!v.ok || !v.flow) throw new Error(`jobs[${i}] has an invalid flow: ${v.errors.join("; ")}`);
    // Follow-up (E13 defense-in-depth): expand callSubFlow steps server-side too — a no-op when
    // the client already did (src/prepare-run.ts).
    const expandedFlow = await expandOrThrow(v.flow);
    return { tag: job.tag, flow: expandedFlow, fixtures: job.fixtures ?? {} };
  }));

  // runtimeDir MUST be under ARTIFACTS_DIR: per-step screenshots/trace/video are written into the
  // worker's artifactsDir, and /api/artifact only serves files under ARTIFACTS_DIR — anywhere else
  // and every thumbnail URL 403s (the "?" broken-image bug).
  const report = await runBrowserSuite(browserJobs, { concurrency, shard, emit: broadcast, runtimeDir: join(ARTIFACTS_DIR, "browser") });
  // Best-effort persistence of every worker's runs, same as /api/suite above.
  //
  // E18 AC4: `runBrowserSuite` (bridge/browser-driver.ts) calls `runBrowserFlow` internally —
  // unlike /api/suite's mobile path above, there's no per-job callback here to hook the report
  // write into with a guaranteed-correct flow binding, and `report.results`' order isn't
  // guaranteed to match `browserJobs`' original order once sharded across workers. Matching by
  // `flowName` is the best-effort fallback: correct as long as flow names are distinct within one
  // suite (the normal case for a QA-composed suite); if two jobs share an identical flow name,
  // the trace still reflects the REAL summary.results either way, just with a step label that
  // could resolve against the wrong same-named flow's definitions — never a crash, never wrong
  // pass/fail data, only a cosmetic label edge case. Flagged as a known limitation rather than a
  // silently-assumed guarantee.
  const flowByName = new Map(browserJobs.map((j) => [j.flow.name, j.flow]));
  for (const summary of report.results) {
    try {
      await primaryStore.insertRun(summary);
    } catch (err: any) {
      console.error("[podium-studio] failed to persist browser-suite run to primary store:", err?.message ?? err);
    }
    const originatingFlow = flowByName.get(summary.flowName);
    if (originatingFlow) {
      try {
        await writeRunReport(originatingFlow, summary);
      } catch (err: any) {
        console.error("[podium-studio] failed to write browser-suite run report:", err?.message ?? err);
      }
    }
  }
  res.json(report);
}));

// ─── Single web-run (Web-target UI): one flow, one browser, one summary ───────────────────────
// The web target is a RUN-TIME choice (like `udid` for the mobile path), never a flow field —
// `flow.app.platform` stays locked to "ios-sim" (shared/ir.ts). Reuses the SAME runBrowserSuite
// (E16) /api/browser-suite calls above, just wrapped for the single-flow case the Web-target UI
// needs: no jobs array, no suite report — a plain RunSummary, identical in shape to /api/run's,
// so the client's existing run timeline renders it with no branching.
app.post("/api/run-web", wrap(async (req, res) => {
  const { flow, url } = req.body ?? {};
  const v = validateFlow(flow);
  if (!v.ok || !v.flow) throw new ClientError(`Invalid flow: ${v.errors.join("; ")}`);
  // Follow-up (E13 defense-in-depth): expand callSubFlow steps server-side too — a no-op when
  // the client already did (src/prepare-run.ts).
  const expandedFlow = await expandOrThrow(v.flow);
  // `url` is optional metadata only for now — the flow itself carries whatever openLink step
  // navigates the browser; nothing here rewrites steps based on it.
  void url;

  const report = await runBrowserSuite(
    [{ tag: expandedFlow.name, flow: expandedFlow, fixtures: {} }],
    // runtimeDir under ARTIFACTS_DIR so per-step screenshots/trace/video serve via /api/artifact
    // (outside it → 403 → the "?" broken-thumbnail bug).
    { emit: broadcast, runtimeDir: join(ARTIFACTS_DIR, "browser") },
  );
  const summary = report.results[0];
  if (!summary) throw new Error("Web run produced no result.");

  // Same best-effort persistence as /api/run and /api/browser-suite above — never blocks the
  // response on a storage hiccup.
  try {
    await primaryStore.insertRun(summary);
  } catch (err: any) {
    console.error("[podium-studio] failed to persist web run to primary store:", err?.message ?? err);
  }
  try {
    await writeRunReport(expandedFlow, summary);
  } catch (err: any) {
    console.error("[podium-studio] failed to write web run report:", err?.message ?? err);
  }
  res.json(summary);
}));

// ─── Target profiles + WebView-aware inspector (E17) ──────────────────────────────────────────
// Runtime-gated: attachToWebView's real connection needs a live simulator/device with the
// target app's WebView remote-debugging reachable (iOS Safari Web Inspector / Android
// chrome://inspect over adb) — on a machine without one, these honestly fail via `wrap()`'s
// existing 500-with-message path, never faking success, same contract /api/inspect's mobile
// a11y-tree path already has. Stateless per call (attach, do the one thing, close) — mirrors
// /api/inspect's own no-server-side-session design for the mobile path.

app.get("/api/target-profiles", wrap(async (_req, res) => {
  res.json({ profiles: [DEMO_APP_PROFILE] });
}));

// POST /api/webview/inspect {udid, bundleId} — element tree for the inspector UI (AC1).
app.post("/api/webview/inspect", wrap(async (req, res) => {
  const { udid, bundleId } = req.body ?? {};
  if (!udid || !bundleId) throw new Error("udid and bundleId required");
  const handle = await attachToWebView({ udid, bundleId });
  try {
    const tree = await inspectWebViewTree(handle.page);
    res.json({ tree });
  } finally {
    await handle.close();
  }
}));

// POST /api/webview/pick {udid, bundleId, x, y} — click-to-select -> a working locator (AC1).
app.post("/api/webview/pick", wrap(async (req, res) => {
  const { udid, bundleId, x, y } = req.body ?? {};
  if (!udid || !bundleId) throw new Error("udid and bundleId required");
  if (typeof x !== "number" || typeof y !== "number") throw new Error("x and y (numbers) required");
  const handle = await attachToWebView({ udid, bundleId });
  try {
    const locator = await pickWebViewLocatorAt(handle.page, x, y);
    res.json({ locator: locator ?? null });
  } finally {
    await handle.close();
  }
}));

// ─── Self-heal rungs 0-3 + learning store (E19) ────────────────────────────────────────────────
// A rung 1/2 heal is recorded automatically as an UNPINNED lesson (bridge/selfheal-live-hooks.ts's
// onHealAttempt, wired into /api/run above) — that's just data capture (Pillar 9 §3: every run
// writes to the learning store). PINNING it — the only thing that makes it Strict-replayable
// (AC6) — is always this SEPARATE, explicit call. Nothing on the run path ever calls this itself.
app.post("/api/selfheal/pin", wrap(async (req, res) => {
  const { lessonId } = req.body ?? {};
  if (!lessonId) throw new Error("lessonId required");
  await primaryStore.pinLesson(String(lessonId));
  res.json({ ok: true });
}));

// ─── AI provider registry + authoring co-pilot (E24) ───────────────────────────────────────────
// AI is OFF by default (RunRequest.aiRecovery, wired into /api/run above) and fully absent from
// Strict mode — this section is config CRUD + the co-pilot draft endpoint, never itself a code
// path a run takes unless the caller opts in.

// The WHOLE registry, read/replaced atomically — never a per-row PATCH (see
// bridge/db/primary-store.ts's getProviderRegistry/saveProviderRegistry doc comments for why).
app.get("/api/ai/providers", wrap(async (_req, res) => {
  res.json(primaryStore.getProviderRegistry());
}));

// AC5 (hot-path guard, BLOCKING): validateProviderRegistry throws (→ wrap() turns it into a
// 400/500 with a clear message) if an `agent-cli` provider is referenced under `routing.recovery`
// — a bad registry is REJECTED here, never persisted even transiently, exactly like this file's
// own `expandOrThrow` convention for "throw with a clear message, let wrap() respond".
// QA follow-up (non-tech key entry): store a pasted API key in the macOS Keychain so co-pilot/
// rung-4 can resolve it via a `keychain:<name>` apiKeyRef — the ONLY in-app way to supply a key
// without a terminal/env-var step. The raw key is written straight to the Keychain and is NEVER
// persisted to the registry JSON, echoed in the response, or logged.
app.post("/api/ai/provider-key", wrap(async (req, res) => {
  const { name, key } = req.body ?? {};
  if (!name || typeof name !== "string") throw new ClientError("name required");
  if (!key || typeof key !== "string" || key.trim() === "") throw new ClientError("key required");
  await writeAiProviderKey(name, key);
  res.json({ ok: true, apiKeyRef: `keychain:${name}` });
}));

// Verify an AI provider actually works end-to-end (key resolves + a real minimal completion
// succeeds), so a non-technical QA can confirm "my AI is set up" in one click instead of only
// finding out when co-pilot/rung-4 fails mid-task. Tests a specific `id`, or the primary authoring
// provider when none given. The key is never logged; any failure message is scrubbed of secrets.
app.post("/api/ai/test-provider", wrap(async (req, res) => {
  const { id } = req.body ?? {};
  const registry = primaryStore.getProviderRegistry();
  const targetId =
    (typeof id === "string" && id) ||
    registry.routing.authoring.find((pid) => registry.providers.some((p) => p.id === pid && p.enabled)) ||
    registry.providers.find((p) => p.enabled)?.id;
  const provider = registry.providers.find((p) => p.id === targetId);
  if (!provider) throw new ClientError("No AI provider to test — add and enable one first.");
  const { providers } = resolveRoleChain(registry, "authoring");
  const start = Date.now();
  try {
    await completeWithFallback(
      [provider.id],
      providers,
      [{ role: "user", content: "Reply with the single word: OK" }],
      { temperature: 0, maxTokens: 5 },
      15000,
    );
    res.json({
      ok: true,
      provider: provider.name,
      model: provider.kind === "openai-compatible" ? provider.model : provider.command,
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    res.json({ ok: false, provider: provider.name, error: scrubSecrets(err instanceof Error ? err.message : String(err)) });
  }
}));

app.post("/api/ai/providers", wrap(async (req, res) => {
  const config = req.body ?? {};
  validateProviderRegistry(config);
  await primaryStore.saveProviderRegistry(config);
  // Return the persisted registry (not just {ok:true}) — the client re-seeds its state from the
  // response, so echoing the stored config keeps the UI and DB in exact sync after a save.
  res.json(primaryStore.getProviderRegistry());
}));

// Strict/Adaptive mode — a single per-workspace setting persisted to a small JSON file. It is NOT
// itself a run-affecting value (a run opts into AI via RunRequest.aiRecovery); it's the UI's
// remembered default. Defaults to "strict" (AI off) when unset or unreadable.
const AI_MODE_FILE = join(workspaceRoot(), "ai-mode.json");
const AI_MODES = new Set(["strict", "adaptive"]);
async function readAiMode(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(AI_MODE_FILE, "utf8"));
    return AI_MODES.has(raw?.mode) ? raw.mode : "strict";
  } catch {
    return "strict";
  }
}
app.get("/api/ai/mode", wrap(async (_req, res) => {
  res.json({ mode: await readAiMode() });
}));
app.post("/api/ai/mode", wrap(async (req, res) => {
  const mode = req.body?.mode;
  if (!AI_MODES.has(mode)) throw new ClientError(`Invalid AI mode "${mode}" — expected "strict" or "adaptive".`);
  await mkdir(workspaceRoot(), { recursive: true });
  await writeFile(AI_MODE_FILE, JSON.stringify({ mode }) + "\n", "utf8");
  res.json({ mode });
}));

// AC9 guardrail — "opt-in + purgeable": the call log is sensitive-at-rest (it can carry real
// logged-in screen content), so a QA can inspect it and wipe it entirely on demand, same as any
// other opt-in diagnostic log. GET returns newest first, matching primaryStore.listAiCallLog's
// own ordering.
app.get("/api/ai/call-log", wrap(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  // QA audit API-8: scrub credential-shaped strings on read too (defense-in-depth for entries
  // written before the write-path scrub landed — e.g. a password a QA typed into an older prompt).
  const entries = primaryStore.listAiCallLog(limit).map((e) => ({
    ...e,
    prompt: scrubSecrets(e.prompt),
    response: scrubSecrets(e.response),
  }));
  res.json({ entries });
}));

app.post("/api/ai/call-log/purge", wrap(async (_req, res) => {
  await primaryStore.purgeAiCallLog();
  res.json({ ok: true });
}));

// AC7: always a review diff, never a write — draftCoPilotSuggestion only ever returns a
// CoPilotSuggestion (pure data); nothing here touches a flow file. `agent-cli` IS reachable here
// (the `authoring` role has no hot-path guard, unlike `recovery`) since co-pilot's own multi-turn/
// multi-hunk nature is explicitly in scope for it (spec §5.3). Logged the same as a rung-4 call
// (security-review fix — this was previously the one AI call path with no audit trail at all).
app.post("/api/ai/copilot/draft", wrap(async (req, res) => {
  const { prompt, flow } = req.body ?? {};
  if (!prompt) throw new ClientError("prompt required");
  // Security-review follow-up: `flow` (when suggesting edits to an EXISTING flow, as opposed to
  // drafting a new one) is client-supplied — validate it with the SAME `validateFlow` gate
  // `/api/run` already uses, before it's ever handed to bridge/ai-copilot.ts's prompt builder
  // (which reads `.app.bundleId`/`.steps` directly). A malformed flow now fails clearly here
  // instead of surfacing as a raw property-access crash deeper in the call stack.
  let validatedFlow: Flow | undefined;
  if (flow !== undefined) {
    const v = validateFlow(flow);
    if (!v.ok || !v.flow) throw new ClientError(`Invalid flow: ${v.errors.join("; ")}`);
    validatedFlow = v.flow;
  }
  const registry = primaryStore.getProviderRegistry();
  const { chain, providers } = resolveRoleChain(registry, "authoring");
  // 60s budget: a full flow-draft generation (maxTokens 4000 + system prompt) routinely takes far
  // longer than completeWithFallback's 5s default — that default was silently timing co-pilot out
  // and surfacing as the generic "no provider responded" error, even with a working key/model.
  const outcome = await draftCoPilotSuggestion({ prompt: String(prompt), flow: validatedFlow, authoringChain: chain, providers, timeoutMs: 60000 });
  try {
    await primaryStore.insertAiCallLog(outcome.logEntry);
  } catch (err: any) {
    console.error("[podium-studio] co-pilot: failed to write AI call log:", err?.message ?? err);
  }
  if (outcome.error) throw new Error(outcome.error);
  res.json(outcome.suggestion);
}));

// Suggest additional/stronger assertions for an EXISTING flow — same review-diff contract + audit
// log as /draft; the flow is the real input, with a fixed assertions-focused prompt.
app.post("/api/ai/copilot/suggest-assertions", wrap(async (req, res) => {
  const { flow } = req.body ?? {};
  const v = validateFlow(flow);
  if (!v.ok || !v.flow) throw new ClientError(`Invalid flow: ${v.errors.join("; ")}`);
  const registry = primaryStore.getProviderRegistry();
  const { chain, providers } = resolveRoleChain(registry, "authoring");
  const outcome = await draftCoPilotSuggestion({
    prompt:
      "Suggest additional or stronger assertions for this flow so it verifies real success (not just that steps ran). Keep the existing steps; add or tighten assertions only.",
    flow: v.flow,
    authoringChain: chain,
    providers,
    timeoutMs: 60000, // see /draft above — 5s default silently timed out real generations
  });
  try {
    await primaryStore.insertAiCallLog(outcome.logEntry);
  } catch (err: any) {
    console.error("[podium-studio] co-pilot suggest-assertions: failed to write AI call log:", err?.message ?? err);
  }
  if (outcome.error) throw new Error(outcome.error);
  res.json(outcome.suggestion);
}));

// ─── Artifact serving (screenshots) — path-safe ───────────────────────────────
app.get("/api/artifact", wrap(async (req, res) => {
  const p = resolve(String(req.query.path ?? ""));
  // Exact dir or a true child (prefix + separator) — not a sibling like "artifacts-x".
  if (p !== ARTIFACTS_DIR && !p.startsWith(ARTIFACTS_DIR + sep)) {
    res.status(403).json({ error: "path outside artifacts dir" });
    return;
  }
  try {
    await stat(p);
  } catch {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.type(p.endsWith(".jpg") ? "image/jpeg" : "image/png");
  createReadStream(p).pipe(res);
}));

// QA audit API-4: unknown routes + wrong methods used to fall through to Express's default HTML
// error page ("Cannot GET /..."), which breaks the app's uniform `{ error }` JSON contract. A
// JSON 404 catch-all + a final error handler keep EVERY error path shaped the way the client's
// request() expects, and the error handler also catches synchronous throws that bypass wrap().
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(statusForError(err)).json({ error: err?.message ?? String(err) });
});

server.listen(PORT, () => {
  console.log(`[podium-studio] bridge listening on http://localhost:${PORT}`);
  engine.connect().then(
    () => console.log("[podium-studio] connected to Podium engine"),
    (err) => console.error("[podium-studio] Podium engine connect failed:", err?.message ?? err),
  );
  // E9: open both SQLite tiers at startup. A corrupted primary store with no usable backup
  // throws PrimaryStoreCorruptedError — caught here so a bad DB file never crashes the whole
  // bridge process (AC6's "no unhandled crash"); /api/db/health reports the real state instead,
  // and every write path below is already wrapped to degrade gracefully if the store never opened.
  try {
    openStores();
    console.log(`[podium-studio] SQLite stores ready (schema v${primaryStore.schemaVersion})`);
    // E24 AC5 — "config-load reject... process does not start": validate whatever AI provider
    // registry is ALREADY persisted, not just what a future POST /api/ai/providers submits.
    // `validateStartupRegistry` (bridge/ai-registry.ts) tolerates every OTHER validation issue as
    // log-and-continue (same "never take down an otherwise-working server" convention as the
    // rest of this startup block) but refuses to start (exits) specifically for the one
    // non-negotiable violation — an agent-cli provider routed to recovery — matching AC5's own
    // literal wording. Every AI code path still independently re-filters agent-cli out of the
    // recovery role at dispatch time regardless (bridge/ai-registry.ts's `resolveRoleChain`) —
    // this startup gate is belt-and-suspenders, not the only line of defense.
    validateStartupRegistry(primaryStore.getProviderRegistry());
  } catch (err: any) {
    console.error("[podium-studio] Primary store failed to open:", err?.message ?? err);
  }
});
