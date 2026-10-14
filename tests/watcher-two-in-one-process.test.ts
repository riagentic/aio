// Two watchers in one process each have a sentinel of their own.
//
// The sentinel was named by the process alone (`watch-<pid>.tmp`), so a
// second watcher — a test server beside another, two apps hosted by one
// process — recreated the first's file as its own, and the first's shutdown
// then removed the file the second still touched: 60 s later "watcher
// unresponsive", three restarts, and live reload was off.
//
// One watcher at a time keeps the name every build has used (the lowest free
// number is taken, and number 0 has no suffix), so nothing that reads the
// lock dir sees a difference until there really are two.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import {
  lockDir,
  ownPidTag,
  pruneDeadLockDirAt,
  sentinelName,
  sweepDeadSentinels,
} from "../src/server/single-instance-lock.ts";
import { exits0 } from "./proc-helper.ts";

/** A pid that is certainly dead: a child that has exited. */
async function deadPid(): Promise<number> {
  const child = exits0();
  await child.status;
  return child.pid;
}

const here = () =>
  [...Deno.readDirSync(lockDir())].map((e) => e.name)
    .filter((n) => n.startsWith(`watch-${ownPidTag()}`)).sort();

Deno.test({
  name:
    "watcher sentinel: two watchers in one process each keep their own, and one's stop leaves the other's",
  sanitizeOps: false, // aio-ok: the fs watcher's own read
  sanitizeResources: false, // aio-ok: the fs watcher is closed by its shutdown, after the test
  async fn() {
    const tmp = await tempDir("aio-two-watchers-");
    const watcher = async (name: string) => {
      const dir = join(tmp, name);
      await Deno.mkdir(dir);
      await Deno.writeTextFile(join(dir, "App.tsx"), "export default 1;\n");
      return createFileWatcher({
        absBaseDir: dir,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
      });
    };
    const [a, b, c] = [
      await watcher("a"),
      await watcher("b"),
      await watcher("c"),
    ];
    const [first, second] = [sentinelName(0), sentinelName(1)];
    try {
      assertEquals(first, `watch-${ownPidTag()}.tmp`, "the name it always had");
      assert(a.start() && b.start());
      assertEquals(here(), [second, first].sort());
      const ino = Deno.statSync(join(lockDir(), first)).ino;
      a.shutdown();
      assertEquals(here(), [second], "the first's stop took the second's file");
      // The number is free again: the next watcher has the plain name, a new
      // file — and the second's is still its own.
      assert(c.start());
      assertEquals(here(), [second, first].sort());
      assert(Deno.statSync(join(lockDir(), first)).ino !== ino || ino === null);
      b.shutdown();
      assertEquals(here(), [first]);
    } finally {
      a.shutdown();
      b.shutdown();
      c.shutdown();
      await dropTempDir(tmp);
    }
    assertEquals(here(), []);
  },
});

// Both shapes are a dead watcher's once its process is gone — swept by a
// starting watcher, and no reason to keep a scoped dir.
Deno.test("watcher sentinel: a dead process's second sentinel is swept and pruned like its first", async () => {
  const dir = await tempDir("aio-two-watchers-sweep-");
  try {
    const dead = ownPidTag().replace(/^\d+/, String(await deadPid()));
    const names = [`watch-${dead}.tmp`, `watch-${dead}-1.tmp`];
    const plant = () =>
      names.forEach((n) => Deno.writeTextFileSync(join(dir, n), ""));
    const left = () => [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    plant();
    Deno.writeTextFileSync(join(dir, `watch-${dead}-x.tmp`), ""); // no sentinel
    sweepDeadSentinels(dir);
    assertEquals(left(), [`watch-${dead}-x.tmp`]);
    Deno.removeSync(join(dir, `watch-${dead}-x.tmp`));
    plant();
    assertEquals(pruneDeadLockDirAt(dir), true, "the dir kept a dead sentinel");
  } finally {
    await dropTempDir(dir).catch(() => {}); // aio-ok: pruned by the test itself
  }
});

// A sweep ended at the first remove that failed (a sibling swept that one
// first), leaving every dead sentinel after it.
Deno.test("watcher sentinel: a sweep tries every dead sentinel, whatever one remove says", async () => {
  const dir = await tempDir("aio-sentinel-sweep-each-");
  const realRemove = Deno.removeSync;
  try {
    const dead = ownPidTag().replace(/^\d+/, String(await deadPid()));
    for (let n = 1; n <= 4; n++) {
      Deno.writeTextFileSync(join(dir, `watch-${dead}-${n}.tmp`), "");
    }
    let removes = 0;
    Deno.removeSync = (path, o) => {
      if (++removes === 1) {
        realRemove(path, o); // the sibling got there first
        throw new Deno.errors.NotFound(`No such file or directory: ${path}`);
      }
      realRemove(path, o);
    };
    sweepDeadSentinels(dir);
    Deno.removeSync = realRemove;
    assertEquals(removes, 4);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  } finally {
    Deno.removeSync = realRemove;
    await dropTempDir(dir);
  }
});
