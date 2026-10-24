// `am start` that ATTACHES to a booting launch, and the launch it attached to
// is not the one that ends up serving.
//
// Two `am start`s at once: the second finds the first's placeholder lock
// (`status: "starting"`, owned by the FIRST am's own pid until its child
// takes it over) and waits on that pid. The first am exits as soon as its app
// is up — so the second saw "its" pid die and said `did not start — the child
// exited`, exit 1, quoting the healthy boot log of the app that WAS running.
// Measured with two concurrent `am start`s on a fresh scaffold.
//
// Held open deterministically here: the attached-to owner is a sleeper; when
// it ends, the real app takes the (now stale) slot. The verdict must be the
// app that serves, exit 0 — the same answer a restart already gives when a
// rival launch wins (`racingPeer`).
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv, makeApp } from "./e2e-app-harness.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";
import { SLEEP_ARGS } from "./proc-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const dec = new TextDecoder();

Deno.test({
  name:
    "am start: attached launch's owner exits, the peer that serves is the verdict",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-attach-peer-");
    const home = await tempDir("am-attach-peer-home-");
    const env = {
      ...Deno.env.toObject(),
      ...childEnv({
        HOME: home,
        AIO_APPS_DIR: join(home, "apps"),
        XDG_RUNTIME_DIR: join(home, "run"),
      }),
      DENO_DIR,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    await Deno.mkdir(join(home, "run"), { recursive: true, mode: 0o700 });
    const amPath = join(dir, "dep", "aio", "src", "am.ts");
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args,
        cwd: dir,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
    let owner: Deno.ChildProcess | null = null;
    let app: Deno.ChildProcess | null = null;
    let am: Deno.ChildProcess | null = null;
    let reader: ReadableStreamDefaultReader<string> | null = null;
    try {
      // Warm the module cache: the app must boot inside the peer grace.
      const warm = await run(["cache", "src/app.ts", amPath]).output();
      assert(warm.success, dec.decode(warm.stderr));
      const st = await run(["run", "-A", amPath, "status", "--json"]).output();
      const appId: string = JSON.parse(dec.decode(st.stdout).trim()).appId;
      assert(appId, dec.decode(st.stdout));

      // The first am's placeholder, as it files it: owned by that am (here a
      // sleeper), with the hand-off secret its child takes the slot over by.
      owner = new Deno.Command(Deno.execPath(), {
        args: SLEEP_ARGS,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const handoff = crypto.randomUUID();
      const lock = {
        appId,
        pid: owner.pid,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd: dir,
        handoff,
      };
      const planted = await run([
        "eval",
        `import { writeLock } from "./dep/aio/src/server/single-instance-lock.ts";` +
        `writeLock(${JSON.stringify(lock)});`,
      ]).output();
      assert(planted.success, dec.decode(planted.stderr));

      // The second `am start` attaches to that placeholder…
      am = run(["run", "-A", amPath, "start", "--json", "--wait=60"]).spawn();
      await new Promise((r) => setTimeout(r, 1500));
      // …the first am's child takes the slot over and serves…
      app = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "src/app.ts"],
        cwd: dir,
        env: { ...env, AIO_LOCK_HANDOFF: handoff },
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      let boot = "";
      reader = app.stdout.pipeThrough(new TextDecoderStream())
        .getReader();
      while (!boot.includes("running (")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("app exited before serving: " + boot);
        boot += value;
      }
      await reader.cancel();
      reader = null;
      // …and the first am, its job done, exits.
      owner.kill("SIGKILL");
      await owner.status;
      owner = null;
      const r = await am.output();
      am = null;
      const out = dec.decode(r.stdout);
      const all = out + dec.decode(r.stderr);
      assertStringIncludes(all, "still starting", "am did not attach: " + all);
      assertEquals(r.code, 0, all);
      const doc = JSON.parse(out.trim().split("\n").at(-1)!);
      assertEquals(doc.status, "started", all);
      assertEquals(doc.pid, app.pid, all);
    } finally {
      if (owner) {
        owner.kill("SIGKILL");
        await owner.status;
      }
      // Every pipe closed on every branch: a failed assertion above must not
      // leave a child's stdout/stderr open (the resource sanitizer).
      if (am) {
        am.kill("SIGKILL");
        await am.output();
      }
      if (reader) await reader.cancel();
      if (app) {
        app.kill("SIGTERM");
        await app.status;
      }
      await dropTempDir(home);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// The same race end to end, and its second window: the rival's placeholder
// filed between this start's singleton look and its own acquire was refused
// as "already running … port 0" (exit 1) for an app still booting. Two
// `am start`s at once, several rounds: both exit 0 naming ONE pid.
Deno.test({
  name: "am start: two at once both report the one app that serves",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-start-pair-");
    const home = await tempDir("am-start-pair-home-");
    await Deno.mkdir(join(home, "run"), { recursive: true, mode: 0o700 });
    const env = {
      ...Deno.env.toObject(),
      ...childEnv({
        HOME: home,
        AIO_APPS_DIR: join(home, "apps"),
        XDG_RUNTIME_DIR: join(home, "run"),
      }),
      DENO_DIR,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    const amPath = join(dir, "dep", "aio", "src", "am.ts");
    const am = async (...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", amPath, ...args],
        cwd: dir,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: r.code,
        out: dec.decode(r.stdout),
        all: dec.decode(r.stdout) + dec.decode(r.stderr),
      };
    };
    try {
      await am("status", "--json"); // warm the module cache
      for (let round = 0; round < 10; round++) {
        const [a, b] = await Promise.all([
          am("start", "--json", "--wait=60"),
          am("start", "--json", "--wait=60"),
        ]);
        const pids = [a, b].map((r) => { // aio-ok: two literal results
          assertEquals(r.code, 0, `round ${round}: ${r.all}`);
          const doc = JSON.parse(r.out.trim().split("\n").at(-1)!);
          assertEquals(doc.status, "started", `round ${round}: ${r.all}`);
          return doc.pid;
        });
        assertEquals(pids[0], pids[1], `round ${round}: two apps`);
        const s = await am("stop", "--json");
        assertEquals(s.code, 0, s.all);
      }
    } finally {
      await am("stop");
      await dropTempDir(home);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
