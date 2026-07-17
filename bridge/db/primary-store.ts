import { chmodSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { RunSummary } from "../../shared/protocol.ts";
import type {
  FailureClass,
  HealOutcome,
  HealRung,
  InterstitialEntry,
  Lesson,
  LocatorKind,
  SelectorMemoryEntry,
} from "../../shared/selfheal-types.ts";
import type { AiCallLogEntry, AiRole, ProviderConfig, ProviderRegistryConfig } from "../../shared/ai-types.ts";
import { BACKUPS_DIR, BACKUP_RETENTION_COUNT, BUSY_TIMEOUT_MS } from "./constants.ts";
import { createSerializer, type WithLock } from "./serializer.ts";
import { getSchemaVersion, PRIMARY_MIGRATIONS, runMigrations } from "./schema.ts";

/**
 * Tier 2 — the primary store (E9). Run history, JUnit-shaped per-step results, the artifacts
 * index, and a learning-store schema placeholder — NOT derivable from the canonical JSON flows
 * (that's the derived cache's job, see derived-cache.ts). Losing this file is real data loss
 * unless a backup exists (AC2), which is exactly what distinguishes it from the cache.
 */
export class PrimaryStoreCorruptedError extends Error {
  constructor(path: string, cause?: string) {
    super(
      `Primary store at "${path}" is corrupted or unreadable${cause ? `: ${cause}` : ""} and no ` +
        `usable backup was found. This IS real data loss (E9 AC2/AC6) — restore from an external ` +
        `backup if one exists outside ${dirname(path)}.`,
    );
    this.name = "PrimaryStoreCorruptedError";
  }
}

function pragmaSetup(db: DatabaseSync): void {
  // WAL + a generous busy-timeout is the cross-process half of AC5's "zero SQLITE_BUSY" —
  // readers never block the writer and vice versa, and a connection that DOES find the file
  // locked waits up to BUSY_TIMEOUT_MS instead of failing immediately.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/**
 * `PRAGMA integrity_check` — the FULL check, not `quick_check` (E9 review-fix, MAJOR: "auto-
 * restore false-positive clobber"). `quick_check` is cheaper but, being a lighter check, is more
 * prone to a transient false read under contention — and a false positive HERE triggers a
 * DESTRUCTIVE overwrite from backup (see `quarantineBeforeRestore` below for the second half of
 * this fix). `open()` only pays this cost once per process start, not on a hot path, so the
 * extra thoroughness is the right trade for a check that gates a destructive action.
 */
function integrityCheckOk(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    return rows.length === 1 && String(Object.values(rows[0])[0]).toLowerCase() === "ok";
  } catch {
    return false;
  }
}

/** chmod 0600 (owner read/write only) — the primary store holds real run history + artifacts
 * index, sensitive-at-rest (E9 review-fix, security MAJOR: "S3"). Best-effort: unsupported on
 * some platforms/filesystems (e.g. exotic mounts), and must never block open()/backup(). */
function chmodOwnerOnly(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort — never let a permissions quirk block DB access */
  }
}

/** Blocking sleep (node:sqlite's API is fully synchronous, so an async `setTimeout` wouldn't
 * actually pause the retry loop between attempts). Only ever called with small (tens of ms)
 * delays inside `tryOpenWithRetries`. */
function sleepSyncMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function removeWalSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Preserve a copy of the CURRENT on-disk file before a destructive backup-restore overwrites it
 * (E9 review-fix, MAJOR: "auto-restore false-positive clobber"). `open()`'s corruption check
 * (`integrity_check` via `tryOpenWithRetries`) cannot perfectly distinguish "genuinely corrupted"
 * from "transiently unable to open" (e.g. lock contention outlasting the retry budget under
 * heavy concurrent load) — a false positive there used to trigger `restoreFromLatestBackupSync()`
 * unconditionally, silently discarding every write since the last backup even though the live
 * file may have been completely fine. Quarantining first means a false-positive auto-restore can
 * never be a PERMANENT loss: the pre-restore bytes are always recoverable from
 * `<backupsDir>/quarantine/` afterward. Best-effort (never throws, never blocks recovery) — a
 * quarantine failure must not prevent the restore it exists to make safe.
 */
function quarantineBeforeRestore(path: string, backupsDir: string): void {
  if (!existsSync(path)) return; // nothing to preserve (e.g. a brand-new file that never opened)
  try {
    const quarantineDir = join(backupsDir, "quarantine");
    mkdirSync(quarantineDir, { recursive: true });
    const dest = join(quarantineDir, `${basename(path)}.${Date.now()}.pre-restore`);
    copyFileSync(path, dest);
    chmodOwnerOnly(dest); // same sensitive data as the live file (S3)
  } catch {
    /* best-effort — never let quarantine itself block the recovery it's meant to make safe */
  }
}

export class PrimaryStore {
  readonly path: string;
  private readonly backupsDir: string;
  private db!: DatabaseSync;
  private readonly lock: WithLock = createSerializer();
  /** Set by open()/restore() when recovery from a backup actually happened — surfaced so a
   * caller (bridge/server.ts) can tell the user rather than silently continuing (AC6). */
  recoveredFromBackup = false;

  constructor(path: string, backupsDir: string = BACKUPS_DIR) {
    this.path = path;
    this.backupsDir = backupsDir;
  }

  /**
   * Open (creating the file/dir if needed), detect corruption via a full integrity_check,
   * attempt recovery from the latest backup if corrupted, then run pending migrations. Throws
   * `PrimaryStoreCorruptedError` only when corrupted AND no backup can recover it — the one case
   * where the caller must be told plainly rather than the process crashing on a raw SQLite error
   * somewhere downstream (AC6: "no silent data loss, no unhandled crash").
   */
  open(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.recoveredFromBackup = false;

    let db = this.tryOpenWithRetries();
    if (!db) {
      // Never overwrite the current file for a restore without preserving it first — the
      // corruption check above cannot tell "genuinely corrupted" apart from "transiently
      // unopenable" (E9 review-fix: "auto-restore false-positive clobber").
      quarantineBeforeRestore(this.path, this.backupsDir);
      const restored = this.restoreFromLatestBackupSync();
      if (restored) {
        db = this.tryOpenWithRetries();
        this.recoveredFromBackup = !!db;
      }
      if (!db) throw new PrimaryStoreCorruptedError(this.path);
    }
    this.db = db;
    chmodOwnerOnly(this.path); // sensitive-at-rest (E9 review-fix, security MAJOR S3)
    runMigrations(this.db, PRIMARY_MIGRATIONS);
  }

  /**
   * A handful of quick retries before concluding "corrupted" — guards against a narrow,
   * transient race observed under real multi-process stress testing (E9 AC5's concurrency
   * test): when several independent processes race to open/create the SAME brand-new file for
   * the very first time, one connection's `integrity_check` can transiently see the file mid-
   * initialization by another connection. A genuinely corrupted file fails every retry and still
   * correctly falls through to backup recovery / `PrimaryStoreCorruptedError` — this only
   * smooths over a narrow first-open race, it never masks real corruption (in production, the
   * file is normally created once by the bridge server at startup, before any concurrent
   * worker/CLI process ever attaches — see bridge/server.ts's openStores() — so this race is a
   * cold-start-only edge case, not a steady-state one).
   */
  private tryOpenWithRetries(attempts = 5, delayMs = 20): DatabaseSync | undefined {
    for (let i = 0; i < attempts; i++) {
      const db = this.tryOpen();
      if (db) return db;
      if (i < attempts - 1) sleepSyncMs(delayMs);
    }
    return undefined;
  }

  private tryOpen(): DatabaseSync | undefined {
    try {
      const db = new DatabaseSync(this.path);
      pragmaSetup(db);
      if (!integrityCheckOk(db)) {
        db.close();
        return undefined;
      }
      return db;
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.db?.isOpen) this.db.close();
  }

  get schemaVersion(): number {
    return getSchemaVersion(this.db);
  }

  /** Escape hatch for tests/tools that need the raw connection (e.g. checksum/rowCounts
   * helpers). Never used by this class's own write paths, which all go through `lock`. */
  get raw(): DatabaseSync {
    return this.db;
  }

  // ── Writes — every one routed through the serializer (E9 AC5's in-process half) ─────────────

  insertRun(summary: RunSummary): Promise<void> {
    return this.lock(() => {
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(
            `INSERT INTO runs (run_id, flow_name, udid, bundle_id, passed, status, total, passed_count,
               failed_count, soft_failed_count, duration_ms, started_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            summary.runId, summary.flowName, summary.udid, summary.bundleId,
            summary.passed ? 1 : 0, summary.status, summary.total, summary.passedCount,
            summary.failedCount, summary.softFailedCount, summary.durationMs, summary.startedAt,
            Date.now(),
          );
        const insertResult = this.db.prepare(
          `INSERT INTO run_results (run_id, step_index, step_id, action, status, ok, detail, error,
             backend, screenshot, started_at, finished_at, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of summary.results) {
          insertResult.run(
            summary.runId, r.index, r.stepId, r.action, r.status, r.ok ? 1 : 0,
            r.detail ?? null, r.error ?? null, r.backend ?? null, r.screenshot ?? null,
            r.startedAt ?? null, r.finishedAt ?? null, r.attempts ?? null,
          );
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  insertArtifact(row: { path: string; runId: string; kind: string; sizeBytes: number; createdAt: number }): Promise<void> {
    return this.lock(() => {
      this.db
        .prepare(
          `INSERT INTO artifacts_index (path, run_id, kind, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET size_bytes = excluded.size_bytes`,
        )
        .run(row.path, row.runId, row.kind, row.sizeBytes, row.createdAt);
    });
  }

  deleteArtifact(path: string): Promise<void> {
    return this.lock(() => {
      this.db.prepare("DELETE FROM artifacts_index WHERE path = ?").run(path);
    });
  }

  // ── E19 learning store — lessons, selector memory, interstitial catalog, heal outcomes ────────
  // Same locked-write / unlocked-read split as the run-history methods above; all four tables
  // live in this SAME primary-store file, so backup()/restore() above cover them automatically
  // (a raw SQLite file-level copy — no per-table special-casing needed for AC7).

  /** Record one failure (Pillar 9 §3). Always inserted as UNPINNED (`pinned: false` by default) —
   * pinning is always a separate, explicit human action (`pinLesson`), never implicit at insert
   * time, so a freshly-recorded heal can never accidentally become Strict-replayable (AC6). */
  insertLesson(lesson: Omit<Lesson, "id" | "createdAt" | "pinned"> & { pinned?: boolean }): Promise<string> {
    const id = randomUUID();
    const createdAt = Date.now();
    return this.lock(() => {
      this.db
        .prepare(
          `INSERT INTO lessons (id, screen_fingerprint, error_class, step_intent, heal_type, rung,
             recovery_json, top_labels_json, screenshot_path, app_version, flow_id, pinned, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, lesson.screenFingerprint, lesson.errorClass, lesson.stepIntent, lesson.healType,
          lesson.rung ?? null, lesson.recovery ? JSON.stringify(lesson.recovery) : null,
          JSON.stringify(lesson.topLabels), lesson.screenshotPath ?? null, lesson.appVersion ?? null,
          lesson.flowId ?? null, lesson.pinned ? 1 : 0, createdAt,
        );
      return id;
    });
  }

  /** The ONLY way a lesson becomes eligible for rung 1–3 replay (spec AC2/AC6: "save this fix?"
   * is always an explicit, separate human action — nothing here auto-pins). */
  pinLesson(id: string): Promise<void> {
    return this.lock(() => {
      this.db.prepare("UPDATE lessons SET pinned = 1 WHERE id = ?").run(id);
    });
  }

  getLesson(id: string): Lesson | undefined {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToLesson(row) : undefined;
  }

  /** Candidate lessons for rung 1–3, keyed by (screen, error-class) — the exact lookup Pillar 9
   * §2's rung 3 needs. `pinnedOnly` is how the caller enforces AC6 (Strict mode, and — per this
   * epic's own scope — every mode right now, since "replay not-yet-pinned lessons" is deferred
   * to E24): pass `true` to see only lessons a human has explicitly approved. */
  findLessons(screenFingerprint: string, errorClass: FailureClass, opts: { pinnedOnly?: boolean } = {}): Lesson[] {
    const sql = opts.pinnedOnly
      ? "SELECT * FROM lessons WHERE screen_fingerprint = ? AND error_class = ? AND pinned = 1 ORDER BY created_at DESC"
      : "SELECT * FROM lessons WHERE screen_fingerprint = ? AND error_class = ? ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(screenFingerprint, errorClass) as Record<string, unknown>[];
    return rows.map(rowToLesson);
  }

  /** Remember one stable locator for one element on one screen (rung 1's source). Idempotent:
   * re-observing the SAME (screen, element, locator kind+value) increments `times_resolved`
   * rather than inserting a duplicate row — that counter is what ranks candidates in
   * `findSelectorMemory` (most-reliably-resolved first). */
  rememberSelector(entry: Omit<SelectorMemoryEntry, "id" | "timesResolved" | "lastResolvedAt">): Promise<void> {
    return this.lock(() => {
      const now = Date.now();
      const existing = this.db
        .prepare(
          "SELECT id FROM selector_memory WHERE screen_fingerprint = ? AND element_key = ? AND locator_kind = ? AND locator_value = ?",
        )
        .get(entry.screenFingerprint, entry.elementKey, entry.locatorKind, entry.locatorValue) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare("UPDATE selector_memory SET times_resolved = times_resolved + 1, last_resolved_at = ? WHERE id = ?")
          .run(now, existing.id);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO selector_memory (id, screen_fingerprint, element_key, locator_kind, locator_value,
             times_resolved, last_resolved_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(randomUUID(), entry.screenFingerprint, entry.elementKey, entry.locatorKind, entry.locatorValue, now, now);
    });
  }

  /** Every remembered locator for one element on one screen, most-reliable (highest
   * `timesResolved`) first — rung 1's candidate list, ready to be scored/tried in order. */
  findSelectorMemory(screenFingerprint: string, elementKey: string): SelectorMemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM selector_memory WHERE screen_fingerprint = ? AND element_key = ? ORDER BY times_resolved DESC",
      )
      .all(screenFingerprint, elementKey) as Record<string, unknown>[];
    return rows.map(rowToSelectorMemory);
  }

  /** Remember (or refresh) a known interstitial + its working dismiss action (rung 2's source).
   * Idempotent on `fingerprint` (UNIQUE): re-seeing the same popup increments `times_seen`. */
  rememberInterstitial(entry: Omit<InterstitialEntry, "id" | "timesSeen" | "lastSeenAt">): Promise<void> {
    return this.lock(() => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO interstitial_catalog (id, fingerprint, label, dismiss_action_json, times_seen, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(fingerprint) DO UPDATE SET
             times_seen = times_seen + 1, last_seen_at = excluded.last_seen_at,
             dismiss_action_json = excluded.dismiss_action_json, label = excluded.label`,
        )
        .run(randomUUID(), entry.fingerprint, entry.label, JSON.stringify(entry.dismissAction), now, now);
    });
  }

  /** The known dismiss for a screen fingerprint, if this popup has been seen before (rung 2). */
  findInterstitial(fingerprint: string): InterstitialEntry | undefined {
    const row = this.db.prepare("SELECT * FROM interstitial_catalog WHERE fingerprint = ?").get(fingerprint) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToInterstitial(row) : undefined;
  }

  /** Record whether a given (screen, error-class, rung, strategy) attempt succeeded — the running
   * tally rung 3 uses to rank "which known recovery is most likely to work here" (Pillar 9 §3's
   * "heal outcomes"). Idempotent-additive: the SAME (screen, error-class, rung, strategy) keeps
   * accumulating counts across runs rather than creating a new row each time. */
  recordHealOutcome(screenFingerprint: string, errorClass: FailureClass, rung: HealRung, strategy: string, success: boolean): Promise<void> {
    return this.lock(() => {
      const now = Date.now();
      const existing = this.db
        .prepare(
          "SELECT id FROM heal_outcomes WHERE screen_fingerprint = ? AND error_class = ? AND rung = ? AND strategy = ?",
        )
        .get(screenFingerprint, errorClass, rung, strategy) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE heal_outcomes SET ${success ? "success_count = success_count + 1" : "failure_count = failure_count + 1"},
               last_used_at = ? WHERE id = ?`,
          )
          .run(now, existing.id);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO heal_outcomes (id, screen_fingerprint, error_class, rung, strategy, success_count,
             failure_count, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), screenFingerprint, errorClass, rung, strategy, success ? 1 : 0, success ? 0 : 1, now, now);
    });
  }

  /** The best-known recovery for a (screen, error-class) — highest net success (successes minus
   * failures), ties broken by most recent use — rung 3's "try the most-likely fix first". Returns
   * undefined if this (screen, error-class) has never had a net-positive outcome recorded. */
  findBestHealOutcome(screenFingerprint: string, errorClass: FailureClass): HealOutcome | undefined {
    const rows = this.db
      .prepare("SELECT * FROM heal_outcomes WHERE screen_fingerprint = ? AND error_class = ?")
      .all(screenFingerprint, errorClass) as Record<string, unknown>[];
    const outcomes = rows.map(rowToHealOutcome).filter((o) => o.successCount > o.failureCount);
    if (outcomes.length === 0) return undefined;
    outcomes.sort((a, b) => (b.successCount - b.failureCount) - (a.successCount - a.failureCount) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return outcomes[0];
  }

  // ── E24 AI provider registry + call log ──────────────────────────────────────────────────────
  // Same file, same locked-write / unlocked-read split, same backup()/restore() coverage as the
  // E19 tables above — no per-feature special-casing needed for AC7-equivalent durability.

  /** The WHOLE registry (providers + routing) read together — AC5's validation always needs both
   * at once, so there is no "get just the providers" read that could see a transiently
   * inconsistent routing config. */
  getProviderRegistry(): ProviderRegistryConfig {
    const providerRows = this.db.prepare("SELECT * FROM ai_providers ORDER BY created_at ASC").all() as Record<string, unknown>[];
    const providers = providerRows.map(rowToProviderConfig);
    const routingRows = this.db.prepare("SELECT * FROM ai_routing").all() as Record<string, unknown>[];
    const routing = { authoring: [] as string[], recovery: [] as string[] };
    for (const row of routingRows) {
      const role = String(row.role);
      if (role === "authoring" || role === "recovery") {
        routing[role] = JSON.parse(String(row.provider_ids_json));
      }
    }
    return { providers, routing };
  }

  /** Replace the WHOLE registry atomically. The CALLER (bridge/server.ts's POST /api/ai/providers
   * handler) must run `validateProviderRegistry(config)` (bridge/ai-registry.ts, AC5) on this
   * exact config BEFORE calling this — never persisted here unvalidated, and this method itself
   * does not re-validate, keeping "the one gate" a single call site rather than two that could
   * drift apart. */
  saveProviderRegistry(config: ProviderRegistryConfig): Promise<void> {
    return this.lock(() => {
      const now = Date.now();
      this.db.exec("DELETE FROM ai_providers");
      this.db.exec("DELETE FROM ai_routing");
      const insertProvider = this.db.prepare(
        `INSERT INTO ai_providers (id, name, kind, base_url, model, command, args_json, api_key_ref, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of config.providers) {
        insertProvider.run(
          p.id,
          p.name,
          p.kind,
          p.kind === "openai-compatible" ? p.baseUrl : null,
          p.kind === "openai-compatible" ? p.model : null,
          p.kind === "agent-cli" ? p.command : null,
          p.kind === "agent-cli" && p.args ? JSON.stringify(p.args) : null,
          p.apiKeyRef ?? null,
          p.enabled ? 1 : 0,
          now,
        );
      }
      const insertRouting = this.db.prepare("INSERT INTO ai_routing (role, provider_ids_json) VALUES (?, ?)");
      insertRouting.run("authoring", JSON.stringify(config.routing.authoring));
      insertRouting.run("recovery", JSON.stringify(config.routing.recovery));
    });
  }

  /** Log one AI call, HEALED OR NOT (AC3: "every rung-4 heal is logged locally") — a call that
   * never even produced a legal action still needs an audit trail entry (what was asked, what
   * came back, why it was refused). Never gated on approval — approval only governs whether the
   * corresponding heal PERSISTS to the learning store/flow file, never whether it's logged. */
  insertAiCallLog(entry: Omit<AiCallLogEntry, "id" | "createdAt">): Promise<string> {
    const id = randomUUID();
    const createdAt = Date.now();
    return this.lock(() => {
      this.db
        .prepare(
          `INSERT INTO ai_call_log (id, role, provider_id, prompt, response, tokens_used, cost_usd, latency_ms, screen_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, entry.role, entry.providerId, entry.prompt, entry.response,
          entry.tokensUsed ?? null, entry.costUsd ?? null, entry.latencyMs,
          entry.screenFingerprint ?? null, createdAt,
        );
      return id;
    });
  }

  listAiCallLog(limit = 100): AiCallLogEntry[] {
    const rows = this.db.prepare("SELECT * FROM ai_call_log ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(rowToAiCallLogEntry);
  }

  /** The "opt-in + purgeable" half of AC9's sensitive-at-rest guardrail (the log can contain real
   * logged-in screen content) — deletes EVERY logged call, never a selective per-row purge; the
   * point is "I don't want this sitting around anymore," not curating which entries to keep. */
  purgeAiCallLog(): Promise<void> {
    return this.lock(() => {
      this.db.exec("DELETE FROM ai_call_log");
    });
  }

  // ── Reads — no lock needed; SQLite (esp. in WAL) handles concurrent reads fine ───────────────

  listRuns(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  getRun(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
  }

  countRuns(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM runs").get();
    return Number(row?.n ?? 0);
  }

  listArtifacts(): Array<{ path: string; runId: string; kind: string; sizeBytes: number; createdAt: number }> {
    const rows = this.db.prepare("SELECT * FROM artifacts_index ORDER BY created_at ASC").all();
    return rows.map((r) => ({
      path: String(r.path), runId: String(r.run_id), kind: String(r.kind),
      sizeBytes: Number(r.size_bytes), createdAt: Number(r.created_at),
    }));
  }

  // ── Backup / restore (E9 AC3) ────────────────────────────────────────────────────────────────

  async backup(): Promise<string> {
    mkdirSync(this.backupsDir, { recursive: true });
    const dest = join(this.backupsDir, `primary-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    await sqliteBackup(this.db, dest);
    chmodOwnerOnly(dest); // a backup holds the exact same sensitive data as the live file (S3)
    this.pruneOldBackups();
    return dest;
  }

  private pruneOldBackups(): void {
    if (!existsSync(this.backupsDir)) return;
    const files = readdirSync(this.backupsDir)
      .filter((f) => f.startsWith("primary-") && f.endsWith(".sqlite"))
      .map((f) => ({ f, mtime: statSync(join(this.backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(BACKUP_RETENTION_COUNT)) {
      try {
        rmSync(join(this.backupsDir, stale.f), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  listBackups(): string[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .filter((f) => f.startsWith("primary-") && f.endsWith(".sqlite"))
      .map((f) => join(this.backupsDir, f))
      .sort();
  }

  private restoreFromLatestBackupSync(): boolean {
    const backups = this.listBackups();
    if (backups.length === 0) return false;
    return this.restoreFromFileSync(backups[backups.length - 1]);
  }

  /** Overwrite the primary file in place from a specific backup. Closes any open handle first,
   * and drops stale WAL/SHM sidecars — a restored file must never be replayed against a WAL
   * journal that predates it. Leaves the store ready for the next open()/tryOpen(). */
  private restoreFromFileSync(backupPath: string): boolean {
    try {
      if (this.db?.isOpen) this.db.close();
    } catch {
      /* already closed */
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      copyFileSync(backupPath, this.path);
      removeWalSidecars(this.path);
      chmodOwnerOnly(this.path); // sensitive-at-rest, same as open() (S3)
      return true;
    } catch {
      return false;
    }
  }

  /** Public restore entry point: restore from a specific backup file, then reopen + re-migrate.
   * Throws if the given backup itself isn't a valid, readable database. */
  async restore(backupPath: string): Promise<void> {
    const ok = this.restoreFromFileSync(backupPath);
    if (!ok) throw new Error(`Could not restore from backup "${backupPath}"`);
    const db = this.tryOpen();
    if (!db) throw new PrimaryStoreCorruptedError(this.path, `backup file "${backupPath}" is itself invalid`);
    this.db = db;
    runMigrations(this.db, PRIMARY_MIGRATIONS);
    this.recoveredFromBackup = true;
  }
}

// ── Row -> typed-object mappers (E19 learning store) ────────────────────────────────────────────
// SQLite stores JSON-shaped fields (recovery/top-labels/dismiss-action) as TEXT columns — these
// mappers are the one place that (de)serializes them, so every read method above returns the
// same shared/selfheal-types.ts shapes rather than raw snake_case SQLite rows.

function rowToLesson(row: Record<string, unknown>): Lesson {
  return {
    id: String(row.id),
    screenFingerprint: String(row.screen_fingerprint),
    errorClass: row.error_class as FailureClass,
    stepIntent: String(row.step_intent),
    healType: row.heal_type as Lesson["healType"],
    rung: row.rung == null ? undefined : (Number(row.rung) as HealRung),
    recovery: row.recovery_json ? JSON.parse(String(row.recovery_json)) : undefined,
    topLabels: JSON.parse(String(row.top_labels_json)),
    screenshotPath: row.screenshot_path == null ? undefined : String(row.screenshot_path),
    appVersion: row.app_version == null ? undefined : String(row.app_version),
    flowId: row.flow_id == null ? undefined : String(row.flow_id),
    pinned: Number(row.pinned) === 1,
    createdAt: Number(row.created_at),
  };
}

function rowToSelectorMemory(row: Record<string, unknown>): SelectorMemoryEntry {
  return {
    id: String(row.id),
    screenFingerprint: String(row.screen_fingerprint),
    elementKey: String(row.element_key),
    locatorKind: row.locator_kind as LocatorKind,
    locatorValue: String(row.locator_value),
    timesResolved: Number(row.times_resolved),
    lastResolvedAt: row.last_resolved_at == null ? undefined : Number(row.last_resolved_at),
  };
}

function rowToInterstitial(row: Record<string, unknown>): InterstitialEntry {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    label: String(row.label),
    dismissAction: JSON.parse(String(row.dismiss_action_json)),
    timesSeen: Number(row.times_seen),
    lastSeenAt: row.last_seen_at == null ? undefined : Number(row.last_seen_at),
  };
}

function rowToHealOutcome(row: Record<string, unknown>): HealOutcome {
  return {
    id: String(row.id),
    screenFingerprint: String(row.screen_fingerprint),
    errorClass: row.error_class as FailureClass,
    rung: Number(row.rung) as HealRung,
    strategy: String(row.strategy),
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    lastUsedAt: row.last_used_at == null ? undefined : Number(row.last_used_at),
  };
}

// ── Row -> typed-object mappers (E24 AI provider registry + call log) ──────────────────────────

function rowToProviderConfig(row: Record<string, unknown>): ProviderConfig {
  const base = {
    id: String(row.id),
    name: String(row.name),
    apiKeyRef: row.api_key_ref == null ? undefined : String(row.api_key_ref),
    enabled: Number(row.enabled) === 1,
  };
  if (row.kind === "agent-cli") {
    return {
      ...base,
      kind: "agent-cli",
      command: String(row.command),
      args: row.args_json == null ? undefined : JSON.parse(String(row.args_json)),
    };
  }
  return {
    ...base,
    kind: "openai-compatible",
    baseUrl: String(row.base_url),
    model: String(row.model),
  };
}

function rowToAiCallLogEntry(row: Record<string, unknown>): AiCallLogEntry {
  return {
    id: String(row.id),
    role: row.role as AiRole,
    providerId: String(row.provider_id),
    prompt: String(row.prompt),
    response: String(row.response),
    tokensUsed: row.tokens_used == null ? undefined : Number(row.tokens_used),
    costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
    latencyMs: Number(row.latency_ms),
    screenFingerprint: row.screen_fingerprint == null ? undefined : String(row.screen_fingerprint),
    createdAt: Number(row.created_at),
  };
}
