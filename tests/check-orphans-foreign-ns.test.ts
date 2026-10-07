// `check-orphans.ts` judged a lock by `alive(pid)`, ignoring its pid
// namespace. A lock a container wrote (sharing the lock dir) names a pid that
// is a stranger here, so:
//   • a DEAD container's lock whose pid happens to be live here read as an
//     orphaned app — `clean:tmp` would SIGTERM that host process;
//   • a LIVE container's lock whose pid is free here read as dead — `--clean`
//     removed it from under the running app.
// Both are judged the lock module's way now: by the hold file, and a foreign
// owner is never an orphan to signal. Pinned by running the real script against
// a throwaway root (`AIO_ORPHANS_LOCK_ROOTS`), never the machine's real dirs.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownPidNs } from "../src/server/single-instance-lock.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const OLD = new Date(Date.now() - 60 * 60_000);
const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);

async function run(root: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}scripts/check-orphans.ts`, ...args],
    cwd: root,
    env: {
      AIO_ORPHANS_LOCK_ROOTS: root,
      AIO_TEST_ROOT: join(root, "test-root"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test({
  name:
    "check-orphans: a foreign-namespace lock is judged by its hold — a live host pid is never reported (signalled), a live container's lock never removed",
  ignore: Deno.build.os !== "linux", // pid namespaces are a Linux kernel feature
  fn: async () => {
    const root = await tempDir("orphans-ns-");
    const dir = join(root, `aio-ns-${crypto.randomUUID().slice(0, 8)}`);
    await Deno.mkdir(dir, { recursive: true });
    // A host process whose pid a dead container's lock happens to name.
    const host = new Deno.Command("sleep", { args: ["600"] }).spawn();
    // A live container's hold, OS-locked for as long as this child lives.
    const holdPath = join(dir, "live.hold");
    const holder = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `const f = Deno.openSync(${JSON.stringify(holdPath)}, ` +
        `{ write: true, create: true }); f.lockSync(true); ` +
        `console.log("held"); setInterval(() => {}, 1e6);`,
      ],
      stdout: "piped",
    }).spawn();
    try {
      const r = holder.stdout.getReader();
      assertEquals(
        new TextDecoder().decode((await r.read()).value).trim(),
        "held",
      );
      // Closed now, not when the child dies: under load the pipe could still
      // be open when the test ends (a leak), and "held" is all it prints.
      await r.cancel();
      const base = {
        port: 0,
        status: "started",
        cwd: root,
        home: root,
        startedAt: Date.now() - 5 * 60 * 60_000,
        ns: ownPidNs()! + 1,
      };
      const deadLock = join(dir, "dead.lock");
      const liveLock = join(dir, "live.lock");
      await Deno.writeTextFile(
        deadLock,
        JSON.stringify({
          ...base,
          appId: "dead",
          pid: host.pid,
          hold: "dead.hold",
        }),
      );
      await Deno.writeTextFile(
        liveLock,
        JSON.stringify({
          ...base,
          appId: "live",
          pid: 2 ** 22 + 7,
          hold: "live.hold",
        }),
      );
      await Deno.utime(dir, OLD, OLD);

      // Report mode: what `--clean` would SIGTERM.
      const report = await run(root);
      assert(
        !report.includes(`ORPHAN  pid ${host.pid} `),
        `a host process was reported (and --clean would signal it) for a dead container's lock:\n${report}`,
      );
      assert(
        !report.includes(`ORPHAN  pid ${2 ** 22 + 7} `),
        `a live container's app was reported as an orphan (its pid is a stranger here):\n${report}`,
      );
      // Debris sweep: the dead container's lock goes, the live one stays.
      const swept = await run(root, "--clean", "--clean-stale");
      assertEquals(
        await exists(liveLock),
        true,
        `a live container's lock was removed:\n${swept}`,
      );
      assertEquals(
        await exists(deadLock),
        false,
        `a dead container's lock was kept:\n${swept}`,
      );
      Deno.kill(host.pid, 0); // still running
    } finally {
      host.kill("SIGKILL");
      await host.status;
      holder.kill("SIGKILL");
      await holder.status;
      await dropTempDir(root);
    }
  },
});
