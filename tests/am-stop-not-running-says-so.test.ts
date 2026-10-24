// `am stop` on an app that is not running. Exit 1 STAYS (the CLI surface is
// frozen, and a mistyped --app is indistinguishable from an app already
// down), but the refusal used to read like any lookup failure: "app not
// running: no lock file". It now says there was nothing to stop, why that is
// still exit 1, and the idempotent spelling a script wants.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = join(import.meta.dirname!, "..", "src", "am.ts");

Deno.test("am stop (not running): exit 1, and it says nothing was there to stop", async () => {
  // Its own lock dir: the refusal lists what IS running, never the host's.
  const apps = await tempDir("am-stop-none-");
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "stop", `--app=r4-not-running-${Deno.pid}`],
    env: { NO_COLOR: "1", AIO_AM_NO_DELEGATE: "1", AIO_APPS_DIR: apps },
    stdout: "piped",
    stderr: "piped",
  }).output().finally(() => dropTempDir(apps));
  const dec = new TextDecoder();
  const all = dec.decode(r.stdout) + dec.decode(r.stderr);
  assertEquals(r.code, 1, all);
  assertStringIncludes(all, "nothing to stop");
  assertStringIncludes(all, "|| true");
  assertStringIncludes(all, "no lock file", "the diagnosis is kept");
});
