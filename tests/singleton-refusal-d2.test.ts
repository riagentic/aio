// A lock refusal must not take a SIBLING app down.
//
// `acquireSingletonLock` answered "Already running" with `Deno.exit(1)`. Alone
// in the process that is the right exit. With another app already booted in
// the same process (D2 — an app plus its admin panel) it ended THAT app too,
// through `unload`, with no Phase 1–7 and no final persist. Now: throw when a
// sibling runtime is registered; exit only when alone.
import { assertRejects } from "@std/assert";
import { acquireSingletonLock } from "../src/server/aio-run-helpers.ts";
import { registerRuntime } from "../src/server/shutdown.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";

Deno.test({
  name:
    "singleton refusal: throws (does not exit) when another runtime shares the process",
  sanitizeResources: false,
  sanitizeOps: false,
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
