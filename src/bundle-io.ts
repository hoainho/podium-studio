import { validateFlow, type Flow } from "../shared/ir.ts";
import { serializeBundle, type FlowBundle } from "../shared/bundle.ts";

/**
 * bundle-io.ts — the browser-only half of E21's flow bundles: everything shared/bundle.ts and
 * shared/flow-diff.ts deliberately stay free of (DOM APIs, localStorage, file I/O). Keeps the
 * "pure logic in shared/, environment glue in src/" split this codebase already uses elsewhere
 * (shared/subflow.ts's expandFlow vs. src/prepare-run.ts's browser-side composition).
 */

const BASELINE_KEY_PREFIX = "podium.bundleBaseline.";

/**
 * Stash `flow`'s content as the local "last-known-shared-version" baseline for `file` — the
 * common ancestor a genuine 3-way merge needs (shared/flow-diff.ts's `diffFlows`). Call this
 * whenever a flow is freshly LOADED from disk or freshly SAVED (App.tsx's `handleLoadFlow`/
 * `handleSave`) — both are moments where "this is now the version of record" is true, before any
 * further in-editor edits happen. Never throws — a full/unavailable localStorage degrades to "no
 * baseline for this flow," which shared/flow-diff.ts already handles safely (conservative 2-way
 * fallback), not a hard failure.
 */
export function stashBaseline(file: string, flow: Flow): void {
  try {
    window.localStorage.setItem(BASELINE_KEY_PREFIX + file, JSON.stringify(flow));
  } catch {
    // Quota exceeded / localStorage disabled — silently degrade to "no baseline," never throw
    // over what is purely a merge-quality optimization, not a correctness requirement.
  }
}

/** The last baseline stashed for `file`, or undefined if none was ever stashed (or it no longer
 * parses/validates — a corrupted stash degrades the SAME way a missing one does). */
export function getBaseline(file: string): Flow | undefined {
  try {
    const raw = window.localStorage.getItem(BASELINE_KEY_PREFIX + file);
    if (!raw) return undefined;
    const result = validateFlow(JSON.parse(raw));
    return result.ok ? result.flow : undefined;
  } catch {
    return undefined;
  }
}

/** Trigger a browser download of arbitrary bytes as a single file — the standard Blob +
 * object-URL + synthetic-click pattern (no server round-trip needed; nothing here touches
 * bridge/). Shared by `downloadBundle` below (E21) and E22's bug-export zip. */
export function downloadBytes(bytes: Uint8Array | string, filename: string, mimeType: string): void {
  // `as BlobPart` — TS's DOM lib is stricter about Uint8Array's backing buffer type
  // (ArrayBuffer vs. the broader ArrayBufferLike) than the Blob constructor actually is at
  // runtime; every real browser accepts any Uint8Array here regardless of its buffer subtype.
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay rather than immediately — some browsers cancel an in-flight download if
  // the object URL is revoked synchronously right after the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Trigger a browser download of `bundle` as a single shareable file — the export half of AC1
 * ("each exports a flow bundle"). */
export function downloadBundle(bundle: FlowBundle, filenameHint: string): void {
  downloadBytes(
    serializeBundle(bundle),
    filenameHint.endsWith(".bundle.json") ? filenameHint : `${filenameHint}.bundle.json`,
    "application/json",
  );
}

/** Read a QA-picked bundle file as text — the import half of AC1 ("importing QA-B's bundle"). */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Không đọc được tệp."));
    reader.readAsText(file);
  });
}
