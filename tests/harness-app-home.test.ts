// a field report #6 + "Evil": a test harness that can write into the user's home.
//
// App code legitimately asks `appDirs(appId)` where its files live. Under a test
// that resolved to the developer's REAL `~/.<appId>`, because `bootCells` had no
// `baseDir` (testServer does) and `registerAppDirs` was not exported. One field
// report's server tests installed a fixture binary into the real install for the
// whole project — and the pollution then HID a second bug, by making two tests
// pass against an artefact that existed only on that machine.
//
// Two guarantees now: the harness sandboxes every app directory automatically,
// and a test that WANTS a fixture directory can pin one explicitly.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _armTestStrict,
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  registerAppDirs,
} from "../src/cell-test.ts";
import { homedir } from "../src/server/paths.ts";

Deno.test("harness: app dirs never resolve into the real home", () => {
  _armTestStrict();
  const home = appDirs("some-app-that-does-not-exist").home;
  assert(
    !home.startsWith(join(homedir(), ".some-app")),
    `a harness must not resolve app files into ~/: got ${home}`,
  );
  assert(
    Deno.env.get("AIO_APPS_DIR"),
    "the sandbox (or the runner's pin) must be in place before any cell boots",
  );
});

Deno.test("harness: a test can pin its own fixture directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-fixture-" });
  try {
    const dirs = appDirs("fixture-app", tmp);
    registerAppDirs("fixture-app", dirs);
    ensureAppDirs(dirs);
    try {
      // What app code sees from now on — the same path the test wrote to.
      assertEquals(appDirs("fixture-app").home, tmp);
      await Deno.mkdir(dirs.files, { recursive: true });
      await Deno.writeTextFile(
        join(dirs.files, "vendor-binary"),
        "#!/bin/sh\n",
      );
      assertEquals(
        await Deno.readTextFile(
          join(appDirs("fixture-app").files, "vendor-binary"),
        ),
        "#!/bin/sh\n",
        "app code and the test agree on one directory",
      );
    } finally {
      _resetAppDirs();
    }
    // Released: resolution falls back to the sandbox, not the fixture.
    assert(appDirs("fixture-app").home !== tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
