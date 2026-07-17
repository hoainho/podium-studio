/**
 * A single write-serializer, in-process half of E9 AC5 ("N parallel run workers + 1 headless
 * CLI process + the app writing concurrently ... zero SQLITE_BUSY"). `node:sqlite`'s
 * `DatabaseSync` is synchronous, so within ONE process there is no true parallelism to race —
 * but concurrent async callers (e.g. two overlapping HTTP requests in bridge/server.ts) could
 * still interleave a multi-statement write sequence if either awaited between statements. This
 * serializer removes that risk by funneling every write through one FIFO queue per store, so
 * two logical writes from the same process can never interleave.
 *
 * The OTHER half of AC5 — serializing across separate OS processes/connections, which this
 * in-process queue cannot do anything about — is WAL mode + a generous busy-timeout (see
 * constants.ts), which is what actually resolves SQLITE_BUSY when N independent connections
 * (workers/CLI/app) contend for the same file.
 */
export function createSerializer() {
  let tail: Promise<unknown> = Promise.resolve();

  return function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn); // run after the previous task settles, regardless of outcome
    tail = run.then(
      () => undefined,
      () => undefined, // never let one rejected task break the chain for tasks queued after it
    );
    return run;
  };
}

export type WithLock = ReturnType<typeof createSerializer>;
