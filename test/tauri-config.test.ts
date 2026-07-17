import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * E8 (Tauri desktop packaging) config-shape validation. This deliberately does NOT require a
 * real Rust/Tauri build (that's verified separately — see src-tauri/README.md for the real,
 * measured build results) — it checks that the config/scripts/capability SOURCE FILES declare
 * what the epic's ACs require, so a regression here (someone removing the sidecar declaration,
 * forgetting the shell permission, etc.) is caught by `npm test` without needing Rust installed
 * in CI.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_TAURI = join(ROOT, "src-tauri");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("tauri.conf.json — sidecar + bundle declarations (E8 AC1/AC3/AC4)", () => {
  const conf = readJson(join(SRC_TAURI, "tauri.conf.json"));

  it("declares the bridge sidecar in bundle.externalBin", () => {
    expect(conf.bundle?.externalBin).toContain("binaries/podium-studio-bridge");
  });

  it("declares the vendored Podium engine, the bridge bundle, and the manifest as bundled resources", () => {
    const resources = conf.bundle?.resources;
    expect(resources).toBeTruthy();
    const keys = Array.isArray(resources) ? resources : Object.keys(resources);
    expect(keys.some((k: string) => k.includes("podium-engine"))).toBe(true);
    expect(keys.some((k: string) => k.includes("resources/bridge"))).toBe(true);
    expect(keys.some((k: string) => k.includes("bundle-manifest.json"))).toBe(true);
  });

  it("task #21 — no second node-runtime resource (deduped: the sidecar binary IS the plain node runtime now)", () => {
    const resources = conf.bundle?.resources;
    const keys = Array.isArray(resources) ? resources : Object.keys(resources);
    expect(keys.some((k: string) => k.includes("node-runtime"))).toBe(false);
  });

  it("has a non-empty icon set (generate_context! fails outright without one)", () => {
    expect(Array.isArray(conf.bundle?.icon)).toBe(true);
    expect(conf.bundle.icon.length).toBeGreaterThan(0);
    for (const icon of conf.bundle.icon) {
      expect(existsSync(join(SRC_TAURI, icon)), `missing icon file: ${icon}`).toBe(true);
    }
  });

  it("dev/build commands only run the frontend, not a separate raw bridge process (the sidecar owns that now)", () => {
    expect(conf.build.beforeDevCommand).not.toMatch(/dev:bridge|"npm run dev"$/);
    expect(conf.build.beforeBuildCommand).toMatch(/build/);
  });

  it("declares a version (used by the bundle manifest and the About panel)", () => {
    expect(typeof conf.version).toBe("string");
    expect(conf.version.length).toBeGreaterThan(0);
  });
});

describe("package.json — sidecar/vendor/manifest build scripts + tauri tooling (E8)", () => {
  const pkg = readJson(join(ROOT, "package.json"));

  it.each(["sidecar:build", "vendor:podium", "manifest:generate", "tauri", "tauri:dev", "tauri:build"])(
    "declares the %s script",
    (name) => {
      expect(pkg.scripts[name]).toBeTruthy();
    },
  );

  it("tauri:build composes sidecar+vendor+manifest generation before the real tauri build", () => {
    const script = pkg.scripts["tauri:build"];
    expect(script.indexOf("sidecar:build")).toBeLessThan(script.indexOf("tauri build"));
    expect(script.indexOf("vendor:podium")).toBeLessThan(script.indexOf("tauri build"));
    expect(script.indexOf("manifest:generate")).toBeLessThan(script.indexOf("tauri build"));
  });

  it("has @tauri-apps/cli as a devDependency", () => {
    expect(pkg.devDependencies["@tauri-apps/cli"]).toBeTruthy();
  });

  it("has esbuild available for the sidecar build (not just transitive)", () => {
    expect(pkg.devDependencies.esbuild).toBeTruthy();
  });

  it("task #21 — no longer depends on postject (no SEA blob injection anymore)", () => {
    expect(pkg.devDependencies.postject).toBeUndefined();
  });
});

