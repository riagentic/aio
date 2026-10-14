// `check:orphans` and a lock with no start token; and the shard runtime dirs
// nothing swept.
//
// A lock records its owner's start time, so a pid the system has reused is
// told from the owner. A lock WITHOUT one — written before 1.0.19, or by hand
// as a test fixture — was judged by "the pid is alive", and whatever had that
// pid since was reported as a live aio ORPHAN: seen on Windows naming
// `dllhost.exe` and `msedge.exe`, and `clean:tmp` SIGTERMs what this reports.
// Such a lock is judged by what the process IS, with the decider
// `am kill --stale` uses; one that cannot be judged is said, not signalled.
//
// The real script, against a throwaway root (`AIO_ORPHANS_LOCK_ROOTS`).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { markShardRuntime } from "../scripts/test-shards.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const OLD = new Date(Date.now() - 60 * 60_000);
const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);

async function run(
  root: string,
  ...args: string[]
): Promise<{ code: number; text: string }> {
  return await runWith({}, root, ...args);
}

async function runWith(
  env: Record<string, string>,
  root: string,
  ...args: string[]
): Promise<{ code: number; text: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}scripts/check-orphans.ts`, ...args],
    cwd: root,
    env: {
      AIO_ORPHANS_LOCK_ROOTS: root,
      AIO_TEST_ROOT: join(root, "test-root"),
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    text: new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr),
  };
}

/** A tokenless lock for `pid` in its own scoped lock dir under `root`. */
async function tokenlessLock(
  root: string,
  appId: string,
  pid: number,
): Promise<string> {
  const dir = join(root, `aio-${appId}`);
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, `${appId}.lock`);
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      appId,
      pid,
      port: 0,
      status: "started",
      cwd: root,
      home: root,
      startedAt: Date.now() - 5 * 60 * 60_000,
    }),
  );
  await Deno.utime(dir, OLD, OLD);
  return path;
}

Deno.test({
  name:
    "check-orphans: a lock with no start token whose pid is now another program is a stale lock — never an ORPHAN, never signalled",
  fn: async () => {
    const root = await tempDir("orphans-tokenless-");
    // The process that "has the pid now": not aio, by any reading.
    const stranger = (Deno.build.os === "windows"
      ? new Deno.Command("ping", {
        args: ["-n", "600", "127.0.0.1"],
        stdout: "null",
      })
      : new Deno.Command("sleep", { args: ["600"] })).spawn();
    try {
      const lock = await tokenlessLock(root, "reused", stranger.pid);
      const report = await run(root);
      assert(
        !report.text.includes(`ORPHAN  pid ${stranger.pid} `),
        `a reused pid was reported as a live aio app:\n${report.text}`,
      );
      assertEquals(report.code, 0, report.text);
      assertStringIncludes(
        report.text,
        "stale lock (no start token; its pid was reused)  reused",
      );
      assertStringIncludes(report.text, "is not an aio process");
      assertStringIncludes(report.text, `lock: ${lock}`);
      // `clean:tmp` signals what the report names: the stranger lives on.
      await run(root, "--clean");
      Deno.kill(stranger.pid, 0);
    } finally {
      stranger.kill("SIGKILL");
      await stranger.status;
      await dropTempDir(root);
    }
  },
});

Deno.test("check-orphans: a lock with no start token whose pid IS a deno process is still an ORPHAN", async () => {
  // The control: the rule above must not turn every old lock into "stale".
  const root = await tempDir("orphans-tokenless-live-");
  const app = new Deno.Command(Deno.execPath(), {
    args: ["eval", `console.log("up"); setInterval(() => {}, 1e6);`],
    stdout: "piped",
  }).spawn();
  try {
    const r = app.stdout.getReader();
    assertEquals(new TextDecoder().decode((await r.read()).value).trim(), "up");
    await r.cancel();
    await tokenlessLock(root, "left-running", app.pid);
    const report = await run(root);
    assertStringIncludes(report.text, `ORPHAN  pid ${app.pid}  left-running`);
    assertEquals(report.code, 1, report.text);
  } finally {
    app.kill("SIGKILL");
    await app.status;
    await dropTempDir(root);
  }
});

// The other side of that control. A test that needs "a lock with a live
// owner" writes one with its own pid — the am stop-all tests do — and that
// owner is a test RUNNER (`deno test …`), not an app: an old lock of it, with
// no parent to vouch for it, is no ORPHAN. Read from the runner's command
// line (`cmdlineOf`: /proc, and the process listing where there is none).
Deno.test("check-orphans: an old lock whose owner is a test runner is a fixture, never an ORPHAN", async () => {
  const root = await tempDir("orphans-runner-fixture-");
  try {
    await tokenlessLock(root, "runner-fixture", Deno.pid);
    const report = await run(root);
    assert(!report.text.includes("ORPHAN"), report.text);
    assertEquals(report.code, 0, report.text);
  } finally {
    await dropTempDir(root);
  }
});

// The suite runner gives each shard a runtime dir of its own
// (`/tmp/xdg-shard-XXXX`, `%TEMP%\xdg-shard-XXXX`) and removes it when the
// shard ends. A run that was KILLED never does, and nothing else looked: not
// the lock scan (the dir is not named `aio*`), not the temp sweep (not
// `aio-*`) — and on Windows not at all (the sweep walked a literal `/tmp`).
//
// A LIVE run's is told by what its runner wrote into it (`markShardRuntime`):
// the one signal every OS can read — Windows shows nobody another process's
// environment, which is all a shard's children carry the dir in.
const MID = new Date(Date.now() - 30 * 60_000);
const RUN_BEGAN = Date.now() - 45 * 60_000;

Deno.test("check-orphans: a dead run's xdg-shard-* dir is counted and swept by clean:tmp; a live run's, and a stranger's dir, are left", async () => {
  const root = await tempDir("orphans-xdg-");
  const dead = join(root, "xdg-shard-dead0001");
  const live = join(root, "xdg-shard-live0001");
  const other = join(root, "someone-elses-dir");
  // Under the test root: one a test of the live run made (touched since the
  // run began, on nobody's command line), one from before it.
  const mine = join(root, "test-root", "fixture-of-the-live-run");
  const older = join(root, "test-root", "left-by-an-earlier-run");
  for (const d of [dead, live, other, mine, older]) {
    await Deno.mkdir(join(d, "aio-scope"), { recursive: true });
  }
  // The live run's runner is this process; the dead run's is no process.
  markShardRuntime(live, RUN_BEGAN);
  await Deno.writeTextFile(
    join(dead, ".run-owner"),
    JSON.stringify({ pid: 2 ** 22 + 7, startedAt: RUN_BEGAN }),
  );
  for (const d of [dead, live, other, older]) await Deno.utime(d, OLD, OLD);
  await Deno.utime(mine, MID, MID);
  try {
    const report = await run(root);
    assertStringIncludes(report.text, "2 ownerless temp dir(s)");
    assertEquals(report.code, 0, report.text);
    const cleaned = await run(root, "--clean");
    assertEquals(await exists(dead), false, cleaned.text);
    assertEquals(await exists(older), false, cleaned.text);
    assertEquals(await exists(live), true, cleaned.text);
    assertEquals(await exists(mine), true, cleaned.text);
    assertEquals(await exists(other), true, cleaned.text);
    assertStringIncludes(cleaned.text, "2 ownerless temp dir(s)");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test({
  name:
    "check-orphans: a temp dir a live process carries in its environment is left by clean:tmp",
  ignore: Deno.build.os === "windows", // Windows shows nobody another process's environment — a live run is told there by its runner's owner file (the test above)
  fn: async () => {
    const root = await tempDir("orphans-env-");
    const live = join(root, "xdg-shard-live0002");
    await Deno.mkdir(live);
    await Deno.utime(live, OLD, OLD);
    // A deno child, as a shard's are — and macOS shows no environment for its
    // own protected binaries (`sleep`), so that prop read as "no live run".
    const shard = new Deno.Command(Deno.execPath(), {
      args: ["eval", `console.log("up"); setInterval(() => {}, 1e6);`],
      env: { XDG_RUNTIME_DIR: live },
      stdout: "piped",
    }).spawn();
    try {
      const r = shard.stdout.getReader();
      assertEquals(
        new TextDecoder().decode((await r.read()).value).trim(),
        "up",
      );
      await r.cancel();
      const cleaned = await run(root, "--clean");
      assertEquals(await exists(live), true, cleaned.text);
      assertStringIncludes(cleaned.text, "0 ownerless temp dir(s)");
    } finally {
      shard.kill("SIGKILL");
      await shard.status;
      await dropTempDir(root);
    }
  },
});

// With no live set every temp dir reads as ownerless — a live run's among
// them. The script then says so and touches nothing: exit 2, on every OS.
Deno.test("check-orphans: when the live processes cannot be read, no temp dir is counted or removed — exit 2", async () => {
  const root = await tempDir("orphans-blind-");
  const dead = join(root, "xdg-shard-dead0003");
  const empty = join(root, "nothing-here");
  await Deno.mkdir(dead);
  await Deno.mkdir(empty);
  await Deno.utime(dead, OLD, OLD);
  // Linux: a /proc that does not hold the script itself. macOS, Windows: no
  // `ps`, no `powershell` to ask.
  const blind: Record<string, string> = Deno.build.os === "linux"
    ? { AIO_ORPHANS_PROC: empty }
    : { PATH: empty };
  try {
    for (const args of [[], ["--clean"]]) {
      const out = await runWith(blind, root, ...args);
      assertEquals(out.code, 2, out.text);
      assertStringIncludes(out.text, "none is counted or removed");
      assert(!out.text.includes("ownerless temp dir(s)"), out.text);
      assertEquals(await exists(dead), true, out.text);
    }
  } finally {
    await dropTempDir(root);
  }
});

// The temp sweep goes by NAME (`aio-*`) and removes recursively; a scoped
// lock dir has that name, and on Windows sits in the very dir it walks.
Deno.test("check-orphans: a lock dir holding a live lock, and the home that lock names, are never swept as ownerless temp dirs", async () => {
  const root = await tempDir("orphans-livelock-");
  const lockDir = join(root, "aio-live-scope");
  const home = join(root, "aio-home-of-the-live-app");
  await Deno.mkdir(lockDir);
  await Deno.mkdir(home);
  await Deno.writeTextFile(join(home, "state.db"), "the app's data");
  // Owned by this process — a test runner, so no ORPHAN and no signal.
  await Deno.writeTextFile(
    join(lockDir, "app.lock"),
    JSON.stringify({
      appId: "app",
      pid: Deno.pid,
      port: 0,
      status: "started",
      cwd: home,
      home,
      startedAt: Date.now(),
    }),
  );
  await Deno.utime(lockDir, OLD, OLD);
  await Deno.utime(home, OLD, OLD);
  try {
    const cleaned = await run(root, "--clean");
    assertEquals(await exists(join(lockDir, "app.lock")), true, cleaned.text);
    assertEquals(await exists(home), true, cleaned.text);
    assertStringIncludes(cleaned.text, "0 ownerless temp dir(s)");
  } finally {
    await dropTempDir(root);
  }
});

// The seam above names the root. Without it the script finds the shared temp
// dir itself — and on Windows looked for a literal `/tmp`, which names
// nothing there: no dir was ever counted or swept.
Deno.test({
  name:
    "check-orphans: on Windows the temp dirs are the ones in %TEMP% — a dead run's xdg-shard-* dir there is counted and swept",
  ignore: Deno.build.os !== "windows", // POSIX keeps them in the machine's own /tmp, which a test must never sweep; %TEMP% is a variable the child can be given
  fn: async () => {
    const root = await tempDir("orphans-wintemp-");
    const dead = join(root, "xdg-shard-dead0004");
    await Deno.mkdir(dead);
    await Deno.utime(dead, OLD, OLD);
    const own = { AIO_ORPHANS_LOCK_ROOTS: "", TEMP: root, TMP: root };
    try {
      const report = await runWith(own, root);
      assertStringIncludes(report.text, "1 ownerless temp dir(s)");
      const cleaned = await runWith(own, root, "--clean");
      assertEquals(await exists(dead), false, cleaned.text);
    } finally {
      await dropTempDir(root);
    }
  },
});

Deno.test("check-orphans: an aio-preload-* dir in the temp dir is some app's window's — never counted, never swept", async () => {
  // Builds before 1.0.17 kept a window's preload there, with nothing that
  // says whose it is: a live window of any aio app on the machine.
  const root = await tempDir("orphans-preload-");
  const preload = join(root, "aio-preload-Ab12Cd");
  await Deno.mkdir(preload);
  await Deno.writeTextFile(join(preload, "preload.cjs"), "// a window's");
  await Deno.utime(preload, OLD, OLD);
  try {
    const cleaned = await run(root, "--clean");
    assertEquals(await exists(preload), true, cleaned.text);
    assertStringIncludes(cleaned.text, "0 ownerless temp dir(s)");
  } finally {
    await dropTempDir(root);
  }
});
