// An app lock written in ANOTHER pid namespace (a container sharing the lock
// dir) names a pid that means nothing here: pid 7 is dead — or a stranger, or
// US — from this side. Its owner is judged by its HOLD file instead: an OS
// lock the owner keeps for its lifetime and the kernel drops when it dies.
// The namespace is simulated: a record stamped `ns: ours + 1`, whose hold a
// child process keeps locked (as the container's app would).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  foreignOwnerRefusal,
  isLockOwnerAlive,
  isOwnLock,
  killProcess,
  type LockData,
  lockKey,
  lockPath,
  ownPidNs,
  readLock,
  replaceLockIf,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const LINUX = Deno.build.os === "linux";

async function inApps(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await tempDir("lock-foreign-ns-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  try {
    await fn(dir);
  } finally {
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
}

/** A process that OS-locks `path` (creating it) until killed. */
async function holder(path: string): Promise<Deno.ChildProcess> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const f = Deno.openSync(${JSON.stringify(path)}, ` +
      `{ write: true, create: true }); f.lockSync(true); ` +
      `console.log("held"); setInterval(() => {}, 1e6);`,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const r = child.stdout.getReader();
  const { value } = await r.read();
  // Closed now, not when the child dies: under load the pipe could still be
  // open when the test ends (a leak), and "held" is all it ever prints.
  await r.cancel();
  assertEquals(new TextDecoder().decode(value).trim(), "held");
  return child;
}

/** Can another process take an OS lock on `path` right now? */
async function lockableElsewhere(path: string): Promise<boolean> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const f = Deno.openSync(${JSON.stringify(path)}, { read: true }); ` +
      `console.log(f.tryLockSync(true));`,
    ],
  }).output();
  return new TextDecoder().decode(out.stdout).trim() === "true";
}

/** Remove a lock record this test wrote (already gone is fine). */
function dropRecord(path: string): void {
  try {
    Deno.removeSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "app lock, foreign pid namespace: alive while its hold is locked — even when its pid is ours — never taken, never signalled; dead once the hold is free",
  ignore: !LINUX,
  async fn() {
    await inApps(async (dir) => {
      const home = join(dir, "home");
      const path = lockPath(lockKey("nsapp", home));
      await Deno.mkdir(join(path, ".."), { recursive: true });
      const holdPath = `${path}.7d0000beef.0badf00d.hold`;
      const owner = await holder(holdPath);
      let killed = false;
      try {
        // Its pid 7 is a live process here too (the holder stands in: were it
        // ever signalled, only our own child would be).
        const rec: LockData = {
          appId: "nsapp",
          pid: owner.pid,
          port: 0,
          startedAt: Date.now() - 3_600_000,
          status: "started",
          cwd: "/",
          home,
          ns: ownPidNs()! + 1,
          // The writer's path — a container may mount the dir elsewhere; the
          // reader resolves the NAME beside the lock it read.
          hold: join("/elsewhere", basename(holdPath)),
        };
        writeLock(rec);
        const read = readLock(lockKey("nsapp", home))!;
        assertEquals(read.hold, holdPath);
        // …or even OUR pid.
        assert(
          !isOwnLock({ ...read, pid: Deno.pid }),
          "a foreign pid equal to ours read as us",
        );
        assert(isLockOwnerAlive(read), "a held hold read as dead");
        assert(foreignOwnerRefusal(read) !== null);
        // Refused, not taken over as "our own" and not killed.
        const lock = new AppLock("nsapp", home);
        const r = await lock.acquire(0, true);
        assert(!r.ok, "took over a live foreign-namespace lock");
        assertEquals(readLock(lockKey("nsapp", home))?.ns, rec.ns);
        // Its pid means another process here: never signalled.
        const gone = new Deno.Command("true").spawn();
        await gone.status;
        await assertRejects(
          () => killProcess(gone.pid, 0, { ns: rec.ns }),
          Error,
          "another pid namespace",
        );

        // The container dies: the kernel drops its OS lock.
        owner.kill("SIGKILL");
        await owner.status;
        killed = true;
        assert(!isLockOwnerAlive(read), "a dead container's lock read alive");
        assert(
          !isLockOwnerAlive({ ...read, pid: Deno.pid }),
          "a dead container's lock read alive because its pid is live here",
        );
        const again = await lock.acquire(0);
        assert(again.ok, "a dead container's lock blocked a start");
        try {
          const mine = readLock(lockKey("nsapp", home))!;
          assert(isOwnLock(mine));
          assertEquals(mine.ns, ownPidNs());
          assert(mine.hold && exists(mine.hold), "no hold recorded");
          assert(
            !(await lockableElsewhere(mine.hold)),
            "our hold is not OS-locked",
          );
          // How the container sees US: our record in its (foreign) namespace.
          assert(isLockOwnerAlive({ ...mine, ns: mine.ns! + 1 }));
          lock.release();
          assert(!exists(mine.hold), "release left the hold file");
          assert(!isLockOwnerAlive({ ...mine, ns: mine.ns! + 1 }));
        } finally {
          lock.release();
        }
      } finally {
        if (!killed) {
          owner.kill("SIGKILL");
          await owner.status;
        }
      }
    });
  },
});

