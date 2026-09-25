// Once a spawned child's leader has exited AND its group is empty, the pgid is
// free for the kernel to recycle into an UNRELATED process group. A late
// kill(), an abort, or a pending SIGKILL timer must then signal NOTHING
// (reproduced for real: under `unshare -Urpf` with ns_last_pid forcing reuse,
// a stale handle's kill()/abort SIGTERMed a foreign `setsid sleep`). Tested
// through the injectable GroupSys, since forcing pid reuse is not portable.
//
// And a ZOMBIE is not a live member: signal 0 succeeds for one, and where
// nothing reaps orphans (Deno as PID 1 in a container) it never goes away —
// the registry entry, its poll, a "killed 1 child process(es)" warning at
// every shutdown and a grace+1s kill() were forever.
import { assert, assertEquals } from "@std/assert";
import {
  _handle,
  _liveSpawned,
  _procStat,
  type GroupSys,
  spawn,
} from "../src/server/spawn.ts";

const OK = { code: 0, signal: null, success: true };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeSys(alive: () => boolean) {
  const sent: string[] = [];
  const sys: GroupSys = {
    alive: () => alive(),
    signal: (_pgid, sig) => void sent.push(sig),
  };
  return { sys, sent };
}

Deno.test("spawn group gone: kill() and abort after the group emptied never reach a recycled pgid", async () => {
  let recycled = false; // the group empties; later an unrelated group gets its id
  const { sys, sent } = fakeSys(() => recycled);
  const ac = new AbortController();
  const h = _handle(
    4242,
    Promise.resolve(OK),
    Promise.resolve(),
    50,
    ac.signal,
    "x",
    undefined,
    sys,
  );
  await tick(); // leader exited, group seen empty
  recycled = true;
  assertEquals(await h.kill(), OK);
  let abortKills = 0;
  h.kill = () => (abortKills++, Promise.resolve(OK));
  ac.abort();
  await tick(100);
  assertEquals(sent, [], "a recycled pgid must never be signalled");
  assertEquals(abortKills, 0, "the abort listener is removed once gone");
});

Deno.test("spawn group gone: the SIGKILL timer is dropped once the group empties", async () => {
  let live = true;
  const { sys, sent } = fakeSys(() => live);
  const h = _handle(
    4242,
    Promise.resolve(OK),
    Promise.resolve(),
    150,
    undefined,
    "x",
    undefined,
    sys,
  );
  await tick();
  const killing = h.kill();
  assertEquals(sent, ["SIGTERM"], "a live survivor gets TERM");
  live = false; // the survivor exits on TERM; its pgid is now free
  await killing;
  await tick(250);
  assertEquals(sent, ["SIGTERM"], "no SIGKILL to a pgid that may be reused");
});

Deno.test("spawn group gone: a live survivor still gets SIGKILL after grace", async () => {
  let live = true;
  const { sys, sent } = fakeSys(() => live);
  const h = _handle(
    4242,
    Promise.resolve(OK),
    Promise.resolve(),
    60,
    undefined,
    "x",
    undefined,
    sys,
  );
  await tick();
  const killing = h.kill();
  await tick(120);
  assertEquals(sent, ["SIGTERM", "SIGKILL"]);
  live = false;
  await killing;
});

Deno.test("spawn procStat: fields counted from the last paren", () => {
  assertEquals(_procStat("123 (a) b) c) Z 1 777 777 0"), {
    state: "Z",
    pgrp: 777,
  });
  assertEquals(_procStat("9 (sleep) S 8 42 42 0"), { state: "S", pgrp: 42 });
  assertEquals(_procStat("garbage"), null);
});

Deno.test({
  name:
    "spawn group gone: a group holding only a zombie is forgotten and kill() is prompt",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    // The leader forks P and exits; P forks Z (exits at once), then
    // setsid()s OUT of the group and never waits: the group is left holding
    // only the zombie Z, whose live parent keeps it unreaped.
    let p: number | undefined;
    const h = await spawn("perl", {
      args: [
        "-e",
        "use POSIX (); if (fork()) { POSIX::_exit(0) } " +
        "if (!fork()) { POSIX::_exit(0) } POSIX::setsid(); $| = 1; " +
        'print "p:$$\\n"; close STDOUT; close STDERR; sleep 30;',
      ],
      killGraceMs: 2000,
      onLine: (l) => {
        const m = l.match(/^p:(\d+)$/);
        if (m) p = Number(m[1]);
      },
    });
    try {
      await h.status;
      assert(p !== undefined, "P reported its pid");
      const end = Date.now() + 3000;
      while (_liveSpawned().has(h.pid) && Date.now() < end) await tick(50);
      assertEquals(
        _liveSpawned().has(h.pid),
        false,
        "a zombie-only group is gone",
      );
      const t = Date.now();
      await h.kill();
      assert(Date.now() - t < 500, `kill() took ${Date.now() - t} ms`);
    } finally {
      if (p !== undefined) {
        try {
          Deno.kill(p, "SIGKILL");
        } catch { /* already gone */ }
      }
    }
  },
});
