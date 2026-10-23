// The `--instance` lifecycle, end to end (jot §4/§8/§9, studio §3):
//
//  - `am start` on a running app names the private copy (`fix`);
//  - plain `am instances` lists every `--instance` scope, with `instance` and
//    `startedBy` — a launch am did not make reads `other`, and `am stop` on it
//    says it may have ended a person's window (it does not refuse: frozen);
//  - `am restart` replays the start env that decides where data lives;
//  - `am start --instance=X --fresh` starts from empty data and `am stop`
//    throws exactly that directory away;
//  - the runtime (and so a compiled artifact) takes `--instance` itself.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv, makeApp } from "./e2e-app-harness.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  captureLaunchEnv,
  dropFreshHome,
  envReplay,
  freshHome,
  startedByOf,
  withEnv,
} from "../src/am/am-instance.ts";
import {
  instanceAppsDir,
  instanceNameError,
  instanceOfAppsDir,
} from "../src/server/app-dirs.ts";
import {
  _resetParsedCli,
  declareAppFlags,
  instanceRequest,
  parseCli,
} from "../src/server/aio-cli.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";

const dec = new TextDecoder();

/** Run `fn` with HOME (and so `~/.aio-instances`) at `home`. */
function withHome<T>(home: string, fn: () => T): T {
  const prev = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prev);
  }
}

// ── pure parts ──────────────────────────────────────────────────────────────

Deno.test("startedBy: am only when the record names THIS process", () => {
  const lock = { pid: 100, startToken: "t1" };
  assertEquals(startedByOf(lock, null), "other", "no record: not am's");
  assertEquals(startedByOf(lock, { flags: [] }), "unknown", "pre-pid record");
  assertEquals(
    startedByOf(lock, { flags: [], pid: 100, startToken: "t1" }),
    "am",
  );
  assertEquals(
    startedByOf(lock, { flags: [], pid: 100, startToken: "t0" }),
    "other",
    "a reused pid is another process",
  );
  assertEquals(startedByOf(lock, { flags: [], pid: 7 }), "other");
  assertEquals(
    startedByOf({ pid: 200, supervisor: 100 }, { flags: [], pid: 100 }),
    "am",
    "a dev session's supervisor is the process am launched",
  );
});

Deno.test("start env: data vars replayed, address vars said, secrets never recorded", () => {
  const rec = captureLaunchEnv({
    HOME: "/h",
    XDG_DATA_HOME: "/iso",
    AIO_ANDROID_KEYSTORE_PASSWORD: "s3cret",
  });
  assertEquals(rec.XDG_DATA_HOME, "/iso");
  assertEquals(rec.XDG_CONFIG_HOME, null, "unset is recorded as unset");
  assert(!JSON.stringify(rec).includes("s3cret"), "a secret was recorded");
  const r = envReplay(rec, { HOME: "/other", XDG_CONFIG_HOME: "/c" });
  assertEquals(r.set, { XDG_DATA_HOME: "/iso", XDG_CONFIG_HOME: null });
  assertEquals(r.notReplayed, ["HOME"]);
  assertEquals(envReplay(undefined, {}), { set: {}, notReplayed: [] });
  assertEquals(
    withEnv({ A: "1", XDG_CONFIG_HOME: "/c" }, r.set),
    { A: "1", XDG_DATA_HOME: "/iso" },
  );
});

Deno.test("--instance: a name is one directory segment", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b"]) {
    assert(instanceNameError(bad), `${JSON.stringify(bad)} accepted`);
  }
  assertEquals(instanceNameError("demo"), null);
  withHome("/tmp/h", () => {
    assertEquals(
      instanceAppsDir("demo"),
      join("/tmp/h", ".aio-instances", "demo"),
    );
    assertEquals(
      instanceOfAppsDir(join("/tmp/h", ".aio-instances", "demo")),
      "demo",
    );
    assertEquals(instanceOfAppsDir(join("/tmp/h", "apps")), undefined);
    assertEquals(instanceOfAppsDir(undefined), undefined);
  });
});