describe("Cargo.toml + Rust glue (E8)", () => {
  const cargoToml = readFileSync(join(SRC_TAURI, "Cargo.toml"), "utf8");

  it("declares tauri-plugin-shell (needed to spawn the sidecar)", () => {
    expect(cargoToml).toMatch(/tauri-plugin-shell/);
  });

  it("src/lib.rs and src/build.rs exist (both were missing pre-E8 — cargo check failed without them)", () => {
    expect(existsSync(join(SRC_TAURI, "src", "lib.rs"))).toBe(true);
    expect(existsSync(join(SRC_TAURI, "build.rs"))).toBe(true);
  });

  it("lib.rs spawns the sidecar by its declared name and forwards its output", () => {
    const libRs = readFileSync(join(SRC_TAURI, "src", "lib.rs"), "utf8");
    expect(libRs).toMatch(/sidecar\(\s*"podium-studio-bridge"\s*\)/);
    expect(libRs).toMatch(/tauri_plugin_shell::init/);
  });

  it("task #21 — lib.rs passes the bridge bundle resource path as an argv arg (the sidecar is a plain node interpreter now, not a self-running SEA)", () => {
    const libRs = readFileSync(join(SRC_TAURI, "src", "lib.rs"), "utf8");
    expect(libRs).toMatch(/resources\/bridge\/bridge-bundle\.cjs/);
    expect(libRs).toMatch(/\.args\(\s*\[/);
  });

  it("task #21 — lib.rs no longer sets PODIUM_STUDIO_NODE_RUNTIME (deduped: no second node copy to point at)", () => {
    const libRs = readFileSync(join(SRC_TAURI, "src", "lib.rs"), "utf8");
    // A doc comment is allowed to NAME the old env var for institutional memory (this repo's own
    // established comment style); what must be gone is any actual CODE that sets it.
    expect(libRs).not.toMatch(/\.env\(\s*"PODIUM_STUDIO_NODE_RUNTIME"/);
  });
});

describe("Capabilities — shell:allow-execute scoped to the sidecar only (E8)", () => {
  const capability = readJson(join(SRC_TAURI, "capabilities", "default.json"));

  it("grants shell:allow-execute", () => {
    const perm = capability.permissions.find((p: any) => p.identifier === "shell:allow-execute" || p === "shell:allow-execute");
    expect(perm).toBeTruthy();
  });

  it("scopes the permission to the podium-studio-bridge sidecar specifically, not an open shell", () => {
    const perm = capability.permissions.find((p: any) => p.identifier === "shell:allow-execute");
    expect(perm.allow).toEqual([expect.objectContaining({ name: "podium-studio-bridge", sidecar: true })]);
  });
});

describe("generate-bundle-manifest.mjs — real script output shape (E8 AC3)", () => {
  it("produces a manifest disclosing every component's mode (bundled vs doctor-managed), generated from real inputs", () => {
    const scriptPath = join(ROOT, "scripts", "generate-bundle-manifest.mjs");
    execFileSync(process.execPath, [scriptPath], { cwd: ROOT });
    const manifest = readJson(join(SRC_TAURI, "bundle-manifest.json"));

    expect(typeof manifest.generatedAt).toBe("string");
    expect(manifest.components.bridgeSidecar.mode).toBe("bundled");
    expect(manifest.components.podiumEngine.mode).toBe("bundled");
    expect(manifest.components.bridgeBundle.mode).toBe("bundled");
    expect(manifest.components.nodeRuntime).toBeUndefined(); // task #21 — deduped, no second copy
    // Zero undisclosed binaries: every declared component states its mode explicitly — no
    // component is silently omitted from the manifest.
    for (const name of ["bridgeSidecar", "podiumEngine", "bridgeBundle", "maestro", "jre", "idb"]) {
      expect(manifest.components[name]?.mode, `component "${name}" has no disclosed mode`).toMatch(
        /^(bundled|doctor-managed)$/,
      );
    }
  });
});

describe("bridge/podium.ts — engine spawn, deduped Node runtime (task #21, supersedes E8-fix's SEA dance)", () => {
  const podiumTs = readFileSync(join(ROOT, "bridge", "podium.ts"), "utf8");

  it("resolvePodiumNodeCommand is unconditionally process.execPath now — no SEA detection left", () => {
    const fn = podiumTs.match(/function resolvePodiumNodeCommand\(\)[\s\S]*?\n}/)?.[0];
    expect(fn, "resolvePodiumNodeCommand not found").toBeTruthy();
    expect(fn).toMatch(/return process\.execPath;/);
  });

  it("no remaining node:sea usage / SEA-detection code / PODIUM_STUDIO_NODE_RUNTIME references (dedupe is complete, not partial)", () => {
    // A doc comment is allowed to NAME "node:sea" for institutional memory (this repo's own
    // established style — see e.g. bridge/podium.ts's E8-fix history elsewhere); what must be
    // gone is any actual CODE that requires/uses it.
    expect(podiumTs).not.toMatch(/require\(\s*["']node:sea["']\s*\)/);
    expect(podiumTs).not.toMatch(/isRunningAsSea/);
    expect(podiumTs).not.toMatch(/getNodeRequire/);
    expect(podiumTs).not.toMatch(/PODIUM_STUDIO_NODE_RUNTIME/);
    expect(podiumTs).not.toMatch(/createRequire/);
  });

  it("actually runs under this repo's vitest — a real, unmocked import", async () => {
    const mod = await import("../bridge/podium.ts");
    expect(mod.engine).toBeTruthy();
  });
});
