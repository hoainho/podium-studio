import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tiny in-process assertion harness for fixture scripts (see ../child-runner.ts for why these
 * exist as separate child-process scripts). Each fixture accumulates named pass/fail checks and
 * prints them as one JSON line at the end — the parent vitest process parses that line and
 * turns each check into a real, individually-visible assertion.
 */
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export class Harness {
  checks: Check[] = [];

  check(name: string, pass: boolean, detail?: string): void {
    this.checks.push({ name, pass, detail });
  }

  equal(name: string, actual: unknown, expected: unknown): void {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    this.check(name, pass, pass ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  ok(name: string, value: unknown, detail?: string): void {
    this.check(name, !!value, detail ?? `expected a truthy value, got ${JSON.stringify(value)}`);
  }

  throws(name: string, fn: () => void, matcher?: (message: string) => boolean): void {
    try {
      fn();
      this.check(name, false, "expected to throw, but it did not");
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const pass = matcher ? matcher(message) : true;
      this.check(name, pass, pass ? undefined : `threw, but matcher rejected the message: ${message}`);
    }
  }

  async throwsAsync(name: string, fn: () => Promise<void>, matcher?: (message: string) => boolean): Promise<void> {
    try {
      await fn();
      this.check(name, false, "expected to throw, but it did not");
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const pass = matcher ? matcher(message) : true;
      this.check(name, pass, pass ? undefined : `threw, but matcher rejected the message: ${message}`);
    }
  }

  report(error?: string): void {
    console.log(JSON.stringify({ checks: this.checks, error }));
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Standard fixture entry point: run `fn`, always print the harness report (even on a thrown
 * error, so the parent process always gets a parseable JSON line instead of a bare stack trace). */
export async function main(fn: (h: Harness) => Promise<void> | void): Promise<void> {
  const h = new Harness();
  try {
    await fn(h);
    h.report();
  } catch (err: any) {
    h.report(err?.message ?? String(err));
  }
}
