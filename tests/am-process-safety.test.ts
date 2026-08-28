// The four ways `am` and the lock told the truth about a process it was not
// actually talking to.
//
//   #4  a lock-WRITE failure was reported as "Already running". `tryCreateLock`
//       caught everything and returned false, which the caller renders as
//       "another process won the race". Measured on a read-only lock dir: a
//       3041 ms retry loop looking for an owner that does not exist, then
//       `[AIO] Already running` and exit 1. The app cannot boot and the
//       message sends you to look for a process.
//
//   #5  `am start` spawned `nohup deno …` by NAME. `sh` forks before it execs,
//       so a PATH without `deno` still yields a pid: measured, am printed
//       `starting app (pid N)`, exited 0, and wrote a lock for a process that
//       had already died — the real error (`nohup: failed to run command
//       'deno'`) sat in a log file nobody was told to read. `install.sh:262`
//       pins an absolute path for exactly this reason.
//
//   #6  `am --home=<dir> start` synthesized its LockData without `home`, so
//       `writeLock` filed it under the DEFAULT instance's key while every read
//       in the same command used the scoped one. Measured: three keys in one
//       command (`demo`, `demo`, `demo@d93b8442`). The running default app
//       could then no longer update or release its own lock.
//
//   #8  no kill site anywhere asked whether the pid it was about to signal was
//       still the process the lock recorded. The lock file OUTLIVES A REBOOT
//       whenever XDG_RUNTIME_DIR is unset — the base is then /tmp, which
//       Debian and Ubuntu do not clear at boot — and pids wrap.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  AppLock,
  isLockOwnerAlive,
  isProcessAlive,
  killProcess,
  type LockData,
  lockDir,
  lockKey,
  processStartToken,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import {
  detachedSpawnSpec,
  lockedPidsEverywhere,
  stalePidRefusal,
} from "../src/am/am-cmd-process.ts";
import { amLockKey, overwriteRefusal, targetHome } from "../src/am/am-utils.ts";
import { appDirs } from "../src/server/app-dirs.ts";

// ── #4 — a broken lock dir is a machine problem, not "already running" ──

