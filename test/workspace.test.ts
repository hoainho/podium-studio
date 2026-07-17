import { describe, it, expect, vi, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../bridge/workspace.ts";

// Regression guard for the packaged-app bug where the bridge (launched by macOS with cwd "/")
// built qa/flows, data, artifacts and .runtime under "/", crashing with `mkdir '/qa'`.
describe("workspaceRoot()", () => {
  const savedEnv = process.env.PODIUM_STUDIO_WORKSPACE;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PODIUM_STUDIO_WORKSPACE;
    else process.env.PODIUM_STUDIO_WORKSPACE = savedEnv;
    vi.restoreAllMocks();
  });

  it("prefers the explicit PODIUM_STUDIO_WORKSPACE env (what the Tauri shell sets)", () => {
    process.env.PODIUM_STUDIO_WORKSPACE = "/Users/qa/Library/Application Support/Podium Studio";
    expect(workspaceRoot()).toBe("/Users/qa/Library/Application Support/Podium Studio");
  });

  it("trims whitespace and ignores a blank env value", () => {
    process.env.PODIUM_STUDIO_WORKSPACE = "   ";
    vi.spyOn(process, "cwd").mockReturnValue("/Users/qa/repo/podium-studio");
    expect(workspaceRoot()).toBe("/Users/qa/repo/podium-studio");
  });

  it("uses process.cwd() in dev when it is a real writable dir", () => {
    delete process.env.PODIUM_STUDIO_WORKSPACE;
    vi.spyOn(process, "cwd").mockReturnValue("/Users/qa/repo/podium-studio");
    expect(workspaceRoot()).toBe("/Users/qa/repo/podium-studio");
  });

  it("never returns root: falls back to a user dir when cwd is '/' (packaged launch)", () => {
    delete process.env.PODIUM_STUDIO_WORKSPACE;
    vi.spyOn(process, "cwd").mockReturnValue("/");
    const root = workspaceRoot();
    expect(root).not.toBe("/");
    expect(root.startsWith("/qa")).toBe(false);
    expect(root).toBe(join(homedir(), "Library", "Application Support", "Podium Studio"));
  });
});
