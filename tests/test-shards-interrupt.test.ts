// Ctrl-C on `deno task test`: the runner's signal handler pruned the shards'
// runtime dirs SYNCHRONOUSLY, while the shards were still alive and holding
// their locks — so every dir was judged live and left behind. The interrupt
// now stops the shards, AWAITS them, then prunes; what a process that
// outlived its shard still holds is returned, to be named.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { interruptShards } from "../scripts/test-shards.ts";

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

async function fixture(): Promise<{ runtime: string; apps: string }> {
  // aio-ok: a runtime dir, short like the runner's own `/tmp/xdg-shard-*`
  const runtime = await Deno.makeTempDir({ dir: "/tmp", prefix: "xdg-int-" });
  return { runtime, apps: join(runtime, "apps") };
}

Deno.test({
  name: "interruptShards: a live shard is stopped and awaited, THEN pruned",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { runtime, apps } = await fixture();
    const child = await shard(runtime, apps);
    try {
      const left = await interruptShards(new Set([child]), new Set([runtime]));
      assertEquals(left, []);
      assert((await child.status).signal === "SIGTERM");
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
  ignore: Deno.build.os === "windows",
  async fn() {
    const { runtime, apps } = await fixture();
    // The lock names a live process the interrupt does not stop: the shape of
    // an app that outlived its test.
    const app = new Deno.Command("sleep", { args: ["60"] }).spawn();
    const child = await shard(runtime, apps, { pid: app.pid, exit: true });
    try {
      await child.status;
      const left = await interruptShards(new Set(), new Set([runtime]));
      assertEquals(left.length, 1, left.join());
      assert(left[0]!.startsWith(join(runtime, "aio")), left[0]);
    } finally {
      app.kill("SIGKILL");
      await app.status;
      await child.stdout.cancel().catch(() => {});
      await Deno.remove(runtime, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "interruptShards: a shard that ignores SIGTERM is SIGKILLed after the grace",
  ignore: Deno.build.os === "windows",
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
