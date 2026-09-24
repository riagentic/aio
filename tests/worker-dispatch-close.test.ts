// A WORKER cell's own dispatch loop closes at shutdown, like the main one.
//
// Shutdown's contract (shutdown.ts Phase 1, dispatch.ts `DispatchPhase`): a
// method already running finishes WRITING; nothing starts new work. The main
// loop enforces it by closing (open → draining → sealed) and admitting only
// writes flagged in-flight. A worker cell's commits reach the main loop as
// patches that are ALL flagged in-flight (cell-worker-pool.ts), so the main
// loop cannot tell a running method's last write from new work the worker
// started by itself — and the worker's own loop never closed. An `own` watcher
// dispatching through the `app` its `onInit` captured kept committing for the
// whole close drain (measured: 20 commits in a 500 ms drain), where the same
// watcher on the main isolate is refused with DISPATCH_DRAINING.
//
// Real process, real worker: libraryMode runs worker cells in-isolate, so no
// in-process harness reaches the worker host's close handler.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

function appSource(port: number): string {
  return `import { aio, cell, own } from "${REPO}/mod.ts";

const G = globalThis as any;
export const w = cell("w", {
  worker: true,
  onInit(app: any) {
    G.appDispatch = (a: any) => app.dispatch(a);
  },
  state: { ticks: 0, run: "" },
  methods: {
    // A watcher: new work this thread starts on its own, every 20 ms.
    watch(s: any) {
      s.$do(own.set("w:watch", () => {
        const id = setInterval(
          () => void G.appDispatch({ type: "w:tick", payload: {} })?.catch?.(() => {}),
          20,
        );
        return () => clearInterval(id);
      }));
    },
    tick(s: any) {
      s.ticks++;
      console.log("TICK " + Date.now());
    },
    // In flight at shutdown, ignoring its abort for 500 ms: holds the drain
    // open, and its final write must still land.
    async hold(s: any) {
      s.run = "running";
      const t0 = Date.now();
      while (Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 20));
      s.run = "finished";
    },
  },
});

const app = await aio.run({
  cells: [w],
  appId: "worker-dispatch-close-" + crypto.randomUUID().slice(0, 8),
  client: "server-only",
  persist: false,
  port: ${port},
  appDir: Deno.env.get("PROBE_DIR"),
});
await w.watch();
await new Promise((r) => setTimeout(r, 200));
w.hold();
await new Promise((r) => setTimeout(r, 100));
console.log("CLOSE_START " + Date.now());
await app.close();
console.log("CLOSED run=" + w.run);
Deno.exit(0);
`;
}

Deno.test({
  name:
    "worker close: the worker's own loop drains — new work it starts itself is refused, the in-flight write lands",
  async fn() {
    const dir = await tempDir("aio-worker-close-");
    try {
      const entry = join(dir, "app.ts");
      await Deno.writeTextFile(entry, appSource(freePort()));
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(REPO, "deno.json"), entry],
        env: childEnv({ PROBE_DIR: join(dir, "home") }),
        stdout: "piped",
        stderr: "piped",
      }).output();
      const all = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, all);

      const closeAt = Number(/CLOSE_START (\d+)/.exec(all)?.[1]);
      assert(closeAt > 0, `the app never reached shutdown:\n${all}`);
      const ticks = [...all.matchAll(/TICK (\d+)/g)].map((m) => Number(m[1]));
      // The watcher really ran — else "no tick during the drain" is vacuous.
      assert(
        ticks.filter((t) => t < closeAt).length >= 5,
        `the watcher never ticked before shutdown:\n${all}`,
      );
      // 50 ms of grace for the close message to cross the thread; the drain
      // itself lasts ~500 ms (the held method), ~20 watcher intervals.
      const during = ticks.filter((t) => t > closeAt + 50);
      assertEquals(
        during,
        [],
        `the worker kept committing NEW work during its close drain:\n${all}`,
      );
      assertStringIncludes(
        all,
        "dispatch is draining — 'w:tick' is new input and was refused",
      );
      // …and its advice is one that WORKS for a worker cell: `onStopping`
      // runs before the pool closes, so it can call the cell and stop the
      // producer (tests/shutdown-worker-order.test.ts follows it).
      assertStringIncludes(all, "Stop it in `onStopping`");
      // The in-flight method still finished writing, and it reached home.
      assertStringIncludes(all, "CLOSED run=finished");
    } finally {
      await dropTempDir(dir);
    }
  },
});
