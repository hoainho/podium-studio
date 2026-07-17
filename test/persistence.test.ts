import { describe, it, expect, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { saveFlow, loadFlow, FLOWS_DIR } from "../bridge/flows-store.ts";
import type { Flow } from "../shared/ir.ts";

const FLOW_NAME = "Persistence Test Temp";
const SAVED_FILE = "persistence-test-temp.flow.json";

function makeValidFlow(): Flow {
  return {
    schemaVersion: 1,
    name: FLOW_NAME,
    app: { bundleId: "com.example.persistence", platform: "ios-sim" },
    steps: [
      { id: "s1", action: "waitMs", ms: 100 },
      { id: "s2", action: "screenshot" },
    ],
  };
}

describe("flows-store persistence", () => {
  afterAll(async () => {
    await rm(join(FLOWS_DIR, SAVED_FILE), { force: true });
  });

  it("round-trips a valid flow through saveFlow -> loadFlow", async () => {
    const flow = makeValidFlow();
    const { file, flow: saved } = await saveFlow(flow);

    expect(file).toBe(SAVED_FILE);
    expect(saved).toEqual(flow);

    const loaded = await loadFlow(file);
    expect(loaded).toEqual(flow);
  });

  it("rejects an invalid flow (missing steps) by throwing", async () => {
    const invalidFlow = {
      schemaVersion: 1,
      name: "Invalid Persistence Test",
      app: { bundleId: "com.example.invalid", platform: "ios-sim" },
      // steps intentionally omitted
    };

    await expect(saveFlow(invalidFlow)).rejects.toThrow();
  });
});
