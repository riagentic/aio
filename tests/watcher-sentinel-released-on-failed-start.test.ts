// A watcher that does not start gives its sentinel back.
//
// `start()` takes a sentinel number and makes the file BEFORE the watcher is
// opened. When the open failed (a folder that is not there) — or was never
// asked for (`watch: false`) — start() answered false and kept both until
// `shutdown()`: the file sat in the lock dir, which then could not be pruned,
// and the next watcher in the process was `watch-<pid>-1.tmp`.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import {
  lockDir,
  ownPidTag,
  sentinelName,
} from "../src/server/single-instance-lock.ts";

const here = () =>
  [...Deno.readDirSync(lockDir())].map((e) => e.name)
    .filter((n) => n.startsWith(`watch-${ownPidTag()}`)).sort();

Deno.test({
  name:
    "watcher sentinel: a start that fails removes its file and frees its number — and a late stop takes nobody else's",
  sanitizeOps: false, // aio-ok: the fs watcher's own read
  sanitizeResources: false, // aio-ok: the fs watcher is closed by its shutdown, after the test
  async fn() {
    const tmp = await tempDir("aio-watcher-failed-start-");
    const make = (dir: string, watch?: false) =>
      createFileWatcher({
        absBaseDir: dir,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
        watch,
      });
    const ok = join(tmp, "app");
    await Deno.mkdir(ok);
    await Deno.writeTextFile(join(ok, "App.tsx"), "export default 1;\n");
    const missing = make(join(tmp, "not-there"));
    const off = make(ok, false);
    const live = make(ok);
    try {
      assertEquals(missing.start(), false, "no such folder: no watcher");
      assertEquals(here(), [], "its sentinel file stayed");
      assertEquals(off.start(), false, "watch: false");
      assertEquals(here(), [], "its sentinel file stayed");
      // The number is free: the next watcher has the name every build used.
      assertEquals(live.start(), true);
      assertEquals(here(), [sentinelName(0)]);
      // The failed ones are stopped as every watcher is — and the file that
      // is at "their" name now is the live watcher's.
      missing.shutdown();
      off.shutdown();
      assertEquals(here(), [sentinelName(0)], "a stop took another's file");
    } finally {
      missing.shutdown();
      off.shutdown();
      live.shutdown();
      await dropTempDir(tmp);
    }
    assertEquals(here(), []);
  },
});
