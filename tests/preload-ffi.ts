// Loaded by the suite runner before any test file (`--preload`, see
// scripts/test-shards.ts).
//
// Windows keeps kernel32/advapi32 open for the life of the process;
// `src/server/win-pipe.ts` opens them when it loads. A test file that imports
// the framework statically has them before its first test. One that reaches
// it with `await import(…)` INSIDE a test body loads it there, and
// `--sanitize-resources` fails that test for "a dynamic library was loaded
// during the test, but not unloaded" — 28 files, measured on Windows 11. This
// makes the load the process's, which is whose it is. Off Windows it loads
// definitions and opens nothing.
//
// Running one such file by hand on Windows: `deno test -A
// --preload=tests/preload-ffi.ts tests/x.test.ts`.
import "../src/server/win-pipe.ts";

// …and the per-user stores are this run's from its first line. The harness
// pins them on first use (`_armTestStrict`, `tempDir()`), which a test that
// calls an `am` command or spawns one before any of that never reaches:
// MEASURED 2026-10-10, two such files run on their own each put a checkout of
// the tree under test into `~/.local/lib/aio-versions/` — what every pinned
// app on the machine runs. Under the suite runner the variables are already
// set and this changes nothing.
import "./store-sandbox.ts";

// …and Linux keeps libgtk open for the life of the process once a GTK splash
// or dialog has run (src/electron/gtk-splash.ts pinGtk — closing it crashed
// the process). A test that reaches the first one would be failed for "a
// dynamic library was loaded during the test"; opened here, it is the
// process's. No libgtk on the box: nothing to pin, and the splash says so
// itself when one is asked for.
if (Deno.build.os === "linux") {
  const { pinGtk } = await import("../src/electron/gtk-splash.ts");
  pinGtk();
}

// …and aio's own UI tests cross the wire: `testUI`'s `wire.strict` is opt-in
// (an app's tests written against 1.0.19 keep the harness they passed on),
// and this suite opts in for every file. A value already set wins.
if (!Deno.env.get("AIO_TEST_WIRE")) Deno.env.set("AIO_TEST_WIRE", "strict");

// …and a browser a test starts gets a HOME of its own: by default (what an
// app's tests get) a Chromium rewrites `~/.config/chromium/Crash Reports`
// and opens `~/.pki/nssdb` of whoever runs the suite. A value already set
// wins.
if (!Deno.env.get("AIO_TEST_BROWSER_HOME")) {
  Deno.env.set("AIO_TEST_BROWSER_HOME", "own");
}
