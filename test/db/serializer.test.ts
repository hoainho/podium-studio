import { describe, it, expect } from "vitest";
import { createSerializer } from "../../bridge/db/serializer.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createSerializer — in-process write-serializer (E9 AC5, in-process half)", () => {
  it("runs queued tasks strictly one at a time, in submission order, even when later tasks are faster", async () => {
    const withLock = createSerializer();
    const order: number[] = [];

    const tasks = [
      withLock(async () => {
        order.push(1);
        await delay(30); // slowest — submitted first, must still finish first
        order.push(-1);
      }),
      withLock(async () => {
        order.push(2);
        await delay(5);
        order.push(-2);
      }),
      withLock(async () => {
        order.push(3);
        order.push(-3);
      }),
    ];
    await Promise.all(tasks);

    // If tasks genuinely ran one-at-a-time (never interleaved), each task's start (+N) is
    // immediately followed by its own end (-N) before the next task's start appears.
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("a rejected task does not break the chain — later queued tasks still run", async () => {
    const withLock = createSerializer();
    const results: string[] = [];

    const p1 = withLock(() => {
      throw new Error("boom");
    }).catch(() => {
      results.push("caught-1");
    });
    const p2 = withLock(() => {
      results.push("ran-2");
    });

    await Promise.all([p1, p2]);
    expect(results).toEqual(["caught-1", "ran-2"]);
  });

  it("returns/propagates each task's own result independently", async () => {
    const withLock = createSerializer();
    const [a, b] = await Promise.all([withLock(() => 1), withLock(() => 2)]);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
