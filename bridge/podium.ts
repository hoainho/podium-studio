import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Device, InstalledApp } from "../shared/protocol.ts";

/**
 * PodiumEngine — a thin, typed wrapper around the Podium MCP server.
 *
 * The bridge spawns Podium as a child stdio process and speaks MCP to it. This is
 * the SAME engine the whole ecosystem uses; Studio adds no automation logic of its
 * own — it orchestrates Podium's deterministic tools. There is zero AI in this path.
 */

function resolvePodiumEntry(): string {
  if (process.env.PODIUM_ENTRY && existsSync(process.env.PODIUM_ENTRY)) {
    return process.env.PODIUM_ENTRY;
  }
  const candidates = [join(homedir(), "Documents/podium/dist/index.js")];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `Podium entry not found. Set the PODIUM_ENTRY environment variable to the built engine's dist/index.js. Tried:\n${candidates.join("\n")}`,
  );
}

/**
 * Which `node` binary to spawn the Podium engine with. `process.execPath` — the binary currently
 * running this process — is always the right answer now (task #21 — dedupe packaged Node
 * runtime): in dev/CLI use it's the system's plain `node`; in the packaged app, the "sidecar" IS
 * a plain vendored node binary too (scripts/vendor-node-runtime.mjs), just running the
 * esbuild-bundled bridge/server.ts as its argv script instead of a Node Single Executable
 * Application — so it's a genuine interpreter and CAN spawn an arbitrary other script with itself.
 *
 * This used to need a SEA-detection dance (`node:sea`'s `isSea()`) plus a second, separately-
 * vendored plain node binary, because the packaged sidecar was itself a SEA — a binary that can
 * only ever run its own embedded main script and crashes (`EADDRINUSE`, self-respawn) if you try
 * to reuse `process.execPath` to launch anything else. That's gone: there is no SEA build anymore,
 * so `process.execPath` is safe unconditionally. See src-tauri/README.md for the measured
 * before/after installer size.
 */
function resolvePodiumNodeCommand(): string {
  return process.execPath;
}

/** Unwrap an MCP tool result into its structured payload object. */
function unwrap(res: any): any {
  if (res?.structuredContent !== undefined) return res.structuredContent;
  const text = res?.content?.find?.((c: any) => c.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return { status: "ok", text }; }
  }
  return {};
}

export class PodiumEngine {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const entry = resolvePodiumEntry();
      const transport = new StdioClientTransport({
        command: resolvePodiumNodeCommand(),
        args: [entry],
        env: { ...process.env } as Record<string, string>,
      });
      // If the Podium child process dies (crash, kill, restart), drop the stale client
      // so the very next call transparently re-spawns and reconnects it (RC2).
      transport.onclose = () => {
        if (this.transport === transport) {
          this.client = null;
          this.transport = null;
          console.error("[podium-studio] Podium engine connection closed — will reconnect on next call");
        }
      };
      const client = new Client(
        { name: "podium-studio-bridge", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
    })();
    try {
      await this.connecting;
    } catch (err) {
      this.client = null;
      this.transport = null;
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  /** Is the transport a connection-loss error worth one transparent reconnect+retry? */
  private isConnectionError(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err).toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("closed") ||
      msg.includes("epipe") ||
      msg.includes("write after end") ||
      msg.includes("terminated") ||
      msg.includes("econnreset")
    );
  }

  private async call(name: string, args: Record<string, unknown> = {}, _retried = false): Promise<any> {
    await this.connect();
    if (!this.client) throw new Error("Podium client not connected");
    let res: any;
    try {
      res = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      // Transparent single reconnect on a dropped engine (RC2).
      if (!_retried && this.isConnectionError(err)) {
        this.client = null;
        this.transport = null;
        return this.call(name, args, true);
      }
      throw err;
    }
    const payload = unwrap(res);
    if (res.isError) {
      const msg =
        payload?.error?.message ??
        res?.content?.find?.((c: any) => c.type === "text")?.text ??
        `Podium tool ${name} failed`;
      const err: any = new Error(msg);
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  async health() {
    return this.call("podium_health");
  }

  async deviceList(): Promise<{ ios: Device[]; android: unknown }> {
    const p = await this.call("device_list");
    const ios: Device[] = (p.ios ?? []).map((d: any) => ({
      udid: d.udid,
      name: d.name,
      state: d.state,
      runtime: d.runtime,
      platform: d.platform ?? "ios-sim",
    }));
    return { ios, android: p.android };
  }

  async bootDevice(udid: string) {
    return this.call("device_boot", { udid });
  }

  async appList(udid: string): Promise<InstalledApp[]> {
    const p = await this.call("app_list", { udid });
    return (p.apps ?? []).map((a: any) => ({
      bundleId: a.bundleId,
      name: a.name,
      type: a.type,
    }));
  }

  async launchApp(udid: string, bundleId: string) {
    return this.call("app_launch", { udid, bundleId });
  }

  async terminateApp(udid: string, bundleId: string) {
    return this.call("app_terminate", { udid, bundleId });
  }

  async appState(udid: string, bundleId: string): Promise<{ installed: boolean; running: boolean }> {
    const p = await this.call("app_state", { udid, bundleId });
    return { installed: !!p.installed, running: !!p.running };
  }

  async setLocation(udid: string, latitude: number, longitude: number) {
    return this.call("set_location", { udid, latitude, longitude });
  }

  async openUrl(udid: string, url: string) {
    return this.call("open_url", { udid, url });
  }

  async inspectScreen(udid: string) {
    return this.call("inspect_screen", { udid });
  }

  async screenshot(udid: string, saveTo: string) {
    return this.call("screenshot", { udid, saveTo });
  }

  /**
   * Execute a batch of Podium steps in one call. Returns the raw run_steps payload:
   * { ok, backend, total, ran, failedAtIndex?, results: [{ i, action, ok, detail?, error? }] }
   */
  async runSteps(
    udid: string,
    steps: Array<Record<string, unknown>>,
    opts: { bundleId?: string; stopOnError?: boolean } = {},
  ) {
    return this.call("run_steps", {
      udid,
      steps,
      ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
      stopOnError: opts.stopOnError ?? true,
    });
  }

  /** Transpile a Podium step array to a durable Maestro flow (the engineer→QA bridge). */
  async exportFlow(bundleId: string, steps: Array<Record<string, unknown>>) {
    return this.call("export_flow", { bundleId, steps });
  }

  /**
   * Run an inline Maestro flow (the execution path for the extended action vocabulary
   * — double-tap, long-press, scroll, erase text, conditional tap, raw, …). run_flow
   * throws (isError) on a failed flow, so callers get a clean pass/fail.
   */
  async runFlowYaml(udid: string, yaml: string, timeoutMs = 30_000): Promise<{ ok: boolean; detail?: string }> {
    try {
      const p = await this.call("run_flow", { udid, yaml, timeoutMs });
      return { ok: p?.passed !== false, detail: undefined };
    } catch (err: any) {
      return { ok: false, detail: (err?.message ?? String(err)).slice(0, 300) };
    }
  }
}

export const engine = new PodiumEngine();
