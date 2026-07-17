import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFlow, type Flow, type FlowParam } from "../shared/ir.ts";
import { workspaceRoot } from "./workspace.ts";

export const FLOWS_DIR = join(workspaceRoot(), "qa", "flows");

export interface FlowListEntry {
  file: string;
  name: string;
  steps: number;
  bundleId: string;
  tags: string[];
  /** This flow's own sub-flow call-parameter signature (E13) — empty array for an ordinary,
   * non-reusable flow, never omitted, so the gallery UI can list "callable as a sub-flow"
   * candidates (params.length > 0) without fetching every flow's full JSON first. */
  params: FlowParam[];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
}

async function ensureDir(): Promise<void> {
  await mkdir(FLOWS_DIR, { recursive: true });
}

export async function listFlows(): Promise<FlowListEntry[]> {
  await ensureDir();
  const files = (await readdir(FLOWS_DIR)).filter((f) => f.endsWith(".flow.json"));
  const out: FlowListEntry[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(FLOWS_DIR, file), "utf8"));
      const v = validateFlow(raw);
      if (v.ok && v.flow) {
        // E18: tags. E13: params (a flow's own sub-flow call signature) — both surfaced in the
        // lightweight listing too, so the UI can filter/browse without fetching every flow's
        // full JSON first.
        out.push({
          file, name: v.flow.name, steps: v.flow.steps.length, bundleId: v.flow.app.bundleId,
          tags: v.flow.tags ?? [], params: v.flow.params ?? [],
        });
      }
    } catch {
      // skip unreadable / invalid files in the listing
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadFlow(file: string): Promise<Flow> {
  await ensureDir();
  const safe = file.replace(/[^a-zA-Z0-9._-]/g, "");
  const raw = JSON.parse(await readFile(join(FLOWS_DIR, safe), "utf8"));
  const v = validateFlow(raw);
  if (!v.ok || !v.flow) throw new Error(`Invalid flow "${file}": ${v.errors.join("; ")}`);
  return v.flow;
}

export async function saveFlow(flow: unknown, fileName?: string): Promise<{ file: string; flow: Flow }> {
  await ensureDir();
  const v = validateFlow(flow);
  if (!v.ok || !v.flow) throw new Error(`Refusing to save invalid flow: ${v.errors.join("; ")}`);
  // QA audit AUTH-2: when the caller passes the file this flow was loaded from, write back to THAT
  // file (rename-in-place). Previously the filename was ALWAYS re-derived from `slug(name)`, so
  // renaming a flow created a brand-new file and left the original orphaned on disk under its old
  // name. Sanitize the supplied name exactly like `loadFlow` does, and only honor a real
  // `*.flow.json` name — otherwise (or for a brand-new flow) fall back to the slug-of-name.
  let file: string;
  const safe = fileName ? fileName.replace(/[^a-zA-Z0-9._-]/g, "") : "";
  if (safe.endsWith(".flow.json") && safe.length > ".flow.json".length) {
    file = safe;
  } else {
    file = `${slug(v.flow.name)}.flow.json`;
  }
  await writeFile(join(FLOWS_DIR, file), JSON.stringify(v.flow, null, 2) + "\n", "utf8");
  return { file, flow: v.flow };
}
