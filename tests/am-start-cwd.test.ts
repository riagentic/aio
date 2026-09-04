// `am start` runs the child WHERE THE RECORD SAYS IT RUNS.
//
// `cmdStart` writes `cwd: projectRoot()` into launch.json and the lock — the
// value `am restart` replays, `foreignCheckout` compares and `am doctor`
// reports — and then spawned the child WITHOUT a cwd, so it inherited am's
// own: `cd src && am start` recorded `<root>` while the process ran from
// `<root>/src`. A relative `--db-path=data.db` or `--tls-cert=certs/x.pem`
// therefore resolved one directory below where every reader of the record
// said it would. Measured before the fix: the child printed the subdirectory.
//
// Driven through a REAL `am` process from a subdirectory: the record and the
// child's `Deno.cwd()` are two facts that only a spawn can put side by side.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lockDir } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP = "cwdprobe";

/** The scoped lock dir `am` will use under `apps` — asked of THE decider
 *  (`lockDir()` keys its cache by AIO_APPS_DIR), so the cleanup removes the
 *  directory am actually wrote, never a guess at its name. */
function scopedLockDir(apps: string): string {
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  try {
    return lockDir();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
}

Deno.test({
  name: "am start: the child's cwd is the cwd the launch record claims",
  ignore: Deno.build.os === "windows", // the detached spawn is sh/nohup here
  fn: async () => {
    const root = await tempDir("aio-am-cwd-");
    const apps = await tempDir("aio-am-cwd-apps-");
    let pid = 0;
    try {
      // A project whose entry says where it runs, then lingers long enough
      // for `am start` to see it alive. `server-only` so a headless box does
      // not refuse the (default electron) client before spawning anything.
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({ title: APP, client: "server-only" }),
      );
      await Deno.mkdir(join(root, "src", "deep"), { recursive: true });
      const entry = join(root, "src", "app.ts");
      await Deno.writeTextFile(
        entry,
        `console.log("CWD=" + Deno.cwd());\n` +
          `await new Promise((r) => setTimeout(r, 1500));\n`,
      );

      // `am start` typed from a SUBDIRECTORY of the project.
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          CONFIG,
          AM,
          "start",
          "--no-wait",
          "--json",
          `--app=${APP}`,
          `--entry=${entry}`,
        ],
        cwd: join(root, "src", "deep"),
        env: {
          ...Deno.env.toObject(),
          AIO_APPS_DIR: apps,
          AIO_AM_NO_DELEGATE: "1",
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(r.stdout);
      const stderr = new TextDecoder().decode(r.stderr);
      assertEquals(r.code, 0, `am start failed:\n${stdout}\n${stderr}`);
      const started = JSON.parse(stdout.trim()) as { pid: number };
      pid = started.pid;

      // What the record says…
      const launch = JSON.parse(
        await Deno.readTextFile(join(apps, APP, "launch.json")),
      ) as { cwd: string };
      assertEquals(
        Deno.realPathSync(launch.cwd),
        Deno.realPathSync(root),
        "the record names the project root — that part was always right",
      );

      // …and where the child actually is.
      const log = join(apps, APP, "logs", "stdout.log");
      let printed: string | undefined;
      for (let i = 0; i < 100 && printed === undefined; i++) {
        const text = await Deno.readTextFile(log).catch(() => "");
        printed = /^CWD=(.*)$/m.exec(text)?.[1];
        if (printed === undefined) await new Promise((r) => setTimeout(r, 50));
      }
      assert(printed !== undefined, `the child never printed its cwd (${log})`);
      assertEquals(
        Deno.realPathSync(printed),
        Deno.realPathSync(launch.cwd),
        "the child runs somewhere other than where the launch record claims " +
          "— a relative --db-path resolves where no am reader will look",
      );
    } finally {
      if (pid > 0) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch {
          // aio-ok: the child lingers 1.5 s and then exits on its own — an
          // already-gone pid is the expected end state, not a failure.
        }
      }
      await Deno.remove(scopedLockDir(apps), { recursive: true }).catch(
        () => {},
      );
      await dropTempDir(apps);
      await dropTempDir(root);
    }
  },
});
