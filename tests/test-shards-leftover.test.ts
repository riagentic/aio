// "A process outlived its test" is a RED shard — whatever the suite says.
//
// The runner removes each shard's private runtime dir when the shard exits,
// and a lock dir something live still holds is what a leaked process looks
// like from outside. That finding was downgraded to a `WARN` line in the shard
// LOG whenever the suite itself was green (`if (suiteClean) left = []`) —
// which is exactly when it is the only sign: a planted leak failed the 1.0.14
// runner and passed this one. A gate that cannot go red is worse than none.
//
// So: the wait is bounded and patient (a child that is still shutting down is
// not a leak), what is left after it fails the shard, the console names it,
// and the `✓`/`✗` beside a shard and the run's last line are one verdict.
//
// The real-window shard has no private runtime dir (its Electron needs the
// session's), and was not judged at all: the one shard every Electron and
// Chromium test runs in could leave an app running under a green ✓. It is
// judged by the lock dirs of ITS apps root — in a dir the developer's own
// apps hold locks in too, so what is not this shard's is never counted and
// never touched.
//
// And a green summary is not "every file ran": a file that calls
// `Deno.exit(0)` at top level, or registers no test, passed with 0 tests.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";
import {
  heldLockEntries,
  leftoverFailure,
  lockDirsOf,
  settleHomeLockDirs,
  settleShardRuntime,
  shardLockBase,
  shardPassed,
} from "../scripts/test-shards.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const LOCK = new URL("../src/server/single-instance-lock.ts", import.meta.url)
  .href;

/** A child holding an app lock in `runtime` — until killed, or for `ms`.
 *  `apps` is its `AIO_APPS_DIR` ("" for none: the shared, unscoped dir). */
