// `am stop` under a supervisor.
//
// The generated unit carries `Restart=always` so an update's clean exit 0
// brings the new build up, and `RestartPreventExitStatus=143` so `aio.stop()`
// stays down. A stop asked through the control door (`am stop`) exited 0 —
// the supervisor started the app again a moment after `am stop` printed
// "stopped". That is what a service under the unit aio generated through
// 1.0.19 does (its `shutdown` is `stopProcess(0, …)`, and today's unit is the
// same text), so `AIO_SUPERVISED=1` alone keeps doing it: an app that came
// back after `am stop` may not stay down because aio was upgraded. The stop
// that holds is opt-in — `AIO_STOP_STAYS_DOWN=1` beside it, which the launchd
// agent and the Windows task script (both new in 1.0.20) set and the systemd
// unit offers as a comment: then it leaves with 143.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { _controlStopExitCode } from "../src/server/aio-server.ts";
import { STOP_EXIT_CODE } from "../src/server/aio-lifecycle.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "mod.ts")).href;

Deno.test("control-door stop: the exit-code table", () => {
  assertEquals(_controlStopExitCode("am stop", true, false), STOP_EXIT_CODE);
  // Not supervised: byte-for-byte what every release did.
  assertEquals(_controlStopExitCode("am stop", false, false), 0);
  // A takeover's successor is already running — 0, supervised or not.
  assertEquals(_controlStopExitCode("takeover", true, false), 0);
  // The dev supervisor reads any other code as a failed relaunch.
  assertEquals(_controlStopExitCode("am stop", true, true), 0);
});

/** Boot a real app, ask it to stop through the door, return its exit code. */
async function stopThroughDoor(
  supervised: boolean,
  staysDown = false,
  /** Extra `aio.run` options, spliced in as source. */
  extra = "",
): Promise<number> {
  const dir = await tempDir("stop-sup-");
  try {
    const port = freePort();
    await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "stopsup", cells: [c]${extra} });
`,
    );
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: join(dir, "home"),
      USERPROFILE: join(dir, "home"),
      XDG_RUNTIME_DIR: join(dir, "run"),
      AIO_APPS_DIR: join(dir, "apps"),
      NO_COLOR: "1",
      AIO_NO_OPEN: "1",
    };
    for (const k of ["SystemRoot", "TEMP", "TMP", "TMPDIR", "DENO_DIR"]) {
      const v = Deno.env.get(k);
      if (v) env[k] = v;
    }
    if (supervised) env.AIO_SUPERVISED = "1";
    if (staysDown) env.AIO_STOP_STAYS_DOWN = "1";
    const proc = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        "app.ts",
        `--port=${port}`,
        "--client=server-only",
      ],
      cwd: dir,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const dec = new TextDecoder();
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) log += dec.decode(chunk);
    };
    const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    let exited: Deno.CommandStatus | null = null;
    const status = proc.status.then((s) => exited = s);
    try {
      const keyFile = join(dir, "apps", "stopsup", "data", "control.key");
      const deadline = Date.now() + 60_000;
      let stopped = false;
      while (!stopped) {
        assert(!exited, `the app exited before it was asked to stop:\n${log}`);
        assert(Date.now() < deadline, `the app never came up:\n${log}`);
        try {
          const key = (await Deno.readTextFile(keyFile)).trim();
          const r = await fetch(
            `http://127.0.0.1:${port}/__aio/trojan/shutdown`,
            { method: "POST", headers: { "X-AIO": "1", "X-Aio-Control": key } },
          );
          await r.body?.cancel();
          stopped = r.ok;
        } catch {
          // not listening yet — the loop is the wait
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 100));
      }
      const s = await status;
      await pumps;
      assert(log.includes("stop requested over the control API"), log);
      return s.code;
    } finally {
      if (!exited) {
        proc.kill("SIGKILL");
        await status;
        await pumps;
      }
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("am stop under AIO_SUPERVISED=1 exits 0, as on 1.0.19 — the generated unit's Restart=always brings the app back", async () => {
  assertEquals(await stopThroughDoor(true), 0);
});

Deno.test("am stop under AIO_SUPERVISED=1 with AIO_STOP_STAYS_DOWN=1 exits 143 — the supervisor leaves it down; the switch alone does nothing", async () => {
  assertEquals(await stopThroughDoor(true, true), STOP_EXIT_CODE);
  assertEquals(await stopThroughDoor(false, true), 0);
});

Deno.test("am stop with no supervisor still exits 0", async () => {
  assertEquals(await stopThroughDoor(false), 0);
});

// A stray error WHILE stopping — an `onStop` that leaves a rejection or a
// timer that throws, after the crash handler is uninstalled in Phase 3 — went
// to Deno's default: exit 1. Under `Restart=always` with
// `RestartPreventExitStatus=143`, that brought back the app `am stop` was told
// would stay down, and cut the remaining phases short. The stop's own exit
// code stands (a stray error is logged); a stop that chose 0 still reports 1.
Deno.test("AIO_STOP_STAYS_DOWN=1: a stray rejection or throw during the stop keeps exit 143; without it the stop still exits 1", async () => {
  const reject = `, onStop() { Promise.reject(new Error("late-reject")); }`;
  const thrown =
    `, onStop() { setTimeout(() => { throw new Error("late-throw"); }, 0); ` +
    `return new Promise((r) => setTimeout(r, 50)); }`;
  assertEquals(await stopThroughDoor(true, true, reject), STOP_EXIT_CODE);
  assertEquals(await stopThroughDoor(true, true, thrown), STOP_EXIT_CODE);
  assertEquals(await stopThroughDoor(true, false, reject), 1);
});
