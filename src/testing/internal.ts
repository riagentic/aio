// src/testing/internal.ts — the framework's OWN test seams (alpha70).
//
// NOT on the `exports` map, on purpose. Every symbol here is an internal of a
// build/tooling module that a test in `tests/` pins directly — a manifest
// printer, an artifact-name rule, an `adb devices` parser — and none of it is
// something an APP calls. Before alpha70 each one rode a public entry
// (`aio/build`, `aio/ship`, `aio/doctor`, …) so the tests could reach it, and
// the api snapshot carried them as if they were API: a public symbol with zero
// app-facing meaning is a promise the framework cannot keep.
//
// Tests import this file by relative path (`../src/testing/internal.ts`). The
// symbols keep their real homes; this is a directory, not a second home — one
// symbol has one implementation, and `@internal` on the source keeps it out of
// the snapshot. A symbol with a caller in `src/` (`defaultKeyPath`,
// `handleMessage`) is NOT here: it is wired, and stays where it is.

// `aio ship` internals (src/build/ship.ts).
export {
  gitWorkTreeOf, // aio-ok: test-only seam — the ship tests pin the git worktree rule
  notRunnableExit, // aio-ok: test-only seam — the ship tests pin the not-runnable exit rule
  publishInstructions, // aio-ok: test-only seam — the ship tests pin the publish text
} from "../build/ship.ts";

// Multi-target build placement rules (src/build-all.ts).
export {
  isArtifactName, // aio-ok: test-only seam — pure artifact-name rule
  placedName, // aio-ok: test-only seam — pure placement rule
  suffixedTargets, // aio-ok: test-only seam — pure suffix rule
  unsafeOutDir, // aio-ok: test-only seam — pure out-dir guard
} from "../build-all.ts";

// Least-privilege capability scanner internals (src/build/capabilities.ts).
export {
  manifestReport, // aio-ok: test-only seam — the doctor wires it from capabilities.ts directly
  permissionFlags, // aio-ok: test-only seam — ship.ts wires it from capabilities.ts directly
} from "../build/capabilities.ts";

// `aio doctor` internals (src/server/doctor.ts).
export { extractAioVersion } from "../server/doctor.ts"; // aio-ok: test-only seam — pin-spec parser

// `deno task install:android` internals (src/android-install.ts).
export { parseDevices } from "../android-install.ts"; // aio-ok: test-only seam — `adb devices -l` parser