async function holder(
  runtime: string,
  ms?: number,
  apps = join(runtime, "apps"),
  appId = "myapp",
  // The session's temp dir — where Windows keeps lock dirs whatever
  // `XDG_RUNTIME_DIR` says.
  session = runtime,
): Promise<Deno.ChildProcess> {
  const code = `import { writeLock } from ${JSON.stringify(LOCK)};
writeLock({ appId: ${JSON.stringify(appId)}, pid: Deno.pid, port: 1,
  startedAt: Date.now(), status: "started", cwd: "/" });
console.log("ready");
setTimeout(() => Deno.exit(0), ${ms ?? 600_000});`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    // The base `lockDir()` reads: `$XDG_RUNTIME_DIR`, `%TEMP%` on Windows.
    env: {
      XDG_RUNTIME_DIR: runtime,
      ...(Deno.build.os === "windows" ? { TEMP: session, TMP: session } : {}),
      ...(apps ? { AIO_APPS_DIR: apps } : {}),
    },
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited before ready: ${text}`);
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return child;
}

const runtimeDir = () =>
  // aio-ok: a runtime dir, short like the runner's own `/tmp/xdg-shard-*`
  Deno.makeTempDir({
    dir: Deno.build.os === "windows" ? undefined : "/tmp",
    prefix: "xdg-left-",
  });

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

Deno.test("settleShardRuntime: a lock a LIVE process holds is still there after the wait, and named", async () => {
  const runtime = await runtimeDir();
  const child = await holder(runtime);
  try {
    const s = await settleShardRuntime(runtime, 3, 20);
    assertEquals(s.left.length, 1, JSON.stringify(s));
    // The dir AND what is in it: the lock's name is the appId.
    assertStringIncludes(s.left[0]!, join(runtime, "aio-"));
    assertStringIncludes(s.left[0]!, "myapp.lock");
    assertEquals(s.first, s.left);
    assert(await exists(runtime), "a held runtime dir must be left to find");
    // …and that is a failure line and a failed shard, with a green suite.
    const line = leftoverFailure(runtime, s.left);
    assertStringIncludes(line, "a process outlived its test");
    assertStringIncludes(line, "myapp.lock");
    assertEquals(shardPassed({ code: 0, left: s.left.length > 0 }), false);
  } finally {
    child.kill("SIGKILL");
    await child.status;
    assertEquals((await settleShardRuntime(runtime, 3, 20)).left, []);
    assert(!await exists(runtime), "nothing live: the runtime dir goes");
  }
});

Deno.test("settleShardRuntime: a child still shutting down is waited for, not failed — and the wait is on record", async () => {
  const runtime = await runtimeDir();
  const child = await holder(runtime, 400);
  try {
    const s = await settleShardRuntime(runtime, 12, 50);
    assertEquals(s.left, [], "it exited inside the wait");
    assertEquals(s.first.length, 1, "the first look found it held");
    assert(s.waitedMs > 0);
    assert(!await exists(runtime));
    assertEquals(leftoverFailure(runtime, s.left), "");
  } finally {
    await child.status;
  }
});

Deno.test("shardPassed: ONE verdict — a green suite with a leftover is red, a red suite is red", () => {
  assert(shardPassed({ code: 0, left: false }));
  assert(!shardPassed({ code: 0, left: true }));
  assert(!shardPassed({ code: 1, left: false }));
  assert(!shardPassed({ code: 1, left: true }));
  // …and so is a green suite one of whose files never ran.
  assert(shardPassed({ code: 0, left: false, unrun: false }));
  assert(!shardPassed({ code: 0, left: false, unrun: true }));
});

// ── The shard that shares the session's runtime dir ──────────────────

Deno.test("settleHomeLockDirs: only what holds a lock under the shard's OWN home is judged — the session's other apps are not counted, and not touched", async () => {
  const runtime = await runtimeDir();
  const home = join(runtime, "shard-home");
  // The developer's own apps, in the same runtime dir: one under another
  // apps root, one in the shared unscoped dir — and one under a root that
  // only STARTS like the shard's (`…/shard-home2` is not inside
  // `…/shard-home`).
  const theirs = [
    await holder(runtime, undefined, join(runtime, "their-apps"), "theirs"),
    await holder(runtime, undefined, "", "shared"),
    await holder(runtime, undefined, home + "2", "sibling"),
  ];
  const kept = async () =>
    (await Array.fromAsync(Deno.readDir(runtime)))
      .filter((e) => e.name.startsWith("aio")).map((e) => e.name).sort();
  const theirDirs = await kept();
  assertEquals(theirDirs.length, 3, theirDirs.join());
  let mine: Deno.ChildProcess | undefined;
  try {
    assertEquals(lockDirsOf(runtime, home), []);
    const none = new Map<string, string>();
    // Nothing of the shard's: green at once, whatever else is live there.
    const clean = await settleHomeLockDirs(runtime, home, none, 3, 20);
    assertEquals(clean, { left: [], first: [], waitedMs: 0 });

    // The apps root itself, and one inside it: both are the shard's.
    mine = await holder(runtime, undefined, home, "leaked");
    const inner = await holder(runtime, 300, join(home, "nested"), "slow");
    assertEquals(lockDirsOf(runtime, home).length, 2);
    const s = await settleHomeLockDirs(runtime, home, none, 12, 50);
    await inner.status;
    assertEquals(s.first.length, 2, "both were held at the first look");
    assertEquals(s.left.length, 1, JSON.stringify(s));
    assertStringIncludes(s.left[0]!, "leaked.lock");
    for (const other of ["theirs", "shared", "sibling"]) {
      assert(!s.left[0]!.includes(other), s.left[0]);
    }
    assertStringIncludes(
      leftoverFailure(runtime, s.left),
      "a process outlived its test",
    );
    assertEquals(shardPassed({ code: 0, left: s.left.length > 0 }), false);

    // Held when the shard STARTED: an earlier run's, not this shard's…
    const before = await heldLockEntries(runtime, home);
    assertEquals([...before.keys()].map((p) => basename(p)), [
      "leaked.lock",
    ]);
    assertEquals(
      (await settleHomeLockDirs(runtime, home, before, 3, 20)).left,
      [],
    );
    // …unless the lock under that name is no longer the one seen then.
    mine.kill("SIGKILL");
    await mine.status;
    mine = await holder(runtime, undefined, home, "leaked");
    assertEquals(
      (await settleHomeLockDirs(runtime, home, before, 3, 20)).left.length,
      1,
    );
    // Dead: its dir goes. The others' are exactly as they were.
    mine.kill("SIGKILL");
    await mine.status;
    assertEquals(
      (await settleHomeLockDirs(runtime, home, none, 3, 20)).left,
      [],
    );
    assertEquals(lockDirsOf(runtime, home), []);
    assertEquals(await kept(), theirDirs);
  } finally {
    for (const c of [mine, ...theirs]) {
      try {
        c?.kill("SIGKILL");
      } catch { /* aio-ok: already ended */ }
      await c?.status;
    }
    await Deno.remove(runtime, { recursive: true });
  }
});

// ── The runner itself, on a planted leak ─────────────────────────────

/** A throwaway repo root whose `scripts/` and `src/` are THIS checkout's:
 *  the runner derives its root from its own path, so it runs the planted
 *  tests and writes its logs there — never into the real `.aio/`. */
async function plantedRoot(tests: Record<string, string>): Promise<string> {
  const root = await tempDir("aio-shards-e2e-");
  for (const name of ["scripts", "src", "node_modules", "deno.json"]) {
    await Deno.symlink(join(ROOT, name), join(root, name));
  }
  // A COPY: a lock file the nested deno may rewrite must not be the real one.
  await Deno.copyFile(join(ROOT, "deno.lock"), join(root, "deno.lock"));
  await Deno.mkdir(join(root, "tests"));
  // The module the runner preloads into every shard (`--preload`).
  await Deno.copyFile(
    join(ROOT, "tests", "preload-ffi.ts"),
    join(root, "tests", "preload-ffi.ts"),
  );
  for (const [name, src] of Object.entries(tests)) {
    await Deno.writeTextFile(join(root, "tests", name), src);
  }
  return root;
}

async function runShards(
  root: string,
  files: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const base = Deno.env.toObject();
  delete base.AIO_TEST_FENCED; // so AIO_TEST_FREE_CORES is read
  delete base.AIO_TEST_FREE_CORES;
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/test-shards.ts", "--shards=1", ...files],
    cwd: root,
    env: { ...base, NO_COLOR: "1", ...env },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

const CLEAN = `Deno.test("zz clean", () => {});\n`;
/** What a process that outlived its test leaves: a lock dir in the shard's
 *  runtime dir that nothing can judge dead. */
const LEAK = `Deno.test("zz plant: leaves a held lock dir behind", () => {
  const dir = Deno.env.get("XDG_RUNTIME_DIR") + "/aio-leak";
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(dir + "/held", "x");
  console.log("PLANTED_IN " + dir);
});
`;

Deno.test({
  name:
    "test-shards: a green suite that leaves a held lock dir FAILS the shard, on the console",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({ "zz-leak-plant.test.ts": LEAK });
    let planted: string | undefined;
    try {
      const r = await runShards(root, ["tests/zz-leak-plant.test.ts"]);
      const log = await Deno.readTextFile(
        join(root, ".aio", "test-shards", "0.log"),
      );
      planted = /PLANTED_IN (\S+)/.exec(log)?.[1];
      assert(planted, `the planted test did not run:\n${log}\n${r.err}`);
      // The suite itself was green — that is the case that was let through.
      assertStringIncludes(log, "ok | 1 passed | 0 failed");
      assertEquals(r.code, 1, r.out + r.err);
      // One verdict: ✗ beside the shard, and no "all shards passed" under it.
      assertStringIncludes(r.out, "✗ shard 0");
      assert(!r.out.includes("✓"), r.out);
      // Named where a person looks: the console, with the dir and its entry.
      assertStringIncludes(r.err, "1 shard(s) failed");
      assertStringIncludes(r.err, "a process outlived its test");
      assertStringIncludes(r.err, `${planted} [held]`);
      assertStringIncludes(log, "FAILED | shard runtime dir");
    } finally {
      // The runner leaves a held runtime dir for check:orphans — on purpose.
      // This one is the plant's.
      if (planted) {
        await Deno.remove(join(planted, ".."), { recursive: true })
          .catch(() => {});
      }
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "test-shards: a clean shard prints ✓ and the run ends ✓; AIO_TEST_FREE_CORES=abc is refused",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({ "zz-clean.test.ts": CLEAN });
    try {
      const ok = await runShards(root, ["tests/zz-clean.test.ts"]);
      assertEquals(ok.code, 0, ok.out + ok.err);
      assertStringIncludes(ok.out, "✓ shard 0");
      assertStringIncludes(ok.out, "✓ all 1 shards passed");
      assert(!ok.out.includes("✗"), ok.out);

      // However a file is named — absolute, un-normalised, with a space in
      // its path — it is the file deno ran: each of these ran, passed, and
      // was failed as "never started".
      await Deno.mkdir(join(root, "tests", "sp ace"));
      await Deno.writeTextFile(join(root, "tests", "zz-other.test.ts"), CLEAN);
      await Deno.writeTextFile(
        join(root, "tests", "sp ace", "zz-in.test.ts"),
        CLEAN,
      );
      const named = await runShards(root, [
        join(root, "tests", "zz-clean.test.ts"),
        "tests/../tests/zz-other.test.ts",
        "tests/sp ace/zz-in.test.ts",
      ]);
      assertEquals(named.code, 0, named.out + named.err);
      assertStringIncludes(named.out, "ok | 3 passed | 0 failed");
      assertStringIncludes(named.out, "✓ all 1 shards passed");

      // `Number("abc")` is NaN, which the fence read as "keep one core":
      // a typo took every core but one, silently.
      for (const bad of ["abc", "", "1.5", "-2"]) {
        const r = await runShards(root, ["tests/zz-clean.test.ts"], {
          AIO_TEST_FREE_CORES: bad,
        });
        assert(r.code !== 0, `AIO_TEST_FREE_CORES="${bad}" ran:\n${r.out}`);
        assertStringIncludes(r.err, "AIO_TEST_FREE_CORES");
        assert(!r.out.includes("parallel shards"), "it must not start");
      }
    } finally {
      await dropTempDir(root);
    }
  },
});

/** What makes a planted file a REAL-WINDOW test by the runner's content
 *  rule. Spelled in two halves, like the variable below: this file opens no
 *  window, and must not read as one that does. */
const WINDOW = `// Needs the nested ${"Xe" + "phyr"} display.\n`;
const DISPLAY_VAR = "DIS" + "PLAY";

/** A real-window test that leaves a live app behind: a detached process
 *  holding an app lock. */
const WINDOW_LEAK =
  `${WINDOW}Deno.test("zz window plant: leaves a live app behind", async () => {
  const code = \`import { writeLock } from ${JSON.stringify(LOCK)};
writeLock({ appId: "zzleak", pid: Deno.pid, port: 1,
  startedAt: Date.now(), status: "started", cwd: "/" });
setTimeout(() => Deno.exit(0), 120_000);\`;
  await new Deno.Command("sh", {
    args: ["-c", '"$0" eval "$1" >/dev/null 2>&1 &', Deno.execPath(), code],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  const runtime = Deno.env.get("XDG_RUNTIME_DIR")!;
  for (let i = 0; i < 200; i++) {
    for (const d of Deno.readDirSync(runtime)) {
      try {
        Deno.statSync(runtime + "/" + d.name + "/zzleak.lock");
        return;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the holder never published its lock");
});
`;
const WINDOW_CLEAN = `${WINDOW}Deno.test("zz window clean", () => {});\n`;

Deno.test({
  name:
    "test-shards: the real-window shard is judged too — a live app it left FAILS it, another app in the same runtime dir does not",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({
      "zz-window-leak.test.ts": WINDOW_LEAK,
      "zz-window-clean.test.ts": WINDOW_CLEAN,
    });
    // The session's runtime dir, which this shard inherits — a scratch one,
    // with "the developer's app" already running in it. No display: the
    // runner must not start a nested one for a planted test.
    const runtime = await runtimeDir();
    const env = { XDG_RUNTIME_DIR: runtime, [DISPLAY_VAR]: "" };
    const theirs = await holder(runtime);
    const lockOf = async (name: string) => {
      for await (const d of Deno.readDir(runtime)) {
        const p = join(runtime, d.name, name);
        if (await exists(p)) return p;
      }
    };
    const theirLock = await lockOf("myapp.lock");
    assert(theirLock);
    try {
      const ok = await runShards(root, ["tests/zz-window-clean.test.ts"], env);
      assertStringIncludes(ok.out, "1 real-window tests serialized");
      assertEquals(ok.code, 0, ok.out + ok.err);
      assertStringIncludes(ok.out, "✓ all 1 shards passed");

      const r = await runShards(root, ["tests/zz-window-leak.test.ts"], env);
      const log = await Deno.readTextFile(
        join(root, ".aio", "test-shards", "0.log"),
      );
      assertStringIncludes(r.out, "1 real-window tests serialized");
      assertStringIncludes(log, "ok | 1 passed | 0 failed");
      assertEquals(r.code, 1, r.out + r.err);
      assertStringIncludes(r.out, "✗ shard 0");
      assert(!r.out.includes("✓"), r.out);
      assertStringIncludes(r.err, "a process outlived its test");
      assertStringIncludes(r.err, "[zzleak.lock]");
      assert(!r.err.includes("myapp.lock"), r.err);
      assert(await exists(theirLock), "another app's lock was removed");
    } finally {
      const leak = await lockOf("zzleak.lock");
      if (leak) {
        try {
          Deno.kill(JSON.parse(await Deno.readTextFile(leak)).pid, "SIGKILL");
        } catch { /* aio-ok: it ended by itself */ }
      }
      theirs.kill("SIGKILL");
      await theirs.status;
      await Deno.remove(runtime, { recursive: true });
      await dropTempDir(root);
    }
  },
});

