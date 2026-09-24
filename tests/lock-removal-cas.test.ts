// Every lock removal is compare-and-delete, and a lock dir is pruned file by
// file.
//
// A command judges a lock dead, and by the time it deletes, a NEW instance may
// hold the same name. `am stop` on a stale "starting" placeholder then deleted
// the re-booted instance's LIVE lock, and a second instance acquired it and
// opened the same state.db. Each case runs in a child with its own
// XDG_RUNTIME_DIR / AIO_APPS_DIR, so nothing here touches the real runtime dir.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  boundUnixSockets,
  instances,
  lockPath,
  pruneDeadLockDirAt,
  readLock,
  removeLockFileIf,
  removeLockIfOwner,
  replaceLockIf,
  rootRegistryEntry,
} from "../src/server/single-instance-lock.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const REPO = join(import.meta.dirname!, "..");
const url = (p: string) => JSON.stringify(toFileUrl(join(REPO, p)).href);
const LOCK = url("src/server/single-instance-lock.ts");

async function child(
  dir: string,
  code: string,
  runtime = join(dir, "run"),
): Promise<unknown> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", join(REPO, "deno.json"), code],
    env: {
      XDG_RUNTIME_DIR: runtime,
      AIO_APPS_DIR: join(dir, "apps"),
      AIO_LOG_LEVEL: "error",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  if (!o.success) {
    throw new Error(out + new TextDecoder().decode(o.stderr));
  }
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

/** A SHORT runtime dir for the tests that bind a socket in the lock dir:
 *  the path is `<runtime>/aio-<48-char scope>/<name>.sock`, and under a long
 *  HOME/AIO_TEST_ROOT it would pass the ~108-byte limit. */
async function shortRuntime(): Promise<string> {
  // aio-ok: a socket is bound under it — /tmp keeps the path under the limit
  return await Deno.makeTempDir({ dir: "/tmp", prefix: "aio-rt-" });
}

async function scratch(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
  return dir;
}

/** A stale placeholder `pf` for "b" (its pid has exited) — while a NEW "b"
 *  (this child) holds the lock. `act` runs the removal under test. */
const staleThenLive = (act: string) => `
  const m = await import(${LOCK});
  const home = Deno.env.get("AIO_APPS_DIR") + "/b";
  const gone = new Deno.Command("true").spawn(); await gone.status;
  const pf = { appId: "b", pid: gone.pid, port: 0, startedAt: Date.now(),
    status: "starting", cwd: "/", home };
  const live = new m.AppLock("b", home);
  const first = (await live.acquire(0)).ok;
  ${act}
  const now = m.readLock(m.lockKey("b", home));
  // A SECOND PROCESS asks, as a second instance would — in this one, the
  // lock names our own pid and reads as ours.
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", ${JSON.stringify(join(REPO, "deno.json"))},
      \`const m = await import(${LOCK});
       const ok = (await new m.AppLock("b", \${JSON.stringify(home)}).acquire(0)).ok;
       console.log(ok);\`],
    stdout: "piped", stderr: "null",
  }).output();
  const second = new TextDecoder().decode(o.stdout).trim() === "true";
  console.log(JSON.stringify({ first, lockPid: now?.pid, me: Deno.pid, second }));
  live.release();`;

function assertKept(r: unknown): void {
  const o = r as {
    first: boolean;
    lockPid: number;
    me: number;
    second: boolean;
  };
  assert(o.first, "the live instance acquired");
  assertEquals(o.lockPid, o.me, "the live lock must still be there");
  assertEquals(o.second, false, "a second instance must be refused");
}

Deno.test({
  name: "lock CAS: am stop on a stale placeholder keeps a re-booted live lock",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await scratch("lock-cas-stop-");
    try {
      assertKept(
        await child(
          dir,
          staleThenLive(`
          const { stopOne } = await import(${url("src/am/am-cmd-process.ts")});
          await stopOne({ appId: "b", port: 0, pf }, { json: true });`),
        ),
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "lock CAS: removePid with a stale pf, or none, keeps the live lock",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await scratch("lock-cas-rmpid-");
    try {
      const am = url("src/am/am-utils.ts");
      assertKept(
        await child(
          dir,
          staleThenLive(`
          const { removePid } = await import(${am});
          removePid("b", pf);`),
        ),
      );
      // No record read at all (a port-only stop): nothing was judged, so
      // nothing goes — the key "b" is exactly the live lock's.
      assertKept(
        await child(
          dir,
          staleThenLive(`
          const { removePid } = await import(${am});
          removePid("b", null);`),
        ),
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("lock CAS: removeLockFileIf removes only the exact bytes judged", async () => {
  const dir = await tempDir("lock-cas-bytes-");
  try {
    const p = join(dir, "x.lock");
    await Deno.writeTextFile(p, '{"appId":"x","pid":2}');
    assertEquals(removeLockFileIf(p, '{"appId":"x","pid":1}'), false);
    assert(await Deno.stat(p), "a lock re-published since must stay");
    assertEquals(removeLockFileIf(p, '{"appId":"x","pid":2}'), true);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test({
  name: "lock dir prune: dead files go one by one, anything live keeps the dir",
  ignore: Deno.build.os !== "linux", // bound-socket liveness is /proc/net/unix
  async fn() {
    const base = await shortRuntime(); // sockets are bound under it
    const dir = join(base, "aio-scope");
    await Deno.mkdir(dir, { mode: 0o700 });
    const gone = new Deno.Command("true").spawn();
    await gone.status;
    const put = (n: string, s: string) => Deno.writeTextFile(join(dir, n), s);
    const lock = (pid: number) =>
      JSON.stringify({
        appId: "a",
        pid,
        port: 0,
        startedAt: 0,
        status: "started",
      });
    const bound = Deno.listen({
      transport: "unix",
      path: join(dir, "up.sock"),
    });
    try {
      await put("live.lock", lock(1)); // pid 1: alive, not ours
      await put("dead.lock", lock(gone.pid));
      await put("torn.lock", "{"); // unknown, and fresh — kept
      // Names THIS process, but no lock it holds wrote it: a planted record.
      await put("mine.lock", lock(Deno.pid));
      await put("plain.sock", "a FILE named like a socket — not ours to judge");
      await put(`watch-${gone.pid}.tmp`, "");
      await put("a.lock.mx", "");
      // A socket whose process was SIGKILLed: the file stays, nobody is bound
      // to it. (A clean `close()` unlinks it — not the case this is about.)
      const binder = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `Deno.listen({ transport: "unix", path: ${
            JSON.stringify(join(dir, "down.sock"))
          } }); console.log("up"); setInterval(() => {}, 1000);`,
        ],
        stdout: "piped",
      }).spawn();
      const rd = binder.stdout.getReader();
      await rd.read();
      binder.kill("SIGKILL");
      await binder.status;
      rd.releaseLock();
      await binder.stdout.cancel().catch(() => {});
      assert(
        Deno.lstatSync(join(dir, "down.sock")).isSocket,
        "the dead socket",
      );
      // Unparsable, but naming a LIVE pid: never judged dead, root or not.
      await put("half.lock", JSON.stringify({ appId: "h", pid: 1 }));
      await Deno.mkdir(join(base, ".aio-roots"));
      await Deno.writeTextFile(rootRegistryEntry(dir), "/apps");
      assertEquals(pruneDeadLockDirAt(dir), false);
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
        ["half.lock", "live.lock", "plain.sock", "torn.lock", "up.sock"],
      );
      assert(!(await exists(join(dir, "down.sock"))), "a dead socket goes");
      assert(!(await exists(join(dir, "mine.lock"))), "a planted lock goes");
      assert(
        Deno.statSync(rootRegistryEntry(dir)),
        "kept dir stays registered",
      );
      bound.close();
      Deno.removeSync(join(dir, "live.lock"));
      Deno.removeSync(join(dir, "plain.sock"));
      // A torn lock whose apps root is gone (the gate's call) goes by its
      // bytes; `torn.lock` is fresh, so only `rootGone` can say so.
      assertEquals(pruneDeadLockDirAt(dir), false, "fresh torn lock kept");
      assertEquals(pruneDeadLockDirAt(dir, true), false, "a live pid named");
      assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), [
        "half.lock",
      ]);
      Deno.removeSync(join(dir, "half.lock"));
      assertEquals(pruneDeadLockDirAt(dir, true), true);
      assertEquals([...Deno.readDirSync(base)].map((e) => e.name), [
        ".aio-roots",
      ]);
      assertEquals([...Deno.readDirSync(join(base, ".aio-roots"))], []);
    } finally {
      try {
        bound.close();
      } catch { /* closed above */ }
      await Deno.remove(base, { recursive: true }); // made above
    }
  },
});

Deno.test("boundUnixSockets: /proc/net/unix paths; unreadable is unknown", () => {
  const table = "Num       RefCount Protocol Flags    Type St Inode Path\n" +
    "0000: 00000002 00000000 00010000 0001 01 3 /run/a b.sock\n" +
    "0000: 00000002 00000000 00000000 0001 03 4\n" +
    "0000: 00000002 00000000 00000000 0001 03 5 @abstract\n";
  assertEquals([...boundUnixSockets(() => table, "linux")!], [
    "/run/a b.sock",
  ]);
  // macOS: `netstat -f unix -n` — as measured on the macOS 14 VM.
  const mac = "Active LOCAL (UNIX) domain sockets\n" +
    "Address          Type   Recv-Q Send-Q            Inode             Conn" +
    "             Refs          Nextref Addr\n" +
    "636b3b01962bb57b stream      0      0 a7246ffed81bf7d1                0" +
    "                0                0 /tmp/aio-x/app.sock\n" +
    "636b3b01962bb57c stream      0      0                0 636b3b01962bb57d" +
    "                0                0\n";
  assertEquals([...boundUnixSockets(() => mac, "darwin")!], [
    "/tmp/aio-x/app.sock",
  ]);
  assertEquals(
    boundUnixSockets(() => {
      throw new Error("no /proc");
    }),
    null,
  );
});

// The path is the raw remainder after the fixed columns: a split-and-rejoin
// folded `a  b` / `a\tb` into `a b` — a socket that does not exist, so the
// dir holding the LIVE one read as dead.
Deno.test("boundUnixSockets: a path keeps its double spaces and tabs", async () => {
  const odd = "/run/a  b\tc .sock";
  assertEquals([
    ...boundUnixSockets(
      () => `0000: 00000002 00000000 00010000 0001 01    37 ${odd}\n`,
      "linux",
    )!,
  ], [odd]);
  assertEquals([
    ...boundUnixSockets(
      () =>
        `636b3b01962bb57b stream      0      0 a7246ffed81bf7d1                0` +
        `                0                0 ${odd}\n`,
      "darwin",
    )!,
  ], [odd]);
  if (!["linux", "darwin"].includes(Deno.build.os)) return;
  // …and LIVE, from the real table (/proc/net/unix, or netstat on macOS).
  // aio-ok: a socket is bound under it — /tmp keeps the path under the limit
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "bus-" });
  const path = `${dir}/a  b\tc.sock`;
  const l = Deno.listen({ transport: "unix", path });
  try {
    const bound = boundUnixSockets()!;
    assert(bound.has(path), [...bound].filter((p) => p.startsWith(dir)).join());
  } finally {
    l.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// A `singleton: false` app holds no lock, so nothing keeps its cached lock
// dir: a sibling's exit prune removed it, and the socket bind failed ENOENT.
Deno.test({
  name: "lock dir: a UDS bind recreates a lock dir pruned under it, 0700",
  ignore: Deno.build.os === "windows",
  fn: () =>
    permissiveUmask(async () => {
      const dir = await scratch("lk-");
      const rt = await shortRuntime();
      try {
        const r = await child(
          dir,
          `const m = await import(${LOCK});
         const u = await import(${url("src/server/uds.ts")});
         const d = m.lockDir();
         Deno.removeSync(d); // a sibling's exit prune, after we cached it
         const p = d + "/free.sock";
         const h = u.createUDSListener(p, () => ({}), () => {}, () => {});
         const c = await Deno.connect({ path: p, transport: "unix" });
         c.close();
         h.shutdown();
         console.log(JSON.stringify({ mode: Deno.statSync(d).mode & 0o777 }));`,
          rt,
        );
        assertEquals(r, { mode: 0o700 });
      } finally {
        await dropTempDir(dir);
        await Deno.remove(rt, { recursive: true }); // made by this test above
      }
    }),
});

Deno.test("removeLockIfOwner: another start identity is another owner", () => {
  const key = `own-${crypto.randomUUID().slice(0, 8)}`;
  const put = (extra: Record<string, unknown>) =>
    Deno.writeTextFileSync(
      lockPath(key),
      JSON.stringify({
        appId: key,
        pid: 1,
        port: 0,
        startedAt: 0,
        status: "started",
        ...extra,
      }),
    );
  try {
    // Same pid, other kernel start ticks: the pid was recycled — a new owner.
    put({ startToken: "111" });
    assertEquals(removeLockIfOwner(key, { pid: 1, startToken: "222" }), false);
    assertEquals(readLock(key)?.startToken, "111");
    // macOS: same pid, other start second.
    put({ startEpoch: 5 });
    assertEquals(removeLockIfOwner(key, { pid: 1, startEpoch: 6 }), false);
    assertEquals(readLock(key)?.startEpoch, 5);
    assertEquals(removeLockIfOwner(key, { pid: 1, startEpoch: 5 }), true);
  } finally {
    try {
      Deno.removeSync(lockPath(key));
    } catch { /* removed above */ }
  }
});

// `instances()` judges a lock dead, NAMES a dead hold (a log line), then
// removes — and a new instance can publish in between. Driven through that
// very gap: the log line re-publishes the lock, as a racing boot would.
Deno.test("instances(): a lock re-published after it was judged dead is kept", async () => {
  const id = `inst-${crypto.randomUUID().slice(0, 8)}`;
  const gone = new Deno.Command("true").spawn();
  await gone.status;
  const base = { appId: id, port: 0, startedAt: 1, status: "started" };
  Deno.writeTextFileSync(
    lockPath(id),
    JSON.stringify({ ...base, pid: gone.pid, maintenance: { op: "backup" } }),
  );
  const fresh = JSON.stringify({ ...base, pid: 1, startedAt: 2 });
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: () => Deno.writeTextFileSync(lockPath(id), fresh), // the racing boot
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  try {
    instances(id);
    assertEquals(Deno.readTextFileSync(lockPath(id)), fresh);
  } finally {
    setLogger(prev);
    try {
      Deno.removeSync(lockPath(id));
    } catch { /* already gone */ }
  }
});

// A lock dir that EXISTS is not therefore a safe place for a control socket:
// under a shared `/tmp` another account can create the path in the gap a
// prune opened. Every bind re-checks it (ours, 0700, not a link).
Deno.test({
  name: "lock dir: a UDS bind re-checks an EXISTING dir — 0700, or refused",
  // aio-ok(umask): the dir is chmod'ed 0755 first and must END 0700 — chmod ignores the umask, so none can fake the re-check.
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await scratch("lk2-");
    const rt = await shortRuntime();
    try {
      const r = await child(
        dir,
        `const m = await import(${LOCK});
         const u = await import(${url("src/server/uds.ts")});
         const d = m.lockDir();
         Deno.chmodSync(d, 0o755);
         const h = u.createUDSListener(d + "/a.sock", () => ({}), () => {}, () => {});
         h.shutdown();
         const mode = Deno.statSync(d).mode & 0o777;
         Deno.removeSync(d, { recursive: true });
         Deno.writeTextFileSync(d, "not a directory");
         let refused = false;
         try {
           u.createUDSListener(d + "/b.sock", () => ({}), () => {}, () => {});
         } catch { refused = true; }
         Deno.removeSync(d);
         console.log(JSON.stringify({ mode, refused }));`,
        rt,
      );
      assertEquals(r, { mode: 0o700, refused: true });
    } finally {
      await dropTempDir(dir);
      await Deno.remove(rt, { recursive: true }); // made by this test above
    }
  },
});

// `am`'s own lock WRITES (the "stopping" mark and its undo, the status
// self-repair, the start placeholder) are compare-and-swap too: writing the
// record it had READ over whatever was there by then turned a re-booted
// instance's live lock into a stale-looking copy of the old one.
Deno.test("replaceLockIf: writes only over the record read, onto its current bytes", () => {
  const id = `cas-${crypto.randomUUID().slice(0, 8)}`;
  const rec = (startedAt: number, extra = {}) => ({
    appId: id,
    pid: 1,
    port: 0,
    startedAt,
    status: "started" as const,
    cwd: "/",
    ...extra,
  });
  try {
    assertEquals(replaceLockIf(null, rec(1)), true, "created while absent");
    assertEquals(replaceLockIf(null, rec(9)), false, "never over a lock");
    const read = readLock(id)!;
    // The owner updates its own lock (a port it bound): still the record read.
    Deno.writeTextFileSync(lockPath(id), JSON.stringify(rec(1, { port: 7 })));
    assertEquals(
      replaceLockIf(read, (now) => ({ ...now, status: "stopping" })),
      true,
    );
    assertEquals(readLock(id)?.port, 7, "applied to the CURRENT record");
    // The SAME owner finished booting (`starting` → `started`, its own
    // startedAt over the placeholder's): still the owner read.
    Deno.writeTextFileSync(lockPath(id), JSON.stringify(rec(5)));
    assertEquals(
      replaceLockIf(read, (now) => ({ ...now, port: 8 })),
      true,
      "a booting flip is the same owner",
    );
    assertEquals(readLock(id)?.startedAt, 5);
    // Same pid, another kernel start: a recycled pid — another owner.
    const recycled = JSON.stringify(rec(6, { startToken: "999" }));
    Deno.writeTextFileSync(lockPath(id), recycled);
    assertEquals(
      replaceLockIf({ ...read, startToken: "111" }, (now) => now),
      false,
    );
    assertEquals(Deno.readTextFileSync(lockPath(id)), recycled);
    // Another process re-published: not the owner read any more.
    const next = JSON.stringify(rec(2, { pid: 2 }));
    Deno.writeTextFileSync(lockPath(id), next);
    assertEquals(
      replaceLockIf(read, (now) => ({ ...now, status: "stopping" })),
      false,
    );
    assertEquals(Deno.readTextFileSync(lockPath(id)), next);
  } finally {
    try {
      Deno.removeSync(lockPath(id));
    } catch { /* already gone */ }
  }
});

Deno.test({
  name:
    "am stop: a lock another process published after the read is neither marked nor signalled",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await scratch("lock-cas-mark-");
    try {
      const r = await child(
        dir,
        `const m = await import(${LOCK});
         const { stopOne } = await import(${url("src/am/am-cmd-process.ts")});
         const home = Deno.env.get("AIO_APPS_DIR") + "/b";
         // What \`am stop\` read: an instance that has since gone away —
         // its pid now a live stranger's (a sleep) with that stranger's start.
         const old = new Deno.Command("sleep", { args: ["30"] }).spawn();
         const live = new m.AppLock("b", home);
         await live.acquire(0); // …and a NEW instance (this one) holds b now
         const pf = { ...m.readLock(m.lockKey("b", home)), pid: old.pid,
           ...m.ownerIdentity(old.pid) };
         const before = Deno.readTextFileSync(m.lockPath(m.lockKey("b", home)));
         const res = await stopOne({ appId: "b", port: 0, pf }, { json: true });
         const after = Deno.readTextFileSync(m.lockPath(m.lockKey("b", home)));
         const oldAlive = m.isProcessAlive(old.pid);
         old.kill("SIGKILL"); await old.status;
         live.release();
         console.log(JSON.stringify({ ok: res.ok, error: res.error,
           same: before === after, oldAlive }));`,
      );
      const o = r as {
        ok: boolean;
        error: string;
        same: boolean;
        oldAlive: boolean;
      };
      assertEquals(o.ok, false);
      assert(o.error.includes("another process"), o.error);
      assert(o.same, "the live lock was rewritten");
      assert(o.oldAlive, "a process the lock no longer names was signalled");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// `am start`'s placeholder lock: never over a LIVE owner's lock, never over
// the child's own; over a DEAD owner's, yes.
Deno.test("am start placeholder: never over a live owner, or the child's own", async () => {
  const { writeStartPlaceholder } = await import(
    "../src/am/am-cmd-process.ts"
  );
  const id = `ph-${crypto.randomUUID().slice(0, 8)}`;
  const gone = new Deno.Command("true").spawn();
  await gone.status;
  const rec = (pid: number) => ({
    appId: id,
    pid,
    port: 0,
    startedAt: 1,
    status: "starting" as const,
    cwd: "/",
  });
  const put = (pid: number) => {
    const t = JSON.stringify(rec(pid));
    Deno.writeTextFileSync(lockPath(id), t);
    return t;
  };
  const child = rec(gone.pid + 100000); // the spawned child: another pid
  try {
    const live = put(1); // pid 1: alive, another owner
    assertEquals(writeStartPlaceholder(readLock(id), child), false);
    assertEquals(Deno.readTextFileSync(lockPath(id)), live, "live lock kept");
    const own = put(child.pid); // the child already wrote its own
    assertEquals(writeStartPlaceholder(readLock(id), child), false);
    assertEquals(Deno.readTextFileSync(lockPath(id)), own);
    put(gone.pid); // a dead owner's — replaced
    assertEquals(writeStartPlaceholder(readLock(id), child), true);
    assertEquals(readLock(id)?.pid, child.pid);
    Deno.removeSync(lockPath(id));
    assertEquals(writeStartPlaceholder(null, child), true, "none there");
  } finally {
    try {
      Deno.removeSync(lockPath(id));
    } catch { /* already gone */ }
  }
});

// Only a LOCK dir gets the lock dir's rules. `createUDSListener` is public: a
// socket path its caller chose sits in THEIR directory, which is not ours to
// chmod 0700 (or to refuse).
Deno.test({
  name: "UDS bind: a caller-chosen socket dir keeps its mode",
  // aio-ok(umask): the dir is chmod'ed 0755 and must KEEP it — a restrictive umask cannot produce 0755, only break it.
  ignore: Deno.build.os === "windows",
  async fn() {
    const { createUDSListener } = await import("../src/server/uds.ts");
    const dir = await shortRuntime();
    try {
      Deno.chmodSync(dir, 0o755);
      const h = createUDSListener(
        `${dir}/app.sock`,
        () => ({}),
        () => {},
        () => {},
      );
      h.shutdown();
      assertEquals(Deno.statSync(dir).mode! & 0o777, 0o755);
    } finally {
      await Deno.remove(dir, { recursive: true }); // made above
    }
  },
});
