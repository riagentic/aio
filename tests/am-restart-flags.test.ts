// risoto 2026-07-24 Bad #4: `am restart` dropped the original launch flags
// (esp. --env-file), so the vault stopped auto-unlocking after a restart.
// Two guarantees: (1) deno-runtime flags are placed BEFORE the entry script so
// Deno actually honors them, and (2) the launch is recorded so restart replays.
import { assert, assertEquals } from "@std/assert";
import { buildDenoArgs } from "../src/am/am-cmd-process.ts";
import {
  readLaunchInfo,
  removeLaunchInfo,
  writeLaunchInfo,
} from "../src/server/single-instance-lock.ts";

Deno.test("buildDenoArgs: --env-file lands BEFORE the entry, app flags after", () => {
  const argv = buildDenoArgs("src/app.ts", [
    "--env-file=.env",
    "--port=8000",
    "--reload",
    "--transport=uds",
  ]);
  const entryIdx = argv.indexOf("src/app.ts");
  // Deno-runtime flags precede the script…
  assert(argv.indexOf("--env-file=.env") < entryIdx, "--env-file before entry");
  assert(argv.indexOf("--reload") < entryIdx, "--reload before entry");
  // …app flags follow it.
  assert(argv.indexOf("--port=8000") > entryIdx, "--port after entry");
  assert(argv.indexOf("--transport=uds") > entryIdx, "--transport after entry");
  // A misplaced env-file (after the script) is exactly the bug — assert it isn't.
  assertEquals(argv.slice(0, 3), ["run", "-A", "--unstable-kv"]);
});

Deno.test("buildDenoArgs: no flags → just run the entry", () => {
  assertEquals(buildDenoArgs("src/app.ts", []), [
    "run",
    "-A",
    "--unstable-kv",
    "src/app.ts",
  ]);
});

Deno.test("launch-info sidecar: round-trips the recorded flags for restart", () => {
  const appId = "test-restart-flags-" + Deno.pid;
  try {
    assertEquals(readLaunchInfo(appId), null); // nothing recorded yet
    writeLaunchInfo(appId, {
      flags: ["--env-file=.env", "--port=8000"],
      entry: "src/app.ts",
    });
    const got = readLaunchInfo(appId);
    assertEquals(got?.flags, ["--env-file=.env", "--port=8000"]);
    assertEquals(got?.entry, "src/app.ts");
    removeLaunchInfo(appId);
    assertEquals(readLaunchInfo(appId), null); // cleaned on stop
  } finally {
    removeLaunchInfo(appId);
  }
});
