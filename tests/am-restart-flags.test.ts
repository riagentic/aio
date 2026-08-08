// a field report: `am restart` dropped the original launch flags
// (esp. --env-file), so the vault stopped auto-unlocking after a restart.
// Two guarantees: (1) deno-runtime flags are placed BEFORE the entry script so
// Deno actually honors them, and (2) the launch is recorded so restart replays.
import { assert, assertEquals } from "@std/assert";
import { buildDenoArgs } from "../src/am/am-cmd-process.ts";
import {
  physicalMemoryBytes,
  resolveMaxHeapMB,
} from "../src/server/heap-policy.ts";
import { join } from "@std/path";
import { appDirs } from "../src/server/app-dirs.ts";
import {
  launchInfoPath,
  lockDir,
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

Deno.test("buildDenoArgs: no flags → the entry, plus this machine's heap ceiling", () => {
  // The ceiling is not optional garnish: V8's default is ~4 GB whatever the
  // machine, it is fixed at isolate creation, and a launcher is the only thing
  // that can set it in time. `am start` is the managed launch, so it does.
  const want = resolveMaxHeapMB(physicalMemoryBytes());
  assertEquals(buildDenoArgs("src/app.ts", []), [
    "run",
    "-A",
    "--unstable-kv",
    ...(want === null ? [] : [`--v8-flags=--max-old-space-size=${want}`]),
    "src/app.ts",
  ]);
});

Deno.test("buildDenoArgs: an explicit --v8-flags outranks the computed one", () => {
  // Two --v8-flags would leave V8 silently taking the last; an operator who
  // typed the flag means it.
  const argv = buildDenoArgs("src/app.ts", [
    "--v8-flags=--max-old-space-size=2048",
  ]);
  assertEquals(
    argv.filter((a) => a.startsWith("--v8-flags")),
    ["--v8-flags=--max-old-space-size=2048"],
  );
});

Deno.test("buildDenoArgs: the ceiling precedes the entry, like every runtime flag", () => {
  const argv = buildDenoArgs("src/app.ts", ["--port=8000"]);
  const entryIdx = argv.indexOf("src/app.ts");
  const heapIdx = argv.findIndex((a) => a.startsWith("--v8-flags"));
  if (heapIdx >= 0) {
    assert(
      heapIdx < entryIdx,
      "a runtime flag after the entry reaches the APP",
    );
  }
});

// These tests write real files at real resolved paths, so they pin the app root
// themselves — `deno task test` pins it for the whole suite, but a developer
// running this ONE file directly must not scatter dot-dirs in their home either.
function withAppRoot<T>(fn: (root: string) => T): T {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const root = Deno.makeTempDirSync({ prefix: "aio-launch-" });
  Deno.env.set("AIO_APPS_DIR", root);
  try {
    return fn(root);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    try {
      Deno.removeSync(root, { recursive: true });
    } catch { /* best effort */ }
  }
}

Deno.test("launch-info sidecar: round-trips the recorded flags for restart", () => {
  withAppRoot(() => {
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
});

// The record must live WITH the app (`~/.<appId>/launch.json`), not in a shared
// toolchain dir and not in the runtime dir. The runtime dir is cleared on logout
// by design — right for the lock and socket, and precisely wrong for a record
// whose only job is to survive until the next `am restart`. Keeping it per-app
// also means "delete the app" is one `rm -rf` and a sandbox needs one variable.
Deno.test("launch-info sidecar: lives in the app's own directory", () => {
  withAppRoot(() => {
    const appId = "test-launch-loc-" + Deno.pid;
    const path = launchInfoPath(appId);
    assertEquals(path, join(appDirs(appId).home, "launch.json"));
    assert(
      !path.includes(lockDir()),
      `must not be in the runtime dir (cleared on logout): ${path}`,
    );
    assert(
      !path.includes(`${appDirs(appId).data}/`),
      `must not be inside the backup unit — it is regenerable: ${path}`,
    );
    try {
      writeLaunchInfo(appId, { flags: ["--env-file=.env"] });
      // Written where it says it is, and readable from there.
      assertEquals(JSON.parse(Deno.readTextFileSync(path)).flags, [
        "--env-file=.env",
      ]);
      assertEquals(readLaunchInfo(appId)?.flags, ["--env-file=.env"]);
    } finally {
      removeLaunchInfo(appId);
    }
  });
});

// An app that was already running when aio was upgraded recorded its flags in
// the old runtime-dir location; `am restart` still has to replay them.
Deno.test("launch-info sidecar: still reads the pre-alpha38 location", () => {
  withAppRoot(() => {
    const appId = "test-launch-legacy-" + Deno.pid;
    const legacy = join(lockDir(), `${appId}.launch.json`);
    try {
      Deno.writeTextFileSync(
        legacy,
        JSON.stringify({ flags: ["--env-file=x"] }),
      );
      assertEquals(readLaunchInfo(appId)?.flags, ["--env-file=x"]);
      removeLaunchInfo(appId); // must clean BOTH locations
      assertEquals(readLaunchInfo(appId), null);
    } finally {
      try {
        Deno.removeSync(legacy);
      } catch { /* already gone */ }
    }
  });
});