Deno.test({
  name:
    "#4 lock: an UNWRITABLE lock dir throws, it does not say 'already running'",
  // The env var is read through lockDir()'s cache, so this test owns the
  // process's lock dir for its duration and restores it after.
  ignore: Deno.build.os === "windows" || Deno.uid?.() === 0,
  async fn() {
    const base = await Deno.makeTempDir({ prefix: "ro-runtime-" });
    const prev = Deno.env.get("XDG_RUNTIME_DIR");
    Deno.env.set("XDG_RUNTIME_DIR", base);
    const dir = lockDir();
    await Deno.chmod(dir, 0o500); // readable, NOT writable
    try {
      const t0 = performance.now();
      const lock = new AppLock(
        "probe-unwritable",
        await Deno.makeTempDir(),
      );
      let msg = "";
      try {
        await lock.acquire(0, false, {});
        throw new Error("acquire must not succeed on an unwritable lock dir");
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      const ms = performance.now() - t0;
      assertStringIncludes(msg, "cannot write the single-instance lock");
      assertStringIncludes(
        msg,
        'This is not "already running"',
        `the message must not leave the reader hunting for a process:\n${msg}`,
      );
      assertStringIncludes(msg, "read-only"); // names a cause
      assertStringIncludes(msg, "fix:"); // and a fix
      assert(
        ms < 1500,
        `it must fail immediately, not retry for 3s looking for an owner ` +
          `that cannot exist (took ${Math.round(ms)} ms)`,
      );
    } finally {
      await Deno.chmod(dir, 0o700).catch(() => {});
      if (prev === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
      else Deno.env.set("XDG_RUNTIME_DIR", prev);
      lockDir(); // reprime the cache for the rest of the process
      await Deno.remove(base, { recursive: true }).catch(() => {});
    }
  },
});

// ── #5 — the child is spawned by ABSOLUTE path, and checked ──

Deno.test("#5 am start: the child is the deno RUNNING am, by absolute path", () => {
  const posix = detachedSpawnSpec(
    "linux",
    ["run", "-A", "app.ts"],
    "/tmp/o.log",
  );
  const cmd = posix.args[1]!;
  assert(
    !/nohup deno\b/.test(cmd),
    `the bare word "deno" is resolved from the CHILD shell's PATH — the trap ` +
      `install.sh pins an absolute path to avoid:\n${cmd}`,
  );
  assertStringIncludes(cmd, `nohup '${Deno.execPath()}'`);

  const win = detachedSpawnSpec(
    "windows",
    ["run", "-A", "app.ts"],
    "C:\\o.log",
    "C:\\bin\\deno.exe",
  );
  assertStringIncludes(win.args.join(" "), "-FilePath 'C:\\bin\\deno.exe'");
  // The binary is quoted like every other argument — a path with a space (the
  // normal case on Windows: "C:\Program Files\…") must not split.
  const spaced = detachedSpawnSpec(
    "linux",
    ["run"],
    "/tmp/o.log",
    "/opt/my deno/bin/deno",
  );
  assertStringIncludes(spaced.args[1]!, "nohup '/opt/my deno/bin/deno'");
});

Deno.test({
  name: "#5 am start: a child that never execs is DEAD, whatever pid came back",
  ignore: Deno.build.os === "windows",
  async fn() {
    // The exact shape `am start` runs, pointed at a binary that is not there.
    // The pid is real; the process is not. This is what `am` used to report as
    // `starting app (pid N)` with exit 0.
    const log = (await Deno.makeTempDir()) + "/o.log";
    const spec = detachedSpawnSpec(
      Deno.build.os,
      ["run", "-A", "app.ts"],
      log,
      "/nonexistent/deno",
    );
    const proc = new Deno.Command(spec.cmd, {
      args: spec.args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const out = await proc.output();
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
    assert(Number.isFinite(pid) && pid > 0, "a pid comes back even so");
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(
      isProcessAlive(pid),
      false,
      "…and it names a process that never existed — which is why `am start` " +
        "must look before it reports success",
    );
    // The evidence is in the log, which is why the refusal quotes it.
    const tail = await Deno.readTextFile(log).catch(() => "");
    assert(tail.length > 0, "the failure is only ever visible in the log");
  },
});

// ── #6 — one instance, one lock key ──

Deno.test("#6 am --home: the lock am writes is the lock am reads", async () => {
  const appId = `homekey-${crypto.randomUUID().slice(0, 8)}`;
  const home = await Deno.makeTempDir({ prefix: "scoped-home-" });
  try {
    targetHome(appId, home);
    const resolved = appDirs(appId).home;

    // The three keys that used to disagree.
    const readKey = amLockKey(appId); // what readPid/removePid use
    const lockObjKey = new AppLock(appId, resolved).key; // what am start locks
    const written: LockData = {
      appId,
      pid: Deno.pid,
      port: 0,
      startedAt: Date.now(),
      status: "starting",
      cwd: Deno.cwd(),
      home: resolved, // ← the field that was missing
    };
    const writeKey = lockKey(written.appId, written.home);

    assertEquals(
      lockObjKey,
      readKey,
      "am's own lock must be the TARGETED instance's lock, not the default's",
    );
    assertEquals(
      writeKey,
      readKey,
      "the placeholder lock am writes for the child must land under the key " +
        "every later am command reads",
    );
    assert(
      readKey.includes("@"),
      "a --home-scoped instance is keyed by (appId, home)",
    );

    // And it round-trips: write it, read it back through am's own reader.
    writeLock(written);
    const back = readLock(readKey);
    assert(back, `the lock am wrote is not where am looks (${readKey})`);
    assertEquals(back.appId, appId);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
    await Deno.remove(join(lockDir(), `${amLockKey(appId)}.lock`)).catch(
      () => {},
    );
  }
});

// ── #8 — a pid is not an identity ──

Deno.test({
  name: "#8 kill: a recycled pid is not the owner, and is never signalled",
  ignore: Deno.build.os === "windows",
  async fn() {
    const token = processStartToken(Deno.pid);
    assert(
      token !== null,
      "this platform must be able to say when a pid was started",
    );
    assert(/^\S+/.test(token!), `a usable token, got ${JSON.stringify(token)}`);

    // Ourselves, correctly recorded: the owner is alive.
    assert(isLockOwnerAlive({ pid: Deno.pid, startToken: token! }));

    // The same pid, recorded by a lock written BEFORE this process existed —
    // i.e. the lock survived a reboot and the kernel handed the pid on. Alive
    // by `isProcessAlive`, and NOT the owner.
    assertEquals(
      isProcessAlive(Deno.pid),
      true,
      "the pid is alive — that is the whole trap",
    );
    assertEquals(
      isLockOwnerAlive({ pid: Deno.pid, startToken: "0" }),
      false,
      "a lock whose recorded start time does not match names a DIFFERENT " +
        "process that happens to have the same pid",
    );

    // A lock with no token at all (written before alpha69, or on a platform
    // that cannot say) falls back to liveness — never worse than before.
    assertEquals(isLockOwnerAlive({ pid: Deno.pid }), true);

    // And the guard is wired into the kill path: signalling a recycled pid is
    // refused loudly, not attempted quietly.
    let refused = "";
    try {
      await killProcess(Deno.pid, 0, { startToken: "0" });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    assertStringIncludes(refused, "refusing to signal");
    assertStringIncludes(refused, "reused");
    assert(isProcessAlive(Deno.pid), "…and we are, notably, still here");
  },
});

Deno.test({
  name:
    "#8 lock: a new lock records the start time of the process that wrote it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const appId = `token-${crypto.randomUUID().slice(0, 8)}`;
    const home = await Deno.makeTempDir({ prefix: "token-home-" });
    const lock = new AppLock(appId, home);
    try {
      const r = await lock.acquire(0, false, {});
      assert(r.ok, "acquire");
      const onDisk = readLock(lock.key);
      assert(onDisk, "the lock is on disk");
      assertEquals(
        onDisk.startToken,
        processStartToken(Deno.pid),
        "the lock must carry the kernel stamp of its owner, not just its pid",
      );
      assert(isLockOwnerAlive(onDisk));
    } finally {
      lock.release();
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  },
});

// ── #9 — the cheap ones ──

Deno.test("#9 overwrite: `am snapshot save` and `am record` guard like `am backup`", async () => {
  const dir = await Deno.makeTempDir({ prefix: "overwrite-" });
  try {
    const free = join(dir, "new.json");
    assertEquals(overwriteRefusal(free, false, "a snapshot"), null);

    const taken = join(dir, "mine.test.ts");
    await Deno.writeTextFile(taken, "the hand-written test");
    const msg = overwriteRefusal(taken, false, "a generated replay test");
    assert(msg, "an existing file must not be clobbered silently");
    assertStringIncludes(msg, taken);
    assertStringIncludes(msg, "--force");
    // …and --force is the way past, said on purpose.
    assertEquals(overwriteRefusal(taken, true, "x"), null);
    assertEquals(
      await Deno.readTextFile(taken),
      "the hand-written test",
      "checking must not write",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── #7 — `am kill --stale` used to SIGTERM a number it was told ──
//
// The pid came from an UNAUTHENTICATED loopback `/__aio/health` response, in
// which the responding process reports about ITSELF, and was signalled
// unverified. Two consequences, both real: an app running under a different
// `AIO_APPS_DIR` is invisible to `instances()`, so a healthy app was
// classified as an orphan and killed; and anything listening on a candidate
// port could name ANY pid on the machine and have `am` SIGTERM it.

Deno.test("#7 kill --stale: a pid that arrives over a socket is a claim, not a fact", () => {
  const none = new Map<number, { appId: string; dir: string }>();

  // Nonsense, and am itself: never.
  for (const bad of [0, -1, 1.5, NaN]) {
    assert(stalePidRefusal(bad, none), `${bad} must be refused`);
  }
  assertStringIncludes(stalePidRefusal(Deno.pid, none) ?? "", "am itself");

  // A pid that IS an aio instance — just not in this scope. `instances()`
  // cannot see it; the lock file can.
  const locked = new Map([[
    999_001,
    { appId: "other-app", dir: "/tmp/aio-home-elsewhere" },
  ]]);
  const why = stalePidRefusal(999_001, locked);
  assert(why, "a locked instance is never an orphan");
  assertStringIncludes(why, "other-app");
  assertStringIncludes(why, "AIO_APPS_DIR");

  // A pid nothing is running under.
  const dead = 2 ** 22 - 1; // above every default pid_max, so certainly free
  assertStringIncludes(stalePidRefusal(dead, none) ?? "", "already gone");
});

Deno.test({
  name:
    "#7 kill --stale: a live NON-aio process of ours is refused, not signalled",
  ignore: Deno.build.os === "windows",
  async fn() {
    // Something innocent of the user's, on a pid `am` was told about. Before
    // the fix this was a SIGTERM primitive for arbitrary pids.
    const p = new Deno.Command("sleep", { args: ["30"], stdout: "null" })
      .spawn();
    try {
      const why = stalePidRefusal(
        p.pid,
        new Map<number, { appId: string; dir: string }>(),
      );
      assert(why, `pid ${p.pid} runs "sleep 30" — am must not SIGTERM it`);
      assertStringIncludes(why, "not an aio process");
      assertStringIncludes(why, "sleep");
      assert(isProcessAlive(p.pid), "…and it is still running");
    } finally {
      try {
        p.kill("SIGKILL");
      } catch { /* gone */ }
      await p.status;
    }
  },
});

Deno.test("#7 kill --stale: every aio lock dir is read, not only this scope", () => {
  // The map is built from the lock FILES, across the default dir and every
  // `aio-<scope>` sibling `AIO_APPS_DIR` creates. It must at minimum be
  // readable without throwing on a machine with no locks at all.
  const m = lockedPidsEverywhere();
  assert(m instanceof Map);
  for (const [pid, info] of m) {
    assert(pid > 0);
    assert(typeof info.appId === "string" && typeof info.dir === "string");
  }
});

Deno.test({
  name:
    "#6 am start --home: refused, because am cannot make the child boot there",
  async fn() {
    // `--home` TARGETS a running instance (docs/clients/app-manager.md). It was
    // also accepted by `start`, where it did something else entirely: the child
    // booted in the DEFAULT home (am never forwards the flag — the runtime has
    // no CLI option for its data home) while am filed the placeholder lock
    // under the SCOPED key. Result: `am --home=X status` showed
    // `starting, port 0` forever, `am status` showed the real app, and the
    // ghost lock never cleared because its pid was genuinely alive.
    const dir = await Deno.makeTempDir({ prefix: "am-home-start-" });
    try {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../src/am.ts", import.meta.url).pathname,
          `--home=${dir}`,
          "start",
        ],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      const text = d.decode(o.stdout) + d.decode(o.stderr);
      assertEquals(o.code, 1, `am start --home must refuse:\n${text}`);
      assertStringIncludes(text, "cannot start one");
      assertStringIncludes(text, "AIO_APPS_DIR="); // the way that works
      assertStringIncludes(text, "appDir"); // and the other one
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
