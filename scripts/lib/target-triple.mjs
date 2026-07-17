// Shared Rust target-triple lookup for Tauri's `externalBin` naming convention
// ("<name>-<target-triple>"). Extracted out of scripts/build-bridge-sidecar.mjs when task #21
// (dedupe packaged Node runtime) made scripts/vendor-node-runtime.mjs need the SAME lookup — the
// vendored plain node binary now IS the sidecar Tauri spawns, so it has to be named exactly like
// the old SEA-injected one used to be.
//
// Only macOS is the R2 packaging target (per E8's own scope note); Windows/Linux triples can be
// added here once those platforms are actually gated.
const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

export function currentTargetTriple() {
  const key = `${process.platform}-${process.arch}`;
  const triple = TARGET_TRIPLES[key];
  if (!triple) {
    throw new Error(`No known Rust target triple for ${key} — add one to TARGET_TRIPLES in scripts/lib/target-triple.mjs.`);
  }
  return triple;
}
