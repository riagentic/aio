// A child that exits leaving a grandchild in its group: the group is still
// the app's to reap. Before the fix the registry forgot the pid on the CHILD's
// exit (shutdown's killAllSpawned reported 0 over a live worker), and kill()
// cancelled its SIGKILL timer when the child died, so a TERM-ignoring
// grandchild outlived kill().
import { assert, assertEquals } from "@std/assert";
import { _liveSpawned, killAllSpawned, spawn } from "../src/server/spawn.ts";

const posix = Deno.build.os !== "windows";
const alive = (pid: number): boolean => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(p: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!p()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** Start `script` (it prints `gc:<pid>` of a backgrounded grandchild and
 *  exits); return the handle and the grandchild pid. */
async function startTree(script: string, killGraceMs = 300) {
  let gc: number | undefined;
  const h = await spawn("sh", {
    args: ["-c", script],
    killGraceMs,
    onLine: (l) => {
      const m = l.match(/^gc:(\d+)$/);
      if (m) gc = Number(m[1]);
    },
  });
  await h.status;
  await until(() => gc !== undefined, "grandchild pid line");
  return { h, gc: gc! };
}

Deno.test({
  name:
    "spawn: a grandchild outliving its exited parent stays tracked and killAllSpawned reaps it",
  ignore: !posix,
  fn: async () => {
    const { h, gc } = await startTree(
      `sleep 300 >/dev/null 2>&1 & echo "gc:$!"`,
    );
    try {
      assertEquals(alive(gc), true, "the grandchild must be running");
      assertEquals(
        _liveSpawned().has(h.pid),
        true,
        "the group still has a live member — it must not be forgotten",
      );
      assertEquals(await killAllSpawned(), 1);
      await until(() => !alive(gc), "grandchild reaped by killAllSpawned");
      assertEquals(_liveSpawned().has(h.pid), false);
    } finally {
      try {
        Deno.kill(-h.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
  },
});

Deno.test({
  name:
    "spawn: kill() escalates to SIGKILL for a TERM-ignoring grandchild even after the parent died",
  ignore: !posix,
  fn: async () => {
    const { h, gc } = await startTree(
      `sh -c 'trap "" TERM; while :; do sleep 0.05; done' >/dev/null 2>&1 & echo "gc:$!"`,
    );
    try {
      assertEquals(alive(gc), true);
      await h.kill();
      await until(() => !alive(gc), "TERM-ignoring grandchild killed", 3000);
      await until(() => !_liveSpawned().has(h.pid), "registry forgets it");
    } finally {
      try {
        Deno.kill(-h.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
  },
});

Deno.test({
  name: "spawn: a child whose group empties is forgotten by the registry",
  ignore: !posix,
  fn: async () => {
    const h = await spawn("sh", { args: ["-c", "echo done"] });
    await h.status;
    await until(() => !_liveSpawned().has(h.pid), "forgotten");
    assert(!_liveSpawned().has(h.pid), "the emptied group is forgotten");
  },
});
