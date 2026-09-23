// A booting app's lock names NO DOOR, and `am` says so by name.
//
// `am start` files a placeholder lock — `status: "starting"`, `port: 0`, no
// socket — before the child binds anything. Every HTTP verb read that port and
// asked `:0`, so the answer to `am state` during a boot was the runtime's
// "Fetch failed: Requests to port 0 are blocked": true about fetch, silent
// about the app. `am profile` exported `"port": 0` and exited 0, and `am shot`
// told the operator to restart with `--cdp`. Found by the exit-code sweep
// (`am-exit-code-sweep.test.ts`), where `stop` raced `start`'s placeholder.
//
// ONE decider now — `lockHasNoDoor` in am-utils — read by `resolvePort` (every
// verb that asks the app anything), `stop`, `profile`, `shot` and `eval`.
// `stop` keeps its meaning for a booting app: it stops it (SIGTERM to the
// owner), it just no longer asks `:0` for a graceful shutdown first.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lockHasNoDoor, noDoorMessage } from "../src/am/am-utils.ts";
import { stopOne } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const LOCK_MOD = new URL(
  "../src/server/single-instance-lock.ts",
  import.meta.url,
).href;
const APP = "amnodoorapp";

Deno.test("lockHasNoDoor: port 0 with no socket, and only that", () => {
  assertEquals(lockHasNoDoor({ port: 0 }), true, "the start placeholder");
  assertEquals(lockHasNoDoor({ port: 0, socketPath: "" }), true);
  // A UDS-only app's lock says port 0 honestly — it HAS a door, the socket.
  assertEquals(lockHasNoDoor({ port: 0, socketPath: "/run/a.sock" }), false);
  assertEquals(lockHasNoDoor({ port: 8123 }), false);
  assertStringIncludes(
    noDoorMessage("x", { pid: 7, status: "starting" }),
    "still starting (pid 7)",
  );
  // Not starting, still no door: a different sentence, never "starting".
  const odd = noDoorMessage("x", { pid: 7, status: "started" });
  assert(!odd.includes("still starting"), odd);
  assertStringIncludes(odd, "no port or socket");
});

async function denoDirOf(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

Deno.test({
  name: "am: verbs against a booting app say it is starting, never ask :0",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the app
  fn: async () => {
    const base = await tempDir("am-no-door-");
    const cwd = join(base, "cwd");
    for (const d of [cwd, join(base, "home"), join(base, "run")]) {
      await Deno.mkdir(d, { recursive: true, mode: 0o700 });
    }
    const env = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      DENO_DIR: await denoDirOf(),
      HOME: join(base, "home"),
      AIO_APPS_DIR: join(base, "apps"),
      XDG_RUNTIME_DIR: join(base, "run"),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    const sleeper = new Deno.Command("sleep", {
      args: ["300"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      // The placeholder exactly as `am start` files it, written by a child
      // with the verbs' own env so it lands in the lock dir they read.
      const lock = {
        appId: APP,
        pid: sleeper.pid,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd,
      };
      const planted = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          CONFIG,
          `import { writeLock } from ${JSON.stringify(LOCK_MOD)};` +
          `writeLock(${JSON.stringify(lock)});`,
        ],
        clearEnv: true,
        env,
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(planted.success, new TextDecoder().decode(planted.stderr));

      const am = async (...argv: string[]) => {
        const o = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--config",
            CONFIG,
            AM,
            ...argv,
            `--app=${APP}`,
            "--json",
          ],
          cwd,
          clearEnv: true,
          env,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const d = new TextDecoder();
        return {
          code: o.code,
          out: d.decode(o.stdout),
          all: d.decode(o.stdout) + d.decode(o.stderr),
        };
      };

      // Read/drive verbs: exit 1, one {error} doc, "still starting".
      const verbs = [
        ["state"],
        ["dispatch", "counter:inc"],
        ["health"],
        ["surface"],
        ["profile"],
        ["shot"],
      ];
      for (const argv of verbs) {
        const r = await am(...argv);
        const what = `am ${argv.join(" ")}`;
        assertEquals(r.code, 1, `${what}: ${r.all}`);
        assert(!/port 0/i.test(r.all), `${what} asked :0 — ${r.all}`);
        const doc = JSON.parse(r.out) as { error?: string; ok?: boolean };
        assert(doc.ok !== true, `${what}: ${r.out}`);
        assertStringIncludes(doc.error ?? "", `"${APP}" is still starting`);
      }

      // stop: still stops a booting app (its owner gets SIGTERM), exit 0,
      // and never through a fetch to :0.
      const r = await am("stop");
      assertEquals(r.code, 0, r.all);
      assert(!/port 0 are blocked|fetch failed/i.test(r.all), r.all);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        sleeper.status,
        new Promise<null>((ok) => timer = setTimeout(() => ok(null), 5000)),
      ]);
      clearTimeout(timer);
      assert(st !== null, "am stop left the booting app running");
      assertEquals(st.signal, "SIGTERM");
    } finally {
      try {
        sleeper.kill("SIGKILL");
      } catch { /* already stopped by am stop */ }
      await sleeper.status;
      await dropTempDir(base);
    }
  },
});

// The race the sweep hit: `am stop` read `start`'s placeholder while its owner
// was alive, and the owner exited (entry missing) before the stop acted. The
// graceful path then asked `:0`. In-process, because the window is a race a
// subprocess cannot hold open; the lock/runtime dirs are pointed at a temp dir
// first so nothing here can touch a real lock.
Deno.test("am stop: a no-door lock whose owner is gone is named, not fetched", async () => {
  const base = await tempDir("am-no-door-stop-");
  const saved = ["AIO_APPS_DIR", "XDG_RUNTIME_DIR"].map((k) =>
    [k, Deno.env.get(k)] as const
  );
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  Deno.env.set("XDG_RUNTIME_DIR", base);
  try {
    const gone = new Deno.Command("true").spawn();
    await gone.status; // a pid that has exited
    const r = await stopOne({
      appId: APP,
      port: 0,
      pf: {
        appId: APP,
        pid: gone.pid,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd: base,
      },
    }, {});
    assertEquals(r.ok, false);
    const error = r.ok ? "" : r.error;
    assert(!/port 0|fetch/i.test(error), error);
    assertStringIncludes(error, `${APP} is not running`);
    assertStringIncludes(error, `pid ${gone.pid}, which has exited`);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(base);
  }
});
