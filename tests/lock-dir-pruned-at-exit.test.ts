// A scoped (`AIO_APPS_DIR`) lock dir is removed by the process that created
// it, at exit, when nothing is left in it.
//
// Only an app's shutdown pruned it (`pruneLockDir`); `am backup`, `am
// status`, and every test calling `AppLock` in-process created one and left
// it: measured ~5,400 empty `aio-<scope>` dirs in $XDG_RUNTIME_DIR after one
// day of test runs (pre-existing on v1.0.9). Pinned in a child with its own
// XDG_RUNTIME_DIR, so this test cannot add to the real one.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href;

/** The runtime base's entries, minus the root registry (`.aio-roots`). */
function dirsIn(run: string): string[] {
  return [...Deno.readDirSync(run)].map((e) => e.name)
    .filter((n) => n !== ".aio-roots");
}

/** The registry's entries: one per scoped lock dir that still exists. */
function registered(run: string): string[] {
  try {
    return [...Deno.readDirSync(join(run, ".aio-roots"))].map((e) => e.name);
  } catch {
    return [];
  }
}

async function child(dir: string, code: string): Promise<void> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", join(REPO, "deno.json"), code],
    env: {
      XDG_RUNTIME_DIR: join(dir, "run"),
      AIO_APPS_DIR: join(dir, "apps"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!o.success) throw new Error(new TextDecoder().decode(o.stderr));
}