Deno.test({
  name:
    "app lock, foreign pid namespace, no hold (a placeholder): alive only until a boot that long counts as stuck",
  ignore: !LINUX,
  fn() {
    const base = {
      appId: "nsplace",
      pid: Deno.pid,
      port: 0,
      status: "starting" as const,
      cwd: "/",
      ns: ownPidNs()! + 1,
    };
    assert(isLockOwnerAlive({ ...base, startedAt: Date.now() - 20_000 }));
    assert(!isLockOwnerAlive({ ...base, startedAt: Date.now() - 3_600_000 }));
    // Older records (no ns) keep the pid rule: we are alive.
    const { ns: _, ...old } = base;
    assert(isLockOwnerAlive({ ...old, startedAt: Date.now() - 3_600_000 }));
    assert(isOwnLock(old));
    // A child of ours (`am start`, a dev relaunch) vs a container's same pid.
    assert(isOwnLock({ pid: 7, ns: ownPidNs() }, 7));
    assert(!isOwnLock({ pid: 7, ns: ownPidNs()! + 1 }, 7));
  },
});

Deno.test({
  name: "app lock CAS: the same pid in another namespace is another owner",
  ignore: !LINUX,
  async fn() {
    await inApps(async (dir) => {
      const home = join(dir, "home");
      const rec: LockData = {
        appId: "nscas",
        pid: 7,
        port: 0,
        startedAt: Date.now(),
        status: "started",
        cwd: "/",
        home,
        ns: ownPidNs()! + 1,
      };
      writeLock(rec);
      // A record naming a foreign-namespace owner reads LIVE: left behind, the
      // shard's runtime-dir sweep reports it as a process that outlived us.
      using _drop = {
        [Symbol.dispose]: () => dropRecord(lockPath(lockKey("nscas", home))),
      };
      assert(
        !replaceLockIf({ ...rec, ns: ownPidNs() }, (n) => ({
          ...n,
          status: "stopping",
        })),
        "a CAS for our pid 7 rewrote the container's pid 7",
      );
      assertEquals(readLock(lockKey("nscas", home))?.status, "started");
    });
  },
});

Deno.test({
  name:
    "app lock, foreign pid namespace, the record naming OUR pid: never taken over, updated or released as ours",
  ignore: !LINUX,
  async fn() {
    await inApps(async (dir) => {
      const home = join(dir, "home");
      const key = lockKey("nsours", home);
      const path = lockPath(key);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      const holdPath = `${path}.7d0000beef.0badf00d.hold`;
      const owner = await holder(holdPath);
      const lock = new AppLock("nsours", home);
      try {
        // The container's app is pid <ours> in ITS namespace: a pid-only
        // "is it mine?" reads it as this process.
        const rec: LockData = {
          appId: "nsours",
          pid: Deno.pid,
          port: 0,
          startedAt: Date.now() - 3_600_000,
          status: "started",
          cwd: "/",
          home,
          ns: ownPidNs()! + 1,
          hold: basename(holdPath),
        };
        writeLock(rec);
        // acquire: refused, not taken over as a placeholder of ours.
        const r = await lock.acquire(0, true);
        assert(!r.ok, "took over a container's lock naming our pid");
        assertEquals(readLock(key)?.ns, rec.ns);
        // update: never written into.
        lock.update({ status: "stopping" });
        assertEquals(readLock(key)?.status, "started", "updated as ours");
        // release: a lock we held whose record the container has since
        // written (our pid, its namespace) is never removed as ours.
        Deno.removeSync(path);
        assert((await lock.acquire(0)).ok);
        writeLock(rec);
        lock.release();
        assertEquals(readLock(key)?.ns, rec.ns, "released as ours");
      } finally {
        lock.release();
        owner.kill("SIGKILL");
        await owner.status;
        // The container's record written last (see the CAS test's note).
        dropRecord(path);
      }
    });
  },
});