/** A real-window test whose app is still shutting down when the shard
 *  exits: a detached process that keeps its lock until the test process is
 *  gone, and for \`ms\` after. */
const windowSlow = (ms: number) =>
  `${WINDOW}Deno.test("zz window slow: its app is still stopping at exit", async () => {
  const code = \`import { writeLock } from ${JSON.stringify(LOCK)};
writeLock({ appId: "zzslow", pid: Deno.pid, port: 1,
  startedAt: Date.now(), status: "started", cwd: "/" });
const alive = () => new Deno.Command("kill", { args: ["-0", "\${Deno.pid}"],
  stdout: "null", stderr: "null" }).outputSync().success;
const t = setInterval(() => {
  if (alive()) return;
  clearInterval(t);
  setTimeout(() => Deno.exit(0), ${ms});
}, 50);\`;
  await new Deno.Command("sh", {
    args: ["-c", '"$0" eval "$1" >/dev/null 2>&1 &', Deno.execPath(), code],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  const runtime = Deno.env.get("XDG_RUNTIME_DIR")!;
  for (let i = 0; i < 200; i++) {
    for (const d of Deno.readDirSync(runtime)) {
      try {
        Deno.statSync(runtime + "/" + d.name + "/zzslow.lock");
        return;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the holder never published its lock");
});
`;

