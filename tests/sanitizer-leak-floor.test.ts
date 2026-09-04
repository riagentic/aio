// The leak floor — the framework's OWN teardown leaves nothing behind.
//
// Deno 2.9 made `--sanitize-ops` / `--sanitize-resources` opt-in, and the
// suite ran without them for long enough to grow two leaks that every booted
// app carried: a completed async call kept its half-way heartbeat timer armed
// for up to half a ceiling (`cell-impl.ts`), and an app's shutdown re-armed
// the diagnostics checkpoint debounce AFTER its own final flush
// (`checkpoint.ts`). Neither showed in a test; both kept a finished process
// alive. These cases run with the sanitizers ON regardless of the task's
// flags, so the floor holds even from a bare `deno test -A <file>`.
//
// Every case here leaked before its fix and names the resource it pins.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  pauseCallDeadlines,
  registerCall,
  resetPending,
  resolveCall,
} from "../src/state/cell-impl.ts";
import {
  createCheckpoint,
  readCheckpoint,
} from "../src/diagnostics/checkpoint.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { cell } from "../src/state/cell-create.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { getLogger } from "../src/diagnostics/logger-api.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { useAio } from "../src/browser/browser-air-hooks.ts";
import { h } from "../src/air/vdom.ts";
import { race } from "../src/state/async-helpers.ts";
import { aio } from "../src/server/aio.ts";

const STRICT = { sanitizeOps: true, sanitizeResources: true } as const;

Deno.test({
  ...STRICT,
  name:
    "call registry: a resolved call clears its heartbeat, not only its deadline",
  async fn() {
    // Default ceiling (30 s) → heartbeat at 15 s. `settle()` looked the
    // heartbeat up by id one line after `resolveCall` had deleted the id, so
    // it was never cleared: every completed async call left a 15 s timer.
    const done = registerCall("leak-floor-1", "c:m");
    resolveCall("leak-floor-1", 42);
    assertEquals(await done, 42);
  },
});

Deno.test({
  ...STRICT,
  name:
    "call registry: a deadline re-armed by pause/resume is cleared on settle",
  async fn() {
    // A resume arms a FRESH deadline on the entry — a handle the registration
    // closure never saw. The entry is what gets disarmed now.
    const done = registerCall("leak-floor-2", "c:m");
    const resume = pauseCallDeadlines();
    resume();
    resolveCall("leak-floor-2", "ok");
    assertEquals(await done, "ok");
  },
});

Deno.test({
  ...STRICT,
  name: "call registry: resetPending() disarms the calls it forgets",
  async fn() {
    // The harness reset between tests: a registration dropped with its
    // timers armed is a wakeup for a call nobody remembers.
    registerCall("leak-floor-3", "c:m").catch(() => {});
    resetPending();
    // Forgotten for real: the same id registers again (a duplicate would
    // throw), and settles as a fresh call — with nothing from the first left.
    const again = registerCall("leak-floor-3", "c:m");
    resolveCall("leak-floor-3", "second");
    assertEquals(await again, "second");
  },
});

Deno.test({
  ...STRICT,
  name: "checkpoint: a schedule after the final flush is dropped, arms nothing",
  async fn() {
    const dir = await tempDir("aio-ckpt-final-");
    try {
      const cp = createCheckpoint(dir, 5000);
      const data = (n: number) => ({
        ts: Date.now(),
        state: { n },
        recentActions: [],
        cells: {},
      });
      cp.schedule(data(1));
      await cp.flush();
      // Phase 5 of a real shutdown does exactly this: `onStop` → every cell's
      // `onDestroy` → a dispatch → `afterAction` → `schedule`. It used to arm
      // a 5 s debounce that outlived the app. Dropped now — and the flushed
      // checkpoint, the app's real final state, is what stays on disk.
      cp.schedule(data(2));
      assertEquals(
        readCheckpoint(dir)?.state,
        { n: 1 },
        "the final checkpoint is the flushed state, not the teardown's",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ...STRICT,
  name: "race(): a timeout branch that lost is cleared, not left to fire",
  async fn() {
    // `race({ paid: until(...), timeout: 30_000 })` won by `paid` kept a 30 s
    // timer armed — a CLI with its answer that would not exit.
    const r = await race({ fast: Promise.resolve(1), timeout: 30_000 });
    assertEquals(r.winner, "fast");
  },
});

Deno.test({
  ...STRICT,
  name:
    "a boot that refuses leaves nothing behind — no interval, no lock, no worker",
  async fn() {
    // The route table is validated in Phase 4, after the lock, the vitals
    // sampler, the heartbeat, SQLite and the worker pool have all started.
    // The refusal reached the caller as a clean error; the intervals stayed.
    const c = cell("leak-floor-refused", { state: { n: 0 }, methods: {} });
    const baseDir = await tempDir("aio-refused-boot-");
    try {
      const err = await assertRejects(() =>
        aio.run({
          cells: [c],
          appId: "leak-floor-refused",
          client: "server-only",
          persist: false,
          libraryMode: true,
          port: freePort(),
          baseDir,
          routes: { "/files/*/x": () => new Response("no") },
        } as never)
      );
      assertStringIncludes((err as Error).message, '"*" must be the LAST');
    } finally {
      await dropTempDir(baseDir);
    }
  },
});

Deno.test({
  ...STRICT,
  name: "an app whose onStop hook throws still tears its logger down",
  async fn() {
    // `onStop` runs after the final persist, so a dispatch from it is refused
    // and an app that awaits it throws. The bridge used to skip the logger
    // teardown on that throw: heartbeat interval left armed, "stopped" line
    // never written.
    const c = cell("leak-floor-onstop", {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n++;
        },
      },
    });
    const srv = await testServer({
      cells: [c],
      onStop: async () => {
        await (c as unknown as { bump(): Promise<void> }).bump();
      },
    });
    await srv.close();
    assertEquals(
      getLogger(),
      null,
      "the logger was detached despite the throw",
    );
  },
});

Deno.test({
  ...STRICT,
  name:
    "testUI: a component calling useAio() opens no socket and arms no retry",
  async fn() {
    // The harness mounts on the standalone runtime, but `useAio()` reached
    // the browser client's connect: a real WebSocket to the happy-dom origin,
    // refused, and a reconnect timer — per test, for a server that is not
    // there. The harness owns the transport for the length of a mount now.
    const probe = cell("leak-floor-useaio", { state: { n: 1 }, methods: {} });
    const App = () => {
      const { ready, state } = useAio<{ "leak-floor-useaio": { n: number } }>();
      return h(
        "div",
        { t: "gate" },
        ready ? `n=${state["leak-floor-useaio"]?.n}` : "loading",
      );
    };
    await using ui = await testUI(App, { cells: [probe] });
    assertEquals(ui.gate.text, "n=1");
  },
});

Deno.test({
  ...STRICT,
  name: "a booted app closes with no timer, socket, file or watcher behind",
  async fn() {
    const c = cell("leak-floor-app", {
      state: { n: 0 },
      methods: {
        inc(s: { n: number }) {
          s.n++;
        },
      },
    });
    const srv = await testServer({ cells: [c] });
    await srv.app.dispatch({ type: "leak-floor-app:inc", payload: undefined });
    assertEquals(
      (srv.app.getState() as { "leak-floor-app": { n: number } })[
        "leak-floor-app"
      ].n,
      1,
    );
    await srv.close();
  },
});
