// Every shutdown closes the `worker: true` cells in ONE place and ONE order:
// after `onStopping`, before dispatch closes.
//
// Two paths had two sequences. `app.close()` / a signal closed the worker
// pool and THEN ran the orchestrator; the update handover ran the
// orchestrator alone and never closed the pool at all. A worker cell's call
// goes straight to its thread (`route` bypasses the main loop), so on the
// update path every worker-cell call during the drain started new work and
// its patches — flagged in-flight — were admitted: measured, 21 commits in a
// 500 ms drain, against 0 through `app.close()`. And on the `app.close()` path
// the pool closed BEFORE `onStopping`, so the hook documented as "may
// dispatch, and the write is persisted" — the only way to stop a worker
// cell's own producers — was refused for exactly those cells.
//
// Now the orchestrator runs `closeWorkers` itself, between the two.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createShutdownOrchestrator,
  type ShutdownRefs,
} from "../src/server/shutdown.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Stub refs whose every phase records itself. */
function stubRefs(done: string[], over: Partial<ShutdownRefs>): ShutdownRefs {
  const mark = (n: string) => () => void done.push(n);
  const quiet = () => {};
  return {
    flushPersist: async () => void done.push("persist"),
    setShuttingDown: mark("setShuttingDown"),
    diagHooks: { onStop: async () => void done.push("diag") },
    getVitalsCheckTimer: () => undefined,
    getVitalsSystem: () => ({ destroy: mark("vitals") }),
    onStopping: undefined,
    onStop: mark("hook"),
    appLock: { release: mark("lock") },
    scheduleManager: { cancelAll: mark("schedules") },
    ownManager: { disposeAll: mark("own") },
    dispatch: {
      close: mark("dispatch.close"),
      drain: async () => void done.push("drain"),
    },
    getCellNames: () => [],
    getAppId: () => "shutdown-worker-order",
    getElectronProc: () => null,
    clearElectronProc: () => {},
    disposeUds: mark("uds"),
    getUdsHandle: () => null,
    getServer: () => ({ shutdown: async () => void done.push("server") }),
    asyncDb: { close: async () => void done.push("sqlite") },
    kvDb: { close: mark("kv") },
    sessionStore: { close: mark("sessions") },
    userStore: { close: mark("users") },
    setRunning: (v: boolean) => void done.push(`running:${v}`),
    log: {
      trace: quiet,
      debug: quiet,
      info: quiet,
      warn: quiet,
      error: quiet,
    } as unknown as ShutdownRefs["log"],
    ...over,
  };
}

Deno.test("shutdown: the worker cells close after onStopping and before dispatch closes", async () => {
  const done: string[] = [];
  const { shutdown } = createShutdownOrchestrator(stubRefs(done, {
    onStopping: () => void done.push("onStopping"),
    closeWorkers: async () => void done.push("closeWorkers"),
  }));
  await shutdown();
  const at = (n: string) => done.indexOf(n);
  assert(at("closeWorkers") >= 0, `the worker cells never closed: ${done}`);
  assert(at("onStopping") < at("closeWorkers"), done.join(" → "));
  assert(at("closeWorkers") < at("setShuttingDown"), done.join(" → "));
  assert(at("closeWorkers") < at("dispatch.close"), done.join(" → "));
  assertEquals(done.filter((d) => d === "closeWorkers").length, 1);
});

/** A worker cell with a producer of its own (an `own` watcher dispatching
 *  through the `app` its `onInit` captured) — stopped the documented way:
 *  `onStopping` calls the cell. */
function appSource(port: number): string {
  return `import { aio, cell, own } from "${REPO}/mod.ts";

const G = globalThis as any;
export const w = cell("w", {
  worker: true,
  onInit(app: any) {
    G.appDispatch = (a: any) => app.dispatch(a);
  },
  state: { ticks: 0, stopped: false },
  methods: {
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
    },
    stop(s: any) {
      s.$do(own.dispose("w:watch"));
      s.stopped = true;
      return "stopped";
    },
  },
});

const app = await aio.run({
  cells: [w],
  appId: "shutdown-worker-order-" + crypto.randomUUID().slice(0, 8),
  client: "server-only",
  persist: false,
  port: ${port},
  appDir: Deno.env.get("PROBE_DIR"),
  onStopping: async () => {
    try {
      console.log("ONSTOPPING " + (await w.stop()) + " stopped=" + w.stopped);
    } catch (e) {
      console.log("ONSTOPPING REFUSED " + (e as Error).message);
    }
  },
});
await w.watch();
await new Promise((r) => setTimeout(r, 150));
await app.close();
console.log("CLOSED");
// A call after the pool closed: refused BY THE WORKER, by name — never handed
// to the main loop, whose reduce would run the cell on the main isolate.
await w.tick().then(
  () => console.log("LATE applied"),
  (e: Error) => console.log("LATE refused: " + e.message),
);
Deno.exit(0);
`;
}

Deno.test({
  name:
    "shutdown: onStopping may call a worker cell — the documented way to stop its producers works",
  async fn() {
    const dir = await tempDir("aio-worker-onstopping-");
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
      assertStringIncludes(all, "CLOSED");
      assertStringIncludes(
        all,
        `LATE refused: [aio] cell worker "w" is closed`,
      );
      // The hook's call reached the worker and its write came home…
      assertStringIncludes(all, "ONSTOPPING stopped stopped=true", all);
      // …so the producer was stopped BEFORE the drain: nothing to refuse.
      assert(
        !all.includes("dispatch is draining — 'w:tick'"),
        `the worker's producer outlived onStopping:\n${all}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
