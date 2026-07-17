import { mkdirSync, writeFileSync } from "node:fs";
import { main, tempDir, cleanupDir } from "./_harness.ts";

/**
 * D5 (E9 review-fix): openStores() must open the derived cache INDEPENDENTLY of the primary
 * store — a primary-store failure must never also skip opening the cache. This has to run as
 * its own fixture (fresh child process) because bridge/db/index.ts's `DATA_DIR`/`PRIMARY_DB_PATH`/
 * `CACHE_DB_PATH` are computed once, at module-load time, from `PODIUM_STUDIO_DATA_DIR` — so the
 * env var must be set BEFORE that module is ever imported in this process, and the module can
 * only ever be imported (and its singletons constructed) once per process.
 */
main(async (h) => {
  const dir = tempDir("podium-studio-openstores-");
  try {
    process.env.PODIUM_STUDIO_DATA_DIR = dir;
    mkdirSync(dir, { recursive: true });
    // Pre-seed an UNRECOVERABLE corrupt primary store (no backup exists anywhere) — the
    // scenario `openStores()` must not let take down the derived cache too.
    writeFileSync(`${dir}/primary.sqlite`, Buffer.from("garbage, not a valid sqlite database file"));

    const { openStores, derivedCache } = await import("../../../bridge/db/index.ts");

    let threw = false;
    try {
      openStores();
    } catch {
      threw = true;
    }
    h.equal("primary-error-still-propagates", threw, true);
    h.equal("cache-opened-despite-primary-failure", derivedCache.isOpen(), true);

    // Prove the cache is genuinely USABLE, not just flagged "open" by coincidence.
    await derivedCache.rebuildFromFlows([]);
    h.equal("cache-usable-despite-primary-failure", derivedCache.count(), 0);
  } finally {
    delete process.env.PODIUM_STUDIO_DATA_DIR;
    cleanupDir(dir);
  }
});
