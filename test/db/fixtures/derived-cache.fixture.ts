import { existsSync, rmSync, writeFileSync } from "node:fs";
import { DerivedCache } from "../../../bridge/db/derived-cache.ts";
import type { Flow } from "../../../shared/ir.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

function makeFlow(name: string, bundleId: string, stepCount = 3): Flow {
  return {
    schemaVersion: 1,
    name,
    app: { bundleId, platform: "ios-sim" },
    steps: Array.from({ length: stepCount }, (_, i) => ({ id: `s${i}`, action: "screenshot" as const })),
  };
}

main(async (h) => {
  const dir = tempDir("podium-studio-cache-");
  try {
    // ── rebuild + search (E9 AC1) ──────────────────────────────────────────────────────────
    {
      const path = `${dir}/cache.sqlite`;
      const cache = new DerivedCache(path);
      cache.open();
      await cache.rebuildFromFlows([
        { file: "login.flow.json", flow: makeFlow("Login flow", "com.example.app") },
        { file: "checkout.flow.json", flow: makeFlow("Checkout flow", "com.example.shop") },
      ]);

      h.equal("count-after-rebuild", cache.count(), 2);
      h.equal("search-by-name", cache.search("login").map((e) => e.file), ["login.flow.json"]);
      h.equal("search-by-bundleId", cache.search("com.example.shop").map((e) => e.file), ["checkout.flow.json"]);
      h.equal("search-no-match", cache.search("nonexistent-xyz"), []);
      cache.close();
    }

    // ── rebuild is a clean-slate replace, not a merge ──────────────────────────────────────
    {
      const path = `${dir}/cache2.sqlite`;
      const cache = new DerivedCache(path);
      cache.open();
      await cache.rebuildFromFlows([{ file: "a.flow.json", flow: makeFlow("A", "com.a") }]);
      h.equal("first-rebuild-count", cache.count(), 1);
      await cache.rebuildFromFlows([{ file: "b.flow.json", flow: makeFlow("B", "com.b") }]);
      h.equal("second-rebuild-count", cache.count(), 1);
      h.equal("second-rebuild-contents", cache.list().map((e) => e.file), ["b.flow.json"]);
      cache.close();
    }

    // ── delete the cache file entirely, then reopen+rebuild fully restores it (AC1) ────────
    {
      const path = `${dir}/cache3.sqlite`;
      const flows = [
        { file: "one.flow.json", flow: makeFlow("One", "com.one", 5) },
        { file: "two.flow.json", flow: makeFlow("Two", "com.two", 7) },
      ];
      const cache = new DerivedCache(path);
      cache.open();
      await cache.rebuildFromFlows(flows);
      h.equal("pre-delete-count", cache.count(), 2);
      cache.close();

      rmSync(path, { force: true });
      rmSync(path + "-wal", { force: true });
      rmSync(path + "-shm", { force: true });
      h.equal("file-actually-deleted", existsSync(path), false);

      const rebuilt = new DerivedCache(path);
      rebuilt.open();
      await rebuilt.rebuildFromFlows(flows);
      h.equal("file-recreated", existsSync(path), true);
      h.equal("rebuilt-count", rebuilt.count(), 2);
      h.equal("rebuilt-search-works", rebuilt.search("one").map((e) => e.file), ["one.flow.json"]);
      h.equal("rebuilt-step-count-preserved", rebuilt.list().find((e) => e.file === "two.flow.json")?.steps, 7);
      rebuilt.close();
    }

    // ── Corruption self-heal (E9 review-fix, D4) — a corrupt cache file must NEVER brick the
    // whole app the way a corrupt PRIMARY store would; this tier is fully rebuildable, so
    // open() drops + recreates it instead of throwing. ─────────────────────────────────────
    {
      const path = `${dir}/cache-corrupt.sqlite`;
      writeFileSync(path, Buffer.from("garbage, not a valid sqlite database file"));

      const cache = new DerivedCache(path);
      let openThrew = false;
      try {
        cache.open();
      } catch {
        openThrew = true;
      }
      h.equal("corrupt-cache-open-does-not-throw", openThrew, false);
      h.equal("corrupt-cache-self-healed-empty", cache.count(), 0);

      await cache.rebuildFromFlows([{ file: "z.flow.json", flow: makeFlow("Z", "com.z") }]);
      h.equal("corrupt-cache-usable-after-heal", cache.count(), 1);
      cache.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
