import { existsSync, writeFileSync } from "node:fs";
import { PrimaryStore } from "../../../bridge/db/primary-store.ts";
import { contentChecksum, rowCounts } from "../../../bridge/db/checksum.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

/**
 * E19 AC7 — learning store backs up and restores with zero data loss (row counts + content
 * checksum identical pre/post restore, across all 4 new tables) — mirrors E9's own
 * primary-store.fixture.ts pattern exactly, scoped to the E19-specific tables so this stays
 * readable as its own AC7 evidence artifact rather than growing E9's fixture.
 */

const LEARNING_TABLES = ["lessons", "selector_memory", "interstitial_catalog", "heal_outcomes"];

main(async (h) => {
  const dir = tempDir("podium-studio-learning-store-");
  try {
    // ── Basic CRUD round-trip for all 4 tables ────────────────────────────────────────────
    {
      const store = new PrimaryStore(`${dir}/crud.sqlite`, `${dir}/crud-backups`);
      store.open();

      const lessonId = await store.insertLesson({
        screenFingerprint: "home-v1",
        errorClass: "element_not_found",
        stepIntent: "tap Login button",
        healType: "locator",
        rung: 1,
        recovery: { kind: "text", value: "Log In" },
        topLabels: ["Home", "Log In", "Sign Up"],
      });
      h.ok("lesson-id-returned", lessonId);
      const lesson = store.getLesson(lessonId);
      h.equal("lesson-starts-unpinned", lesson?.pinned, false);
      h.equal("lesson-recovery-roundtrips", lesson?.recovery, { kind: "text", value: "Log In" });
      h.equal("lesson-top-labels-roundtrip", lesson?.topLabels, ["Home", "Log In", "Sign Up"]);

      await store.pinLesson(lessonId);
      h.equal("lesson-pinned-after-pinLesson", store.getLesson(lessonId)?.pinned, true);

      const found = store.findLessons("home-v1", "element_not_found", { pinnedOnly: true });
      h.equal("findLessons-pinnedOnly-finds-it", found.length, 1);
      h.equal("findLessons-pinnedOnly-excludes-unpinned", store.findLessons("home-v1", "unexpected_screen", { pinnedOnly: true }).length, 0);

      await store.rememberSelector({ screenFingerprint: "home-v1", elementKey: "Login button", locatorKind: "text", locatorValue: "Log In" });
      await store.rememberSelector({ screenFingerprint: "home-v1", elementKey: "Login button", locatorKind: "text", locatorValue: "Log In" });
      const mem = store.findSelectorMemory("home-v1", "Login button");
      h.equal("selector-memory-idempotent-increments", mem.length, 1);
      h.equal("selector-memory-times-resolved", mem[0]?.timesResolved, 2);

      await store.rememberInterstitial({ fingerprint: "daily-bonus-popup", label: "Daily Bonus", dismissAction: { kind: "tapText", text: "Not Now" } });
      const popup = store.findInterstitial("daily-bonus-popup");
      h.equal("interstitial-found", popup?.label, "Daily Bonus");
      h.equal("interstitial-dismiss-action-roundtrips", popup?.dismissAction, { kind: "tapText", text: "Not Now" });
      await store.rememberInterstitial({ fingerprint: "daily-bonus-popup", label: "Daily Bonus", dismissAction: { kind: "tapText", text: "Not Now" } });
      h.equal("interstitial-times-seen-increments", store.findInterstitial("daily-bonus-popup")?.timesSeen, 2);

      await store.recordHealOutcome("home-v1", "element_not_found", 1, "re-resolve-by-text", true);
      await store.recordHealOutcome("home-v1", "element_not_found", 1, "re-resolve-by-text", true);
      await store.recordHealOutcome("home-v1", "element_not_found", 2, "dismiss-known-popup", false);
      const best = store.findBestHealOutcome("home-v1", "element_not_found");
      h.equal("heal-outcome-ranks-net-positive-first", best?.strategy, "re-resolve-by-text");
      h.equal("heal-outcome-no-net-positive-returns-undefined", store.findBestHealOutcome("home-v1", "unexpected_screen"), undefined);

      store.close();
    }

    // ── AC7: backup -> corrupt -> restore -> identical row counts + checksum, all 4 tables ──
    {
      const dbPath = `${dir}/ac7.sqlite`;
      const backupsDir = `${dir}/ac7-backups`;
      const store = new PrimaryStore(dbPath, backupsDir);
      store.open();

      for (let i = 0; i < 5; i++) {
        const id = await store.insertLesson({
          screenFingerprint: `screen-${i}`,
          errorClass: "transient",
          stepIntent: `step ${i}`,
          healType: "locator",
          topLabels: [`label-${i}`],
        });
        if (i % 2 === 0) await store.pinLesson(id);
        await store.rememberSelector({ screenFingerprint: `screen-${i}`, elementKey: `el-${i}`, locatorKind: "text", locatorValue: `v-${i}` });
        await store.rememberInterstitial({ fingerprint: `popup-${i}`, label: `Popup ${i}`, dismissAction: { kind: "tapText", text: "OK" } });
        await store.recordHealOutcome(`screen-${i}`, "transient", 1, "retry", true);
      }

      const beforeCounts = rowCounts(store.raw, LEARNING_TABLES);
      const beforeChecksum = contentChecksum(store.raw, LEARNING_TABLES);
      h.equal("ac7-seeded-5-lessons", beforeCounts.lessons, 5);
      h.equal("ac7-seeded-5-selector-memory", beforeCounts.selector_memory, 5);
      h.equal("ac7-seeded-5-interstitials", beforeCounts.interstitial_catalog, 5);
      h.equal("ac7-seeded-5-heal-outcomes", beforeCounts.heal_outcomes, 5);

      const backupPath = await store.backup();
      h.ok("ac7-backup-file-exists", existsSync(backupPath));

      writeFileSync(dbPath, Buffer.from("not a sqlite file at all — corrupt on purpose"));
      await store.restore(backupPath);

      const afterCounts = rowCounts(store.raw, LEARNING_TABLES);
      const afterChecksum = contentChecksum(store.raw, LEARNING_TABLES);
      h.equal("ac7-row-counts-identical", afterCounts, beforeCounts);
      h.equal("ac7-checksum-matches", afterChecksum, beforeChecksum);
      h.equal("ac7-pinned-flag-survived-restore", store.findLessons("screen-0", "transient", { pinnedOnly: true }).length, 1);
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
