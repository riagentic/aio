// AIO_PARENT_PID end to end, on a real server process.
//
//  - a parent that dies takes the app with it (the orphan rule: a launcher
//    killed by `timeout` must not leave its app serving), lock released;
//  - a value that is no pid (`0x10`, `$PPID` unexpanded) was dropped in
//    silence: the launcher asked for "die with me" and got an orphan. Now
//    the boot says so.
import "./store-sandbox.ts";
import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { SLEEP_ARGS } from "./proc-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const APP = "ppwatch";

async function boot(dir: string, parent: string) {
  const entry = join(dir, "app.ts");
  await Deno.writeTextFile(
    entry,
    `import { aio, cell } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: {} });
await aio.run({ cells: [c], appId: "${APP}", persist: false, client: "server-only" });
`,
  );
  await Deno.mkdir(join(dir, "rt"), { recursive: true, mode: 0o700 });
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), entry],
    cwd: dir,
    env: {
      AIO_APPS_DIR: join(dir, "apps"),
      XDG_RUNTIME_DIR: join(dir, "rt"),
      AIO_PARENT_PID: parent,
      AIO_NO_OPEN: "1",
      NO_COLOR: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Both streams, until the boot report's "running (" line.
  let said = "";
  const pump = (s: ReadableStream<Uint8Array<ArrayBuffer>>) =>
    s.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({ write: (t) => void (said += t) }),
    );
  const done = Promise.all([pump(child.stdout), pump(child.stderr)]);
  for (let i = 0; i < 600 && !said.includes("running ("); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(said.includes("running ("), "app never served:\n" + said);
  return { child, said: () => said, done };
}

Deno.test({
  name: "AIO_PARENT_PID: the app stops when its parent dies",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("parent-watch-");
    const parent = new Deno.Command(Deno.execPath(), {
      args: SLEEP_ARGS,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let app: Awaited<ReturnType<typeof boot>> | null = null;
    try {
      app = await boot(dir, String(parent.pid));
      parent.kill("SIGKILL");
      await parent.status;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        app.child.status,
        new Promise<null>((ok) => timer = setTimeout(() => ok(null), 10_000)),
      ]);
      clearTimeout(timer);
      assert(st !== null, "orphaned app kept running:\n" + app.said());
      await app.done;
      assertStringIncludes(app.said(), "is gone (AIO_PARENT_PID)");
      app = null;
    } finally {
      try {
        parent.kill("SIGKILL");
      } catch { /* aio-ok: killed by the test */ }
      await parent.status;
      if (app) {
        app.child.kill("SIGTERM");
        await app.child.status;
        await app.done;
      }
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "AIO_PARENT_PID that is no pid is said, never dropped in silence",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("parent-watch-bad-");
    let app: Awaited<ReturnType<typeof boot>> | null = null;
    try {
      app = await boot(dir, "0x10");
      assertStringIncludes(
        app.said(),
        'AIO_PARENT_PID="0x10" is not a process id',
      );
      assertStringIncludes(app.said(), "will NOT stop");
    } finally {
      if (app) {
        app.child.kill("SIGTERM");
        await app.child.status;
        await app.done;
      }
      await dropTempDir(dir);
    }
  },
});
