// The end-of-run lock-dir check (`check:orphans` after a suite) fails on
// every scoped lock dir that appeared since the run began and holds no live
// lock: a creator that did not prune what it made (`pruneAtExit`). A creator
// that has not EXITED yet has not had its turn: a test process still in its
// unload — a loaded box, a shard that had just failed — keeps the lock dir of
// its `apps-<pid>` sandbox until it is gone. The gate read that as "left
// behind" and went red; seconds later the dir was gone (seen under the
// mutation gate's load). So: a dir whose apps root a live process still names
// is waited for, then judged — and one whose root nobody names is red at once.
//
// The real script against a throwaway runtime base (`AIO_ORPHANS_LOCK_ROOTS`).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** A scoped lock dir `aio-<name>` under `base`, registered as serving
 *  `apps`, holding no lock — what a creator leaves until its exit prune. */
async function lockDirFor(base: string, name: string, apps: string) {
  await Deno.mkdir(join(base, ".aio-roots"), { recursive: true });
  await Deno.mkdir(join(base, `aio-${name}`));
  await Deno.writeTextFile(join(base, ".aio-roots", `aio-${name}`), apps);
}

async function endOfRun(base: string): Promise<{ code: number; out: string }> {
  // The suite's start recorded no scoped lock dir: every one here is new.
  await Deno.mkdir(join(base, ".aio"), { recursive: true });
  await Deno.writeTextFile(join(base, ".aio/lock-dirs-baseline.json"), "[]");
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}scripts/check-orphans.ts`],
    cwd: base,
    env: {
      AIO_ORPHANS_LOCK_ROOTS: base,
      AIO_TEST_ROOT: join(base, "test-root"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: o.code, out: dec.decode(o.stdout) + dec.decode(o.stderr) };
}

// Named two ways: by the environment (Linux, macOS show it), and by the
// sandbox's own name, `apps-<pid>` of a live process — the one Windows has,
// where nobody sees another process's environment.
for (const by of ["env", "pid"] as const) {
  Deno.test({
    name:
      `check-orphans: a new lock dir whose apps root a live process still uses is waited for — pruned at its exit, the run is green (named by ${by})`,
    ignore: by === "env" && Deno.build.os === "windows",
    async fn() {
      const base = await tempDir("orphans-fresh-live-");
      // The test process still exiting: it prunes its lock dir (and the
      // registry entry) on the way out.
      const exiting = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `await new Promise((r) => setTimeout(r, 2500));
           Deno.removeSync(${JSON.stringify(join(base, "aio-live"))});
           Deno.removeSync(${
            JSON.stringify(join(base, ".aio-roots", "aio-live"))
          });`,
        ],
        env: by === "env" ? { AIO_APPS_DIR: join(base, "apps-env") } : {},
        stdout: "null",
        stderr: "inherit",
      }).spawn();
      const apps = join(
        base,
        by === "env" ? "apps-env" : `apps-${exiting.pid}`,
      );
      await Deno.mkdir(apps);
      await lockDirFor(base, "live", apps);
      try {
        const r = await endOfRun(base);
        assertEquals(r.code, 0, r.out);
        // Waited for and judged — not skipped as "in use".
        assert(!r.out.includes("not judged"), r.out);
        assertEquals((await exiting.status).code, 0);
      } finally {
        try {
          exiting.kill("SIGKILL");
        } catch { /* aio-ok: it exited on its own */ }
        await exiting.status;
        await dropTempDir(base);
      }
    },
  });
}

/** A pid no process holds: one that just exited. */
async function deadPid(): Promise<number> {
  const p = new Deno.Command(Deno.execPath(), { args: ["eval", ""] }).spawn();
  await p.status;
  return p.pid;
}

Deno.test("check-orphans: a new lock dir whose apps root no live process uses is left behind — red, named", async () => {
  const base = await tempDir("orphans-fresh-dead-");
  const apps = join(base, `apps-${await deadPid()}`);
  await Deno.mkdir(apps);
  await lockDirFor(base, "dead", apps);
  try {
    const r = await endOfRun(base);
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "appeared in the runtime dir");
    assertStringIncludes(r.out, join(base, "aio-dead"));
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("check-orphans: a live process naming apps-12345 does not name apps-1234 — the root is matched whole, red at once", async () => {
  const base = await tempDir("orphans-fresh-prefix-");
  const apps = join(base, `apps-${await deadPid()}`);
  await Deno.mkdir(apps);
  await lockDirFor(base, "dead", apps);
  // A live process whose apps root merely STARTS with the dead dir's.
  const other = new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise((r) => setTimeout(r, 60_000));"],
    env: { AIO_APPS_DIR: `${apps}5` },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  try {
    const t0 = Date.now();
    const r = await endOfRun(base);
    assertEquals(r.code, 1, r.out);
    assert(!r.out.includes("not judged"), r.out);
    assertStringIncludes(r.out, join(base, "aio-dead"));
    const took = Date.now() - t0;
    assert(took < 25_000, `took ${took} ms — waited on another root's process`);
  } finally {
    other.kill("SIGKILL");
    await other.status;
    await dropTempDir(base);
  }
});
