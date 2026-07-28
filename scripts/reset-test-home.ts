// Give the suite a FRESH app home, once per run.
//
// Tests spawn real apps, and a real app writes durable files to
// `appDirs(appId)` — `state.db`, the CRDT op-log, `launch.json`. The suite
// points that at `.aio-test-home`, which was never cleaned, so those files
// accumulated across runs while `appId` stayed the same.
//
// That is not untidiness, it is a wrong-answer machine: `e2e-sync-browser`
// asserted "exactly one op in the op-log", gained one row per run, and so
// passed exactly once on a virgin machine and was red forever after. On CI —
// always a fresh checkout — it stayed green. The failure was read as a flake
// for a long time and "fixed" with polling, which could not have helped.
//
// One reset removes the whole class: within a run tests still share the home
// (some deliberately hand state to each other), but no run inherits another's.
import { resolve } from "@std/path";

const target = resolve(Deno.env.get("AIO_APPS_DIR") ?? ".aio-test-home");

// Never delete anything that is not the thing we mean. AIO_APPS_DIR is read
// from the environment, and this script runs with write permission: an unset
// or mistyped variable must fail loudly, not erase a home directory.
if (!target.endsWith(".aio-test-home")) {
  console.error(
    `reset-test-home: refusing to delete ${target} — ` +
      `AIO_APPS_DIR must end with .aio-test-home`,
  );
  Deno.exit(1);
}

await Deno.remove(target, { recursive: true }).catch((e) => {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
});
