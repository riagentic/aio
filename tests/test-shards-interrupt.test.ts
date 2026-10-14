// Ctrl-C on `deno task test`: the runner's signal handler pruned the shards'
// runtime dirs SYNCHRONOUSLY, while the shards were still alive and holding
// their locks — so every dir was judged live and left behind. The interrupt
// now stops the shards, AWAITS them, then prunes; what a process that
// outlived its shard still holds is returned, to be named.
//
// …and where a shard's lock dirs are NOT in a runtime dir of its own — every
// shard on Windows (`%TEMP%`), the real-window shard anywhere — the interrupt
// pruned and judged none of them: it is told the shards' homes too.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  interruptShards,
  lockDirsOf,
  shardLockBase,
} from "../scripts/test-shards.ts";
import { sleeper } from "./proc-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LOCK = new URL("../src/server/single-instance-lock.ts", import.meta.url)
  .href;

/** A stand-in shard: holds a lock in `runtime` (naming `pid`, default its
 *  own), says `ready`, and runs until killed — unless `exit`. */
async function shard(
  runtime: string,
  apps: string,
  opts: { pid?: number; exit?: boolean; ignoreTerm?: boolean } = {},
): Promise<Deno.ChildProcess> {
  const code = `import { writeLock } from ${JSON.stringify(LOCK)};
writeLock({ appId: "shard-int", pid: ${opts.pid ?? "Deno.pid"}, port: 1,
  startedAt: Date.now(), status: "started", cwd: "/" });
${opts.ignoreTerm ? 'Deno.addSignalListener("SIGTERM", () => {});' : ""}
console.log("ready");
${opts.exit ? "" : "setInterval(() => {}, 1000);"}`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    env: { XDG_RUNTIME_DIR: runtime, AIO_APPS_DIR: apps },
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`shard exited before ready: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return child;
}

type Fixture = {
  runtime: string;
  apps: string;
  /** Where this OS keeps the lock dirs of `apps` (`shardLockBase`). */
  homes: Map<string, string>;
};
async function fixture(): Promise<Fixture> {
  // aio-ok: a runtime dir, short like the runner's own `/tmp/xdg-shard-*`
  const runtime = await Deno.makeTempDir({
    dir: Deno.build.os === "windows" ? undefined : "/tmp",
    prefix: "xdg-int-",
  });
  const apps = join(runtime, "apps");
  return {
    runtime,
    apps,
    homes: new Map([[apps, shardLockBase(runtime, Deno.build.os)]]),
  };
}

Deno.test({
  name: "interruptShards: a live shard is stopped and awaited, THEN pruned",
  async fn() {
    const { runtime, apps, homes } = await fixture();
    const child = await shard(runtime, apps);
    const [base] = [...homes.values()];
    assertEquals(lockDirsOf(base!, apps).length, 1, "the shard holds no lock");
    try {
      const left = await interruptShards(
        new Set([child]),
        new Set([runtime]),
        undefined,
        homes,
      );
      assertEquals(left, []);
      // Windows has no signals: a stopped child reports an exit code only.
      if (Deno.build.os !== "windows") {
        assert((await child.status).signal === "SIGTERM");
      }
      assertEquals(lockDirsOf(base!, apps), [], "its lock dir was not pruned");
      let gone = false;
      try {
        Deno.lstatSync(runtime);
      } catch {
        gone = true;
      }
      assert(gone, `runtime dir left behind: ${runtime}`);
    } finally {
      await child.stdout.cancel().catch(() => {});
      await Deno.remove(runtime, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "interruptShards: what a surviving process still holds is NAMED",
  async fn() {
    const { runtime, apps, homes } = await fixture();
    const [base] = [...homes.values()];
    // The lock names a live process the interrupt does not stop: the shape of
    // an app that outlived its test.
    const app = sleeper();
    const child = await shard(runtime, apps, { pid: app.pid, exit: true });
    try {
      await child.status;
      const left = await interruptShards(
        new Set(),
        new Set([runtime]),
        undefined,
        homes,
      );
      assertEquals([...new Set(left)].length, 1, left.join());
      assert(left[0]!.startsWith(join(base!, "aio")), left[0]);
    } finally {
      app.kill("SIGKILL");
      await app.status;
      await child.stdout.cancel().catch(() => {});
      // Its owner is gone now: the same call leaves nothing behind.
      await interruptShards(new Set(), new Set([runtime]), undefined, homes);
      await Deno.remove(runtime, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("interruptShards: a shard with no runtime dir of its own — its home's lock dirs in the shared base are pruned, a held one named, the base kept", async () => {
  // The base is the session's (here a stand-in): never the run's to remove.
  const base = await tempDir("int-base-");
  const apps = join(base, "apps");
  const homes = new Map([[apps, base]]);
  const dir = join(base, "aio-shard-home");
  await Deno.mkdir(join(base, ".aio-roots"), { recursive: true });
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(base, ".aio-roots", "aio-shard-home"), apps);
  const lock = (pid: number) =>
    Deno.writeTextFile(
      join(dir, "app.lock"),
      JSON.stringify({ appId: "app", pid, port: 1, startedAt: Date.now() }),
    );
  const app = sleeper();
  try {
    await lock(app.pid);
    assertEquals(await interruptShards(new Set(), new Set(), 0, homes), [dir]);
    app.kill("SIGKILL");
    await app.status;
    assertEquals(await interruptShards(new Set(), new Set(), 0, homes), []);
    assertEquals(lockDirsOf(base, apps), [], "the dead lock's dir was left");
    assert((await Deno.stat(base)).isDirectory);
  } finally {
    try {
      app.kill("SIGKILL");
    } catch { /* aio-ok: already stopped above */ }
    await dropTempDir(base);
  }
});

Deno.test({
  name:
    "interruptShards: a shard that ignores SIGTERM is SIGKILLed after the grace",
  ignore: Deno.build.os === "windows", // SIGTERM cannot be ignored on Windows (it is TerminateProcess): there is no grace to outlast
  async fn() {
    const { runtime, apps } = await fixture();
    const child = await shard(runtime, apps, { ignoreTerm: true });
    try {
      const left = await interruptShards(
        new Set([child]),
        new Set([runtime]),
        300,
      );
      assertEquals(left, []);
      assertEquals((await child.status).signal, "SIGKILL");
      let gone = false;
      try {
        Deno.lstatSync(runtime);
      } catch {
        gone = true;
      }
      assert(gone, `runtime dir left behind: ${runtime}`);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* aio-ok: already gone — the case under test */ }
      await child.status;
      await child.stdout.cancel().catch(() => {});
      await Deno.remove(runtime, { recursive: true }).catch(() => {});
    }
  },
});
