// A lock refusal must not take a SIBLING app down.
//
// `acquireSingletonLock` answered "Already running" with `Deno.exit(1)`. Alone
// in the process that is the right exit. With another app already booted in
// the same process (D2 — an app plus its admin panel) it ended THAT app too,
// through `unload`, with no Phase 1–7 and no final persist. Now: throw when a
// sibling runtime is registered; exit only when alone.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import {
  _alreadyRunningMessage,
  acquireSingletonLock,
} from "../src/server/aio-run-helpers.ts";
import { registerRuntime } from "../src/server/shutdown.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";

Deno.test({
  name:
    "singleton refusal: throws (does not exit) when another runtime shares the process",
  async fn() {
    const appId = `d2-refusal-${Deno.pid}`;
    // An owner that is alive (pid 1 — EPERM counts as alive) and whose port
    // answers, so the lock is neither stale nor a zombie: a genuine refusal.
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const port = (l.addr as Deno.NetAddr).port;
    writeLock({
      appId,
      pid: 1,
      port,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
    });
    const unregister = registerRuntime(() => Promise.resolve());
    const realExit = Deno.exit;
    let exited = false;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = () => {
      exited = true;
      throw new Error("Deno.exit called");
    };
    try {
      await assertRejects(
        () => acquireSingletonLock(appId, undefined, port, true, false),
        Error,
        "Already running",
      );
      if (exited) {
        throw new Error(
          "refusal exited the process with a sibling app running",
        );
      }
    } finally {
      Deno.exit = realExit;
      unregister();
      removeLock(appId);
      l.close();
    }
  },
});

// ── the refusal has to name the way OUT ─────────────────────────────
//
// "Already running: todo at http://localhost:9010 (pid 123)" is true and a
// dead end. The reporter who hit it did so on the FIRST run of a fresh
// scaffold: a second, unrelated project also called `todo`. That is the case
// worth naming, because the appId also picks the data home — the two projects
// were about to share one database.

Deno.test("singleton refusal: names how to stop it, and the appId/data-home collision", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: "/home/u/.todo",
    takeover: false,
  });
  assertStringIncludes(msg, "Already running: todo");
  assertStringIncludes(msg, "am stop todo");
  assertStringIncludes(msg, "kill 4242");
  assertStringIncludes(msg, "--takeover");
  // The trap: `--port` looks like the fix and is not.
  assertStringIncludes(msg, "--port=N` does NOT help");
  // The data home is the reason a name clash is not cosmetic.
  assertStringIncludes(msg, "/home/u/.todo");
  assertStringIncludes(msg, 'aio.run({ appId: "…" })');
});

Deno.test("singleton refusal: --takeover that failed gets the fact, not the advice it already followed", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 0,
    pid: 0,
    home: "/home/u/.todo",
    takeover: true,
  });
  assertStringIncludes(msg, "Failed to take over");
  assert(
    !msg.includes("--takeover"),
    `it just ran with --takeover. Got: ${msg}`,
  );
  assert(!msg.includes("(pid"), `no pid known — say nothing. Got: ${msg}`);
});
