// `AIO_PARENT_PID` is for the app, not for what the app starts.
//
// The app read the watch from its env and left it there, so every process it
// started inherited it: another aio AppImage opened from inside one took the
// first one's runtime pid (marked as a launcher's) and died when the first
// app quit — even after its own updates. The boot takes both variables out of
// its env; the one child that should keep a launcher's watch, an update's
// successor, is handed it explicitly.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { SLEEP_ARGS } from "./proc-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

Deno.test({
  name:
    "AIO_PARENT_PID: a process the app starts does not inherit it; an update's successor still gets it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("parent-env-");
    const parent = new Deno.Command(Deno.execPath(), {
      args: SLEEP_ARGS,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let app: Deno.ChildProcess | null = null;
    try {
      const entry = join(dir, "app.ts");
      await Deno.writeTextFile(
        entry,
        `import { aio, cell } from "${spec(REPO)}/mod.ts";
import { relaunchOptions } from "${spec(REPO)}/src/server/updates-apply.ts";
const c = cell("c", { state: { n: 1 }, methods: {} });
await aio.run({ cells: [c], appId: "ppenv", persist: false, client: "server-only" });
const o = new Deno.Command(Deno.execPath(), {
  args: ["eval", "console.log(Deno.env.get('AIO_PARENT_PID') ?? '-', Deno.env.get('AIO_PARENT_PID_FROM') ?? '-')"],
  stdout: "piped",
}).outputSync();
console.log("CHILD:" + new TextDecoder().decode(o.stdout).trim());
console.log("RELAUNCH:" + JSON.stringify(relaunchOptions([], "null").env));
`,
      );
      await Deno.mkdir(join(dir, "rt"), { recursive: true, mode: 0o700 });
      app = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(REPO, "deno.json"), entry],
        cwd: dir,
        env: {
          AIO_APPS_DIR: join(dir, "apps"),
          XDG_RUNTIME_DIR: join(dir, "rt"),
          AIO_PARENT_PID: String(parent.pid),
          AIO_PARENT_PID_FROM: "launcher",
          AIO_NO_OPEN: "1",
          NO_COLOR: "1",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let said = "";
      const pump = (s: ReadableStream<Uint8Array<ArrayBuffer>>) =>
        s.pipeThrough(new TextDecoderStream()).pipeTo(
          new WritableStream({ write: (t) => void (said += t) }),
        );
      const done = Promise.all([pump(app.stdout), pump(app.stderr)]);
      for (let i = 0; i < 600 && !said.includes("RELAUNCH:"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(said.includes("RELAUNCH:"), "the app never got there:\n" + said);
      assertEquals(/CHILD:(.*)/.exec(said)?.[1], "- -", said);
      assertEquals(JSON.parse(/RELAUNCH:(.*)/.exec(said)![1]!), {
        AIO_PARENT_PID: String(parent.pid),
        AIO_PARENT_PID_FROM: "launcher",
      });
      app.kill("SIGTERM");
      await app.status;
      await done;
      app = null;
    } finally {
      if (app) {
        app.kill("SIGKILL");
        await app.status;
      }
      parent.kill("SIGKILL");
      await parent.status;
      await dropTempDir(dir);
    }
  },
});