Deno.test({
  name:
    "test-shards: the real-window shard waits for an app still shutting down (✓, and a NOTE), and does not charge it with what an earlier run left",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({
      "zz-window-slow.test.ts": windowSlow(2500),
      "zz-window-clean.test.ts": WINDOW_CLEAN,
    });
    const runtime = await runtimeDir();
    const env = { XDG_RUNTIME_DIR: runtime, [DISPLAY_VAR]: "" };
    const logOf = () =>
      Deno.readTextFile(join(root, ".aio", "test-shards", "0.log"));
    let earlier: Deno.ChildProcess | undefined;
    try {
      // Held for a while after the shard is gone: asked again, not failed at
      // the first look — and the wait is on record, with the lock's name.
      const slow = await runShards(root, ["tests/zz-window-slow.test.ts"], env);
      const slowLog = await logOf();
      assertStringIncludes(slow.out, "1 real-window tests serialized");
      assertEquals(slow.code, 0, slow.out + slow.err + slowLog);
      assertStringIncludes(slow.out, "✓ all 1 shards passed");
      assertStringIncludes(slowLog, "NOTE | shard runtime dir");
      assertStringIncludes(slowLog, "[zzslow.lock]");
      assert(!slowLog.includes("FAILED |"), slowLog);

      // A live app under this shard's apps root BEFORE the runner starts is
      // an earlier run's: named, and not this shard's failure.
      const home = join(root, ".aio-test-shards", "0", ".aio-test-home");
      earlier = await holder(runtime, undefined, home, "earlier");
      const r = await runShards(root, ["tests/zz-window-clean.test.ts"], env);
      assertStringIncludes(r.err, "already held by a live process");
      assertStringIncludes(r.err, "earlier.lock");
      assertEquals(r.code, 0, r.out + r.err + await logOf());
      assertStringIncludes(r.out, "✓ all 1 shards passed");
    } finally {
      try {
        earlier?.kill("SIGKILL");
      } catch { /* aio-ok: already ended */ }
      await earlier?.status;
      await Deno.remove(runtime, { recursive: true });
      await dropTempDir(root);
    }
  },
});

