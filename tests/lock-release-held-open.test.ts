// A lock file another process holds open when its owner quits is waited for —
// and when it outlasts the wait, the next start does not call it a crash.
//
// Removing the lock was one `removeSync` whose failure was swallowed. On
// Windows a scanner holding the file for an instant made a CLEAN quit leave
// its lock behind, and the next start warned that the previous run "did not
// shut down cleanly" and may have lost state — which was not true.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import {
  AppLock,
  lockDir,
  lockPath,
  removeLockIfOwner,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const DENIED = () =>
  new Deno.errors.PermissionDenied("Access is denied. (os error 5): remove");

/** Run `fn` as on Windows with the first `fails` removes of a `.lock` refused;
 *  returns every log line said meanwhile as `level category message`. */
async function held<T>(
  fails: number,
  fn: () => T | Promise<T>,
): Promise<{ out: T; said: string[]; waits: number }> {
  const real = { ..._renameDeps };
  const said: string[] = [];
  let calls = 0, waits = 0;
  _renameDeps.windows = () => true;
  _renameDeps.pause = () => void waits++;
  _renameDeps.remove = (path) => {
    if (path.endsWith(".lock") && calls++ < fails) throw DENIED();
    real.remove(path);
  };
  setLogger({
    pub: (lvl: string, cat: string, msg: string) =>
      void said.push(`${lvl} ${cat} ${msg}`),
  } as unknown as LogSink);
  try {
    return { out: await fn(), said, waits };
  } finally {
    Object.assign(_renameDeps, real);
    setLogger(null);
  }
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const drop = (p: string) => {
  try {
    Deno.removeSync(p);
  } catch { /* aio-ok: the test already consumed it */ }
};
const id = () => `relheld-${crypto.randomUUID().slice(0, 8)}`;
const loud = (said: string[]) => said.filter((l) => !l.startsWith("debug "));

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const c = new Deno.Command(Deno.execPath(), {
    args: ["eval", ""],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await c.status;
  return c.pid;
}

Deno.test("release: a lock file held for an instant is still removed — nothing said, no mark", async () => {
  const lock = new AppLock(id());
  assert((await lock.acquire(0)).ok);
  const r = await held(3, () => lock.release());
  assertEquals(r.waits, 3);
  assert(!exists(lockPath(lock.key)), "the lock must be gone");
  assert(!exists(join(lockDir(), `${lock.key}.quit`)));
  assertEquals(loud(r.said), []);
});

Deno.test("release: held to the end → one warning at quit, and the next start says a clean quit, not a crash", async () => {
  const appId = id();
  const pid = await deadPid();
  const key = new AppLock(appId).key;
  const quit = join(lockDir(), `${key}.quit`);
  try {
    // The owner's side: its release cannot remove the file.
    const lock = new AppLock(appId);
    assert((await lock.acquire(0)).ok);
    const r = await held(Infinity, () => lock.release());
    const warned = loud(r.said);
    assertEquals(warned.length, 1, warned.join("\n"));
    assertStringIncludes(warned[0]!, "warn lock ");
    assertStringIncludes(warned[0]!, "could not be removed at quit");
    assertStringIncludes(warned[0]!, "os error 5");
    assert(exists(lockPath(key)), "the held file is still there");
    assertEquals(
      Deno.readTextFileSync(quit),
      Deno.readTextFileSync(lockPath(key)),
      "the mark holds the lock's own bytes",
    );

    // The next start meets that lock with its owner gone. (This process is
    // the owner above and is alive, so the same pair is planted for a dead
    // pid: record + mark.)
    drop(lockPath(key));
    writeLock({
      appId,
      pid,
      port: 0,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: "/",
    });
    Deno.writeTextFileSync(quit, Deno.readTextFileSync(lockPath(key)));
    const next = new AppLock(appId);
    const n = await held(0, () => next.acquire(0));
    try {
      assert(n.out.ok);
      const about = loud(n.said).filter((l) => l.includes("previous run"));
      assertEquals(about.length, 1, n.said.join("\n"));
      assertStringIncludes(about[0]!, "info lock ");
      assertStringIncludes(about[0]!, "quit cleanly");
      assert(!n.said.some((l) => l.includes("did not shut down cleanly")));
      assert(!exists(quit), "the mark is consumed");
    } finally {
      next.release();
    }
  } finally {
    drop(quit);
    drop(lockPath(key));
  }
});

Deno.test("next start: a dead owner's lock with NO mark, or another run's mark, is still a crash", async () => {
  const appId = id();
  const pid = await deadPid();
  const key = new AppLock(appId).key;
  const quit = join(lockDir(), `${key}.quit`);
  try {
    for (const mark of [null, '{"pid":1,"some":"other run"}']) {
      writeLock({
        appId,
        pid,
        port: 0,
        startedAt: Date.now() - 60_000,
        status: "started",
        cwd: "/",
      });
      if (mark) Deno.writeTextFileSync(quit, mark);
      const next = new AppLock(appId);
      const n = await held(0, () => next.acquire(0));
      try {
        assert(n.out.ok);
        const crash = n.said.filter((l) =>
          l.includes("did not shut down cleanly")
        );
        assertEquals(crash.length, 1, n.said.join("\n"));
        assertStringIncludes(crash[0]!, "warn lock ");
        assert(!exists(quit), "a mark that names another run is dropped");
      } finally {
        next.release();
      }
    }
  } finally {
    drop(quit);
    drop(lockPath(key));
  }
});

Deno.test("removeLockIfOwner: a held lock is waited for; at the bound it says so and answers false", async () => {
  const appId = id();
  const key = new AppLock(appId).key;
  try {
    writeLock({
      appId,
      pid: Deno.pid,
      port: 0,
      startedAt: Date.now(),
      status: "started",
      cwd: "/",
    });
    const stuck = await held(
      Infinity,
      () => removeLockIfOwner(key, { pid: Deno.pid }),
    );
    assertEquals(stuck.out, false);
    assertEquals(loud(stuck.said).length, 1, stuck.said.join("\n"));
    assertStringIncludes(loud(stuck.said)[0]!, "could not be removed");
    assert(exists(lockPath(key)));

    const ok = await held(2, () => removeLockIfOwner(key, { pid: Deno.pid }));
    assertEquals(ok.out, true);
    assertEquals(loud(ok.said), []);
    assert(!exists(lockPath(key)));
  } finally {
    drop(lockPath(key));
  }
});