Deno.test("--fresh: only that app's fresh home is deleted", async () => {
  const home = await tempDir("am-fresh-drop-");
  try {
    // Synchronous on purpose: `withHome` restores HOME when `fn` returns.
    const has = (p: string) => {
      try {
        Deno.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    };
    withHome(home, () => {
      const mine = freshHome("demo", "app1");
      const theirs = freshHome("demo", "app2");
      const kept = join(instanceAppsDir("demo"), "app1", "state.db");
      for (const f of [join(mine, "data", "x"), join(theirs, "y"), kept]) {
        Deno.mkdirSync(join(f, ".."), { recursive: true });
        Deno.writeTextFileSync(f, "1");
      }
      assert(dropFreshHome("demo", "..")?.includes("refusing"));
      assert(dropFreshHome("demo", "a/b")?.includes("refusing"));
      assertEquals(dropFreshHome("demo", "app1"), null);
      assertEquals(has(mine), false, "fresh home survived");
      assert(has(theirs), "another app's fresh home was deleted");
      assert(has(kept), "the instance's own data was deleted");
      assertEquals(dropFreshHome("demo", "app2"), null);
      assertEquals(
        has(join(instanceAppsDir("demo"), ".fresh")),
        false,
        "the empty .fresh parent stays behind",
      );
      assertEquals(dropFreshHome("demo", "app2"), null, "nothing there: ok");
    });
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("runtime --instance: parsed, validated, claimable", () => {
  _resetParsedCli();
  try {
    parseCli(["--instance=demo"]); // no "unknown flag"
    let threw = false;
    try {
      parseCli(["--instance=.."]);
    } catch (e) {
      threw = String(e).includes("--instance needs a simple name");
    }
    assert(threw, "--instance=.. was accepted");
    withHome("/tmp/h", () => {
      assertEquals(
        instanceRequest(["--port=1", "--instance=a", "--instance=b"]),
        {
          name: "b",
          appsDir: join("/tmp/h", ".aio-instances", "b"),
        },
      );
      assertEquals(instanceRequest(["--", "--instance=a"]), null);
    });
    // An app that already had its own `--instance` keeps it.
    declareAppFlags(["--instance="]);
    assertEquals(instanceRequest(["--instance=a"]), null);
  } finally {
    _resetParsedCli();
  }
});

// ── end to end ──────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The environment of a live Linux process. */
function environOf(pid: number): Record<string, string> {
  const raw = Deno.readTextFileSync(`/proc/${pid}/environ`);
  return Object.fromEntries(
    raw.split("\0").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

Deno.test({
  name:
    "am --instance lifecycle: fresh start, listing, env replay, stop drops it",
  ignore: Deno.build.os !== "linux", // reads /proc/<pid>/environ
  async fn() {
    const dir = await makeApp("counter", "am-instance-life-");
    const home = await tempDir("am-instance-life-home-");
    const xdg1 = join(home, "xdg-start");
    const base = {
      ...Deno.env.toObject(),
      ...childEnv(),
      HOME: home,
      AIO_APPS_DIR: "", // `--instance` yields to an explicit one
      DENO_DIR,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    const am = async (env: Record<string, string>, ...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(dir, "dep", "aio", "src", "am.ts"), ...args],
        cwd: dir,
        env: { ...base, ...env },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: r.code,
        out: dec.decode(r.stdout),
        err: dec.decode(r.stderr),
      };
    };
    const last = (s: string) => JSON.parse(s.trim().split("\n").at(-1)!);
    const pids: number[] = [];
    let human: Deno.ChildProcess | null = null;
    try {
      // Refusals first: --fresh never runs outside a named instance.
      const noInst = await am({}, "start", "--fresh", "--json");
      assertEquals(noInst.code, 1);
      assertStringIncludes(noInst.out, "--fresh needs --instance");
      const onStop = await am({}, "stop", "--instance=t", "--fresh", "--json");
      assertEquals(onStop.code, 1);
      assertStringIncludes(onStop.out, "--fresh is am start's");

      const appId = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")))
        .aio?.appId ?? undefined;
      const s = await am(
        { XDG_DATA_HOME: xdg1, AIO_ANDROID_KEYSTORE_PASSWORD: "s3cret" },
        "start",
        "--instance=t",
        "--fresh",
        "--client=server-only",
        "--json",
      );
      assertEquals(s.code, 0, s.out + s.err);
      const started = last(s.out);
      pids.push(started.pid);
      const id: string = started.appId ?? appId;
      const fresh = withHome(home, () => freshHome("t", id));
      const launch = JSON.parse(
        await Deno.readTextFile(join(fresh, "launch.json")),
      );
      assertEquals(launch.pid, started.pid, "launch.json names the child");
      assertEquals(launch.env.XDG_DATA_HOME, xdg1);
      assert(
        !(await Deno.readTextFile(join(fresh, "launch.json"))).includes(
          "s3cret",
        ),
        "a secret reached launch.json",
      );
      const marker = join(fresh, "marker");
      await Deno.writeTextFile(marker, "kept across a restart");

      // A launch am did NOT make, in another instance — a person's window.
      human = new Deno.Command("sleep", { args: ["60"] }).spawn();
      const humanScope = withHome(home, () => instanceAppsDir("h"));
      await Deno.mkdir(humanScope, { recursive: true });
      const prev = Deno.env.get("AIO_APPS_DIR");
      Deno.env.set("AIO_APPS_DIR", humanScope);
      try {
        writeLock({
          appId: "humans-app",
          pid: human.pid,
          port: freePort(),
          startedAt: Date.now() - 60_000,
          status: "started",
          cwd: home,
        });
      } finally {
        if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
        else Deno.env.set("AIO_APPS_DIR", prev);
      }

      // Plain `am instances` sees both instances, and who started each.
      const list = await am({}, "instances", "--json");
      assertEquals(list.code, 0, list.out + list.err);
      const rows = JSON.parse(list.out) as Record<string, unknown>[];
      const mine = rows.find((r) => r.pid === started.pid);
      assert(mine, `the --instance copy is hidden:\n${list.out}`);
      assertEquals(mine.instance, "t");
      assertEquals(mine.startedBy, "am");
      assertStringIncludes(String(mine.stopWith), "--instance=t");
      const theirs = rows.find((r) => r.appId === "humans-app");
      assert(theirs, list.out);
      assertEquals(theirs.instance, "h");
      assertEquals(theirs.startedBy, "other");
      // …and from inside an instance, only that instance.
      const inside = await am({}, "instances", "--instance=t", "--json");
      assertEquals(
        (JSON.parse(inside.out) as { appId: string }[]).some((r) =>
          r.appId === "humans-app"
        ),
        false,
        "an instance saw another instance",
      );

      // A second start names the private copy — ANOTHER instance name.
      const again = await am(
        {},
        "start",
        "--instance=t",
        "--client=server-only",
        "--json",
      );
      assertEquals(again.code, 1);
      assertStringIncludes(
        last(again.out).fix ?? "",
        "--instance=<a name other than t>",
      );

      // Restart from a shell WITHOUT the start's XDG_DATA_HOME: replayed.
      const r = await am(
        { XDG_DATA_HOME: join(home, "xdg-now") },
        "restart",
        "--instance=t",
        "--json",
      );
      assertEquals(r.code, 0, r.out + r.err);
      assertStringIncludes(
        r.err,
        `replaying the start env — XDG_DATA_HOME=${xdg1}`,
      );
      const back = last(r.out);
      pids.push(back.pid);
      assertEquals(environOf(back.pid).XDG_DATA_HOME, xdg1, "env not replayed");
      assert(await exists(marker), "a restart threw the fresh data away");
      // …and came back ON it: the replayed `--profile=<fresh home>` used to
      // be dropped, relaunching on the scope's default home.
      const after = await am({}, "instances", "--instance=t", "--json");
      assertEquals(
        (JSON.parse(after.out) as { pid: number; home: string }[])
          .find((i) => i.pid === back.pid)?.home,
        fresh,
        after.out,
      );

      // Stop: am's own, and the fresh home goes — that directory only.
      const stop = await am({}, "stop", "--instance=t", "--json");
      assertEquals(stop.code, 0, stop.out + stop.err);
      const st = last(stop.out);
      assertEquals(st.startedBy, "am", stop.out);
      assertEquals(st.freshData, "dropped", stop.out);
      assertEquals(st.note, undefined, "am's own instance got a note");
      assertEquals(await exists(fresh), false, "fresh data survived the stop");
      assert(await exists(withHome(home, () => instanceAppsDir("t"))));

      // A fresh home LEFT by a run that was never stopped: the next
      // `--fresh` start throws it away before it boots.
      await Deno.mkdir(fresh, { recursive: true });
      await Deno.writeTextFile(join(fresh, "stale"), "left behind");
      const s2 = await am(
        {},
        "start",
        "--instance=t",
        "--fresh",
        "--client=server-only",
        "--json",
      );
      assertEquals(s2.code, 0, s2.out + s2.err);
      pids.push(last(s2.out).pid);
      assertEquals(
        await exists(join(fresh, "stale")),
        false,
        "stale data kept",
      );
      const stop2 = await am({}, "stop", "--instance=t", "--json");
      assertEquals(last(stop2.out).freshData, "dropped", stop2.out);

      // Stopping the person's: done (frozen), and SAID.
      const hs = await am(
        {},
        "stop",
        "--instance=h",
        "--app=humans-app",
        "--json",
      );
      assertEquals(hs.code, 0, hs.out + hs.err);
      const hd = last(hs.out);
      assertEquals(hd.startedBy, "other");
      assertStringIncludes(hd.note, "was not started by am");
    } finally {
      await am({}, "stop", "--instance=t").catch(() => {});
      for (const pid of pids) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* aio-ok: already gone */ }
      }
      if (human) {
        try {
          human.kill("SIGKILL");
        } catch { /* aio-ok: stopped by the test */ }
        await human.status;
      }
      await dropTempDir(home);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "runtime --instance: an app started with it runs in that instance's scope",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "rt-instance-");
    const home = await tempDir("rt-instance-home-");
    const env = {
      ...Deno.env.toObject(),
      ...childEnv(),
      HOME: home,
      AIO_APPS_DIR: "",
      DENO_DIR,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    // Started by hand — the way a person (or an artifact) runs it.
    const app = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "src/app.ts",
        "--instance=rt",
        "--client=server-only",
      ],
      cwd: dir,
      env,
      stdout: "null",
      stderr: "piped",
    }).spawn();
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
    try {
      let row: Record<string, unknown> | undefined;
      for (let i = 0; i < 300 && !row; i++) {
        const l = await am("instances", "--instance=rt", "--json");
        row = (JSON.parse(l.out || "[]") as Record<string, unknown>[])
          .find((r) => r.pid === app.pid && r.status === "started");
        if (!row) await new Promise((r) => setTimeout(r, 100));
      }
      assert(row, "the app did not come up in instance rt");
      assertEquals(row.instance, "rt");
      assertEquals(row.startedBy, "other", "a hand launch read as am's");
      assertStringIncludes(
        String(row.home),
        join(home, ".aio-instances", "rt"),
        "its data is not under the instance",
      );
    } finally {
      try {
        app.kill("SIGTERM");
      } catch { /* aio-ok: already gone */ }
      await app.status;
      await app.stderr.cancel().catch(() => {});
      await dropTempDir(home);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