Deno.test({
  name: "lock dir: a creator prunes its empty scoped lock dir at exit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("lockdir-prune-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      // A registry entry whose dir is long gone (a test removed it by hand,
      // never unregistering): the next registration drops it.
      await Deno.mkdir(join(dir, "run", ".aio-roots"), { mode: 0o700 });
      await Deno.writeTextFile(
        join(dir, "run", ".aio-roots", "aio-gone"),
        "/x",
      );
      // Acquired and NEVER released by hand — the exit does both.
      await child(
        dir,
        `const m = await import(${JSON.stringify(MOD)});
         const l = new m.AppLock("p", ${JSON.stringify(join(dir, "apps/p"))});
         if (!(await l.acquire(0)).ok) throw new Error("not acquired");`,
      );
      assertEquals(dirsIn(join(dir, "run")), []);
      assertEquals(registered(join(dir, "run")), []);
      // A record written by hand naming this very process (a test fixture:
      // `writeLock({ pid: Deno.pid })`) dies with it — and the dir with it.
      await child(
        dir,
        `const m = await import(${JSON.stringify(MOD)});
         m.writeLock({ appId: "fx", pid: Deno.pid, port: 1, startedAt: 0,
           status: "started", cwd: "/", home: ${
          JSON.stringify(join(dir, "apps/fx"))
        } });`,
      );
      assertEquals(dirsIn(join(dir, "run")), []);
      assertEquals(registered(join(dir, "run")), []);
      // A read-only visitor (`am status`) creates it too — and prunes it.
      await child(
        dir,
        `const m = await import(${JSON.stringify(MOD)}); m.readLock("p");
         m.lockDir();`,
      );
      assertEquals(dirsIn(join(dir, "run")), []);
      assertEquals(registered(join(dir, "run")), []);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "lock dir: a sibling's lock keeps it — never removed recursively",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("lockdir-keep-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      await child(
        dir,
        `const m = await import(${JSON.stringify(MOD)});
         m.writeLock({ appId: "other", pid: 1, port: 0, startedAt: 0,
           status: "started", cwd: "/", home: ${
          JSON.stringify(join(dir, "apps/other"))
        } });`,
      );
      const left = dirsIn(join(dir, "run"));
      assertEquals(left.length, 1, "the dir holding a lock must stay");
      // Nothing but the lock: the apps root is recorded OUTSIDE the dir
      // (`<base>/.aio-roots/<name>`), so a v1.0.9 app's non-recursive exit
      // prune still empties it.
      assertEquals(
        [...Deno.readDirSync(join(dir, "run", left[0]!))].map((e) => e.name),
        ["other.lock"],
      );
      assertEquals(registered(join(dir, "run")), left);
      assertEquals(
        Deno.readTextFileSync(join(dir, "run", ".aio-roots", left[0]!)),
        join(dir, "apps"),
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// …and when no creator is left to prune it — a test SIGKILLed the child app
// that made it — dropping the test's temp dir removes it, once nothing live
// is in it. This is the net for the whole suite: every test's scratch comes
// from `tempDir()`.
Deno.test({
  name: "lock dir: dropTempDir removes a SIGKILLed child's lock dir",
  ignore: Deno.build.os === "windows",
  async fn() {
    const run = await tempDir("lockdir-run-"); // the fake runtime base
    const scratch = await tempDir("lockdir-drop-");
    const was = Deno.env.get("XDG_RUNTIME_DIR");
    try {
      await Deno.chmod(run, 0o700);
      const c = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          join(REPO, "deno.json"),
          `const m = await import(${JSON.stringify(MOD)});
           const l = new m.AppLock("k", ${
            JSON.stringify(join(scratch, "apps/k"))
          });
           if (!(await l.acquire(0)).ok) throw new Error("not acquired");
           console.log("HELD");
           setInterval(() => {}, 1000);`,
        ],
        env: { XDG_RUNTIME_DIR: run, AIO_APPS_DIR: join(scratch, "apps") },
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const r = c.stdout.getReader();
      let seen = "";
      while (!seen.includes("HELD")) {
        const { value, done } = await r.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      c.kill("SIGKILL"); // no unload: the child cannot prune
      await c.status;
      r.releaseLock();
      await c.stdout.cancel().catch(() => {});
      assertEquals(dirsIn(run).length, 1, "the leak to clean");
      Deno.env.set("XDG_RUNTIME_DIR", run);
      await dropTempDir(scratch);
      assertEquals(dirsIn(run), []);
      assertEquals(registered(run), []);
    } finally {
      if (was === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
      else Deno.env.set("XDG_RUNTIME_DIR", was);
      await dropTempDir(run);
    }
  },
});

// The net under both, at the END of a suite: `check-orphans.ts` fails the
// run on every scoped lock dir that appeared since `--clean-stale` recorded
// the baseline and holds nothing live — except the ones whose recorded apps
// root (`<base>/.aio-roots/<name>`) is gone, which it prunes file by file (a SIGKILLed creator whose test then
// deleted its temp root: no process will ever use that dir again). Only
// there: at runtime a missing root is no proof — an `AIO_APPS_DIR` is often
// created after its lock dir.
Deno.test({
  name:
    "check:orphans: fails on a run's leftover lock dir, sweeps an orphaned one",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const dir = await tempDir("lockdir-gate-");
    // The fake runtime base is SHORT: a socket is bound under it, and under a
    // long HOME/AIO_TEST_ROOT the path would pass the ~108-byte limit.
    // aio-ok: a socket is bound under it — /tmp keeps the path under the limit
    const run = await Deno.makeTempDir({ dir: "/tmp", prefix: "aio-rt-" });
    let sock: Deno.Listener | undefined;
    try {
      const cwd = join(dir, "cwd");
      await Deno.mkdir(cwd);
      const gate = (...args: string[]) =>
        new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", join(REPO, "scripts/check-orphans.ts"), ...args],
          cwd,
          env: {
            XDG_RUNTIME_DIR: run,
            AIO_ORPHANS_LOCK_ROOTS: run, // never the real /tmp
            AIO_TEST_ROOT: join(dir, "tr"),
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const start = await gate("--clean-stale");
      assert(start.success, new TextDecoder().decode(start.stderr));
      const gone = new Deno.Command("true").spawn();
      await gone.status;
      const mk = async (name: string, root: string) => {
        await Deno.mkdir(join(run, name));
        await Deno.mkdir(join(run, ".aio-roots"), { recursive: true });
        await Deno.writeTextFile(join(run, ".aio-roots", name), root);
        await Deno.writeTextFile(
          join(run, name, "x.lock"),
          JSON.stringify({ appId: "x", pid: gone.pid, port: 0 }),
        );
      };
      await Deno.mkdir(join(dir, "still-here"));
      await mk("aio-orphan", join(dir, "deleted-root"));
      await mk("aio-rooted", join(dir, "still-here"));
      // Root gone, no live LOCK — but a `singleton: false` app (no lock at
      // all) is bound to a socket in it. The sweep was a recursive remove
      // after a lock-only check and deleted that live socket.
      await mk("aio-sockd", join(dir, "deleted-root"));
      sock = Deno.listen({
        transport: "unix",
        path: join(run, "aio-sockd", "s.sock"),
      });
      const end = await gate();
      const out = new TextDecoder().decode(end.stdout) +
        new TextDecoder().decode(end.stderr);
      assertEquals(end.code, 1, out);
      assertStringIncludes(out, join(run, "aio-rooted"));
      assert(!out.includes(join(run, "aio-orphan")), out);
      assertEquals(dirsIn(run).sort(), ["aio-rooted", "aio-sockd"]);
      assertEquals(
        [...Deno.readDirSync(join(run, "aio-sockd"))].map((e) => e.name),
        ["s.sock"],
        "only the dead lock goes; the live socket keeps the dir",
      );
      assertEquals(registered(run).sort(), ["aio-rooted", "aio-sockd"]);
    } finally {
      sock?.close();
      await dropTempDir(dir);
      await Deno.remove(run, { recursive: true }); // made above
    }
  },
});

// "Did this process create it?" must be asked of the dir `lockDir()` actually
// chose. When the preferred `aio-<scope>` is unusable, the private
// `aio-u<uid><scope>` fallback is used — and the check looked at the
// preferred path, found it "existing", and never pruned the fallback it made.
Deno.test({
  name: "lock dir: a fallback aio-u<uid> dir this process made is pruned too",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("lockdir-fb-");
    try {
      const run = join(dir, "run");
      await Deno.mkdir(run, { mode: 0o700 });
      const scope = "-" +
        join(dir, "apps").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
          .slice(-48);
      // A FILE where the preferred dir would go: unusable, so the fallback.
      await Deno.writeTextFile(join(run, "aio" + scope), "not a dir");
      await child(
        dir,
        `const m = await import(${JSON.stringify(MOD)});
         if (!m.lockDir().includes("aio-u")) throw new Error(m.lockDir());`,
      );
      assertEquals(dirsIn(run), ["aio" + scope]);
      assertEquals(registered(run), []);
    } finally {
      await dropTempDir(dir);
    }
  },
});