// ── A green summary over a file that never ran ───────────────────────

Deno.test({
  name:
    "test-shards: a file that exits 0 at top level, or registers no test, FAILS a green shard; an empty file and an all-ignored one do not",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({
      "zz-clean.test.ts": CLEAN,
      // A failing test deno never gets to: the file ends its own isolate.
      "zz-exit0.test.ts":
        `Deno.test("zz never seen", () => { throw new Error("x"); });\nDeno.exit(0);\n`,
      "zz-none.test.ts":
        `if (Deno.env.get("ZZ_NEVER_SET")) Deno.test("zz gated", () => {});\n`,
      "zz-empty.test.ts": "",
      "zz-ignored.test.ts":
        `Deno.test({ name: "zz not here", ignore: true, fn: () => {} });\n`,
    });
    const run = (...names: string[]) =>
      runShards(root, ["zz-clean", ...names].map((n) => `tests/${n}.test.ts`));
    try {
      const ok = await run("zz-empty", "zz-ignored");
      assertEquals(ok.code, 0, ok.out + ok.err);
      assertStringIncludes(ok.out, "✓ all 1 shards passed");

      for (
        const [name, why] of [
          ["zz-exit0", "called Deno.exit(0) outside any test"],
          ["zz-none", "ran 0 tests"],
        ]
      ) {
        const r = await run(name!);
        const log = await Deno.readTextFile(
          join(root, ".aio", "test-shards", "0.log"),
        );
        // deno itself saw nothing wrong — that is the hole.
        assertStringIncludes(log, "ok | 1 passed | 0 failed");
        assertEquals(r.code, 1, r.out + r.err);
        assertStringIncludes(r.out, "✗ shard 0");
        assert(!r.out.includes("✓"), r.out);
        assertStringIncludes(r.err, `tests/${name}.test.ts ${why}`);
        assertStringIncludes(log, "FAILED | 1 test file(s) did not run");
      }
    } finally {
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "test-shards: a DIRECTORY argument is judged file by file — a file with no test under it fails a green shard",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await plantedRoot({ "zz-clean.test.ts": CLEAN });
    try {
      await Deno.mkdir(join(root, "tests", "zzdir"));
      await Deno.writeTextFile(join(root, "tests/zzdir/zz-a.test.ts"), CLEAN);
      const none = join(root, "tests/zzdir/zz-none.test.ts");
      await Deno.writeTextFile(
        none,
        `if (Deno.env.get("ZZ_NEVER_SET")) Deno.test("zz gated", () => {});\n`,
      );
      const red = await runShards(root, ["tests/zzdir"]);
      assertStringIncludes(red.out, "2 test files → 1 parallel shards");
      assertEquals(red.code, 1, red.out + red.err);
      assertStringIncludes(red.err, "tests/zzdir/zz-none.test.ts ran 0 tests");
      // …and with the file gone, the same directory is green.
      await Deno.remove(none);
      const green = await runShards(root, ["tests/zzdir"]);
      assertEquals(green.code, 0, green.out + green.err);
      assertStringIncludes(green.out, "1 test files → 1 parallel shards");
      // The quiet interval is a whole number of milliseconds a timer can
      // hold, or the run refuses — `Infinity` ran as "every millisecond".
      for (
        const bad of [
          "abc",
          "0",
          "-5",
          "",
          "0.5",
          "1.5",
          "Infinity",
          "1e10",
          "2147483648",
          // what `Number()` reads as a whole number, and the flag did not say
          "0x10",
          "1e3",
          "5.0",
          "+5",
        ]
      ) {
        const no = await runShards(root, [`--quiet-ms=${bad}`, "tests/zzdir"]);
        assertEquals(no.code, 1, bad);
        assertStringIncludes(
          no.err,
          `--quiet-ms=${bad} is not a whole number of milliseconds from 1 ` +
            `to 2147483647`,
        );
        assert(!no.out.includes("shard"), no.out);
      }
      // Every occurrence is read — a later bad one is not excused by an
      // earlier good one — and a flag with no value is refused.
      for (
        const args of [["--quiet-ms=5000", "--quiet-ms=abc"], ["--quiet-ms"]]
      ) {
        const no = await runShards(root, [...args, "tests/zzdir"]);
        assertEquals(no.code, 1, args.join(" "));
        assertStringIncludes(
          no.err,
          `${args.at(-1)} is not a whole number of milliseconds from 1 to ` +
            `2147483647`,
        );
        assert(!no.out.includes("shard"), no.out);
      }
      // …and the largest one is taken.
      const most = await runShards(root, [
        "--quiet-ms=2147483647",
        "tests/zzdir",
      ]);
      assertEquals(most.code, 0, most.out + most.err);
      assert(!most.out.includes("no output for"), most.out);
      // The shard count goes through the same reader: `abc` shards planned
      // nothing, and the run died on the empty plan with a TypeError.
      for (const bad of ["abc", "0x", "0", "257"]) {
        const no = await runShards(root, [`--shards=${bad}`, "tests/zzdir"]);
        assertEquals(no.code, 1, bad);
        assertStringIncludes(
          no.err,
          `--shards=${bad} is not a whole number of shards from 1 to 256`,
        );
        assert(!no.err.includes("TypeError"), no.err);
        assert(!no.out.includes("shard"), no.out);
      }
    } finally {
      await dropTempDir(root);
    }
  },
});

