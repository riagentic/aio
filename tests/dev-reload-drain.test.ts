// A dev reload waits for the calls in flight (dev-restart.ts `drainForReload`)
// — and while it waits, the app is still RUNNING, not restarting:
//   1. a window the user closes during the wait is a stop, never read as the
//      restart's own teardown (`isRestarting()` stays false), and a stop
//      during the wait cancels the restart;
//   2. the watcher holds the browser reload: pages reloaded onto the new
//      bundle would talk to the OLD cell code until the restart — and that
//      holds for a plain server module too, whose restart is decided by an
//      async server-graph walk that can end after the reload debounce.
//
// Its own file: a restart claim lasts for the life of the process.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  isRestarting,
  restartForCellChange,
  restartPending,
} from "../src/server/dev-restart.ts";
import {
  createFileWatcher,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";
import {
  _resetStopProcess,
  _setExitFn,
  processStopping,
  stopProcess,
} from "../src/server/shutdown.ts";
import { stopEsbuild, transpile } from "../src/server/server-transpile.ts";
import { trackPending } from "../src/state/method-cancel.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("dev reload drain: the app is not 'restarting' while it waits, the reload is held, and a stop cancels the restart", async () => {
  const tmp = await tempDir("aio-dev-reload-drain-");
  const entry = join(tmp, "server.ts");
  const helper = join(tmp, "helper.ts");
  await Deno.writeTextFile(
    entry,
    `import { f } from "./helper.ts";\nconsole.log(f());\n`,
  );
  await Deno.writeTextFile(helper, "export const f = () => 1;\n");
  let end!: () => void;
  trackPending(new Promise<void>((r) => end = r), "drainc", "", {
    key: "drainc:slow",
  });
  let shutdownRan = false;
  let restart: Promise<void> | undefined;
  const exits: number[] = [];
  const restoreExit = _setExitFn(
    ((code: number) => {
      exits.push(code);
    }) as (code: number) => never,
  );
  const sent: string[] = [];
  const w = createFileWatcher({
    absBaseDir: tmp,
    importMapObj: {},
    debug: () => {},
    broadcastWs: (m) => sent.push(m),
    serverEntry: toFileUrl(entry).href,
    // The server-graph walk ends well after the reload debounce.
    transpile: async (src, f) => {
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
      return transpile(src, f);
    },
    onCellChange: (path) => {
      restart = restartForCellChange(path, () => {
        shutdownRan = true;
        return Promise.resolve();
      });
    },
  });
  try {
    // A save of a module the server imports: the walk decides it restarts.
    await Deno.writeTextFile(helper, "export const f = () => 2;\n");
    w.scheduleReload(helper);
    // Polled, not one fixed wait: on a loaded machine (4 shards on a Windows
    // VM) the walk ended after the 2 x debounce + 1 s this used to sleep.
    for (let t = Date.now(); !restart && Date.now() - t < 20_000;) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(restart, "the walk found the module in the server graph");
    assert(restartPending(), "the save claimed a restart");
    assertEquals(isRestarting(), false, "draining is not tearing down");
    assertEquals(sent.map((m) => JSON.parse(m).t), [], "reload held");

    // The window closes (electronClosedPlan → stopProcess): the stop wins.
    void stopProcess(0, "window closed");
    assert(processStopping());
    end();
    await restart;
    assertEquals(shutdownRan, false, "the restart stood down for the stop");
    assertEquals(isRestarting(), false);
    assertEquals(exits, [0], "the stop exited, once");
  } finally {
    end();
    w.shutdown();
    await stopEsbuild();
    restoreExit();
    _resetStopProcess();
    await dropTempDir(tmp);
  }
});
