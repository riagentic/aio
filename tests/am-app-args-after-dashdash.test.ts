// `am start … -- <app args>` and `--port=N` on the reading verbs.
//
// A bare `--` ends am's options; what follows is the APP's. Three places did
// not know it: `processPlan` read the first word after `--` as a component
// label (so `am start -- seed.json` was refused), `am start` appended the flags
// it adds (`--port`, `--transport`) AFTER a `--` (so they reached the app as
// arguments and were ignored), and `am restart` appended typed flags after a
// recorded `-- x` (so `am restart --expose` booted unexposed, silently).
//
// And `am status --port=N` / `am logs --port=N` with nothing of ours on N
// answered about the CWD's app — exit 0, "started" — instead of the port named
// (now: status "stopped"; logs falls back to the app's log, with a note).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv, freePort, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { mergeLaunchFlags } from "../src/am/am-cmd-process.ts";
import { buildDenoArgs } from "../src/am/am-launch.ts";
import { processPlan } from "../src/am/am-components.ts";
import { readLaunchInfo } from "../src/server/single-instance-lock.ts";

Deno.test("processPlan: a word after `--` is the app's, never a component", async () => {
  const dir = await tempDir("aio-dashdash-");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertEquals(processPlan(["--", "seed.json"], {}, dir).kind, "single");
    assertEquals(processPlan(["--port=1", "--", "x"], {}, dir).kind, "single");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("buildDenoArgs: a runtime-looking flag after `--` stays the app's", () => {
  const argv = buildDenoArgs("src/app.ts", ["--port=1", "--", "--env-file=x"]);
  assertEquals(argv.slice(argv.indexOf("src/app.ts")), [
    "src/app.ts",
    "--port=1",
    "--",
    "--env-file=x",
  ]);
});

Deno.test("mergeLaunchFlags: typed flags land BEFORE a recorded `--`", () => {
  const m = mergeLaunchFlags(["--cdp", "--", "seed.json"], ["--expose"]);
  assertEquals(m.launch, ["--cdp", "--expose", "--", "seed.json"]);
  assertEquals(m.replayed, ["--cdp", "--", "seed.json"]);
  assertEquals(m.overridden, []);
});

Deno.test("mergeLaunchFlags: a typed `--` list replaces the recorded one", () => {
  const m = mergeLaunchFlags(["--cdp", "--", "a"], ["--", "b"]);
  assertEquals(m.launch, ["--cdp", "--", "b"]);
  assertEquals(m.replayed, ["--cdp"]);
  assertEquals(m.overridden, ["--"]);
});

Deno.test({
  name: "am start --port=N -- args: the port is am's, the args the app's; " +
    "status/logs --port name the port's app",
  async fn() {
    const dir = await makeApp("counter", "am-dashdash-");
    const apps = await tempDir("am-dashdash-apps-");
    const env = {
      ...Deno.env.toObject(),
      ...childEnv({ AIO_APPS_DIR: apps }),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    const dec = new TextDecoder();
    const am = async (...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(dir, "dep", "aio", "src", "am.ts"), ...args],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: r.code,
        out: dec.decode(r.stdout),
        err: dec.decode(r.stderr),
      };
    };
    let pid: number | undefined;
    try {
      const port = freePort();
      const s = await am(
        "start",
        "--client=server-only",
        `--port=${port}`,
        "--json",
        "--wait=60",
        "--",
        "seed.json",
      );
      assertEquals(s.code, 0, s.out + s.err);
      const started = JSON.parse(s.out.trim().split("\n").at(-1)!);
      pid = started.pid;
      assertEquals(started.port, port, "--port landed after `--` and was lost");
      const prev = Deno.env.get("AIO_APPS_DIR");
      Deno.env.set("AIO_APPS_DIR", apps);
      try {
        const flags = readLaunchInfo(started.appId)?.flags ?? [];
        assertEquals(flags.slice(flags.indexOf("--")), ["--", "seed.json"]);
      } finally {
        if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
        else Deno.env.set("AIO_APPS_DIR", prev);
      }

      const empty = freePort();
      // Nothing on the port: status says STOPPED (never the cwd app's
      // "started"); logs still shows the app's log — a crashed app's is the
      // one wanted — and says the port named nothing.
      const st = await am("status", `--port=${empty}`, "--json");
      assertEquals(st.code, 1, st.out + st.err);
      assertEquals(JSON.parse(st.out).status, "stopped", st.out);
      const lg = await am("logs", `--port=${empty}`, "--json");
      assertEquals(lg.code, 0, lg.out + lg.err);
      assertStringIncludes(lg.err, `port ${empty}`);
      const ok = await am("status", `--port=${port}`, "--json");
      assertEquals(ok.code, 0, ok.out + ok.err);
      assertEquals(JSON.parse(ok.out).appId, started.appId);
    } finally {
      await am("stop", "--wait").catch(() => {});
      if (pid) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* gone */ }
      }
      await dropTempDir(apps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