// ── A shard's output is on disk while it runs ────────────────────────

Deno.test({
  name:
    "test-shards: a running shard's log already names the file it is in, and a silent one is named on the runner's output — again each interval, never stopped",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // It ends when this test says so: nothing here depends on how long
    // anything takes.
    const root = await plantedRoot({
      "zz-wait.test.ts": `Deno.test("zz waits for the word", async () => {
  for (let i = 0; i < 2400; i++) {
    if (await Deno.stat("zz-go").then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("never told to go");
});
`,
    });
    const base = Deno.env.toObject();
    delete base.AIO_TEST_FENCED;
    delete base.AIO_TEST_FREE_CORES;
    const runner = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "scripts/test-shards.ts",
        "--shards=1",
        "--quiet-ms=1000",
        "tests/zz-wait.test.ts",
      ],
      cwd: root,
      env: { ...base, NO_COLOR: "1" },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let out = "";
    let ended = false;
    const dec = new TextDecoder();
    const reading = (async () => {
      for await (const chunk of runner.stdout) {
        out += dec.decode(chunk, { stream: true });
      }
    })();
    const err = new Response(runner.stderr).text();
    const done = runner.status.then((s) => {
      ended = true;
      return s;
    });
    const until = async (
      what: string,
      ok: () => boolean | Promise<boolean>,
    ) => {
      while (!await ok()) {
        if (ended) throw new Error(`the run ended before ${what}:\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const log = join(root, ".aio", "test-shards", "0.log");
    const HEADER = "running 1 test from ./tests/zz-wait.test.ts";
    try {
      await until(
        "its log named the file",
        () =>
          Deno.readTextFile(log).then((t) => t.includes(HEADER), () => false),
      );
      // On disk — and the shard has not finished: its test is still waiting.
      assert(!(await Deno.readTextFile(log)).includes("ok | 1 passed"));
      assert(!out.includes("shard 0  1 files"), out);
      const said = (): string[] =>
        out.match(/^… shard 0: no output for .*$/gm) ?? [];
      const where = `${HEADER} (still running; its output so far: ` +
        `.aio/test-shards/0.log)`;
      const line = (secs: number) =>
        `… shard 0: no output for ${secs}s — ${where}`;
      // Twice in a row: the silence is counted on, not started over.
      await until(
        "it said twice that the shard is silent",
        () => said().includes(line(2)),
      );
      assertEquals(said()[said().indexOf(line(2)) - 1], line(1));
      // Before the file started — a slow compile — it says that instead.
      for (const l of said()) {
        assert(
          l.endsWith(where) || l.includes("— no test file started yet ("),
          l,
        );
      }
      assert(!ended, "a silent shard was stopped");
    } finally {
      await Deno.writeTextFile(join(root, "zz-go"), "");
      const status = await done;
      await reading;
      try {
        // Told only, never stopped: the test went on and passed.
        assertEquals(status.code, 0, out + await err);
        assertStringIncludes(out, "✓ all 1 shards passed");
        // The finished log is what it always was: the whole output.
        const text = await Deno.readTextFile(log);
        assertStringIncludes(text, HEADER);
        assertStringIncludes(text, "ok | 1 passed | 0 failed");
        assertEquals(text.split(HEADER).length, 2, "written twice");
      } finally {
        await dropTempDir(root);
      }
    }
  },
});

// A shard is judged where its locks ARE. Windows keeps lock dirs in `%TEMP%`
// and never reads `XDG_RUNTIME_DIR`, so a Windows shard's private runtime dir
// stayed empty and was "settled" empty, while the lock dir of its home was
// never pruned: the full suite there ended 6 green shards and a red
// `check:orphans`, on the lock of whichever app a test had stopped hard last
// (`dev-restart-typo-e2e.lock`, `zero-test.lock` + its `watch-<pid>.tmp`,
// `ex-counter.lock`) — the debris a POSIX shard's runtime sweep takes.
Deno.test("shardLockBase: a shard's lock dirs are settled where the lock module puts them — the session's temp dir on Windows, private runtime dir or not", async () => {
  const s = () => "/session";
  assertEquals(shardLockBase("/private", "linux", s), "/private");
  assertEquals(shardLockBase("/private", "darwin", s), "/private");
  assertEquals(shardLockBase("/private", "windows", s), "/session");
  assertEquals(shardLockBase(null, "linux", s), "/session");
  assertEquals(shardLockBase(null, "windows", s), "/session");

  // …and that IS where a child given both lands, on the OS running this.
  const runtime = await runtimeDir();
  const session = await runtimeDir();
  const home = await tempDir("shard-base-home-");
  try {
    const base = shardLockBase(runtime, Deno.build.os, () => session);
    const child = await holder(
      runtime,
      undefined,
      home,
      "hard-stopped",
      session,
    );
    try {
      assertEquals(
        lockDirsOf(base, home).length,
        1,
        "the lock dir is not there",
      );
    } finally {
      child.kill("SIGKILL"); // a hard stop: its lock stays behind
      await child.status;
    }
    // The owner is dead: its lock dir is debris, pruned, and nothing is left.
    const none = new Map<string, string>();
    assertEquals((await settleHomeLockDirs(base, home, none, 3, 20)).left, []);
    assertEquals(lockDirsOf(base, home), []);
    assertEquals(
      [...Deno.readDirSync(base)].filter((e) => e.name.startsWith("aio")),
      [],
    );
  } finally {
    await Deno.remove(runtime, { recursive: true });
    await Deno.remove(session, { recursive: true });
    await dropTempDir(home);
  }
});
