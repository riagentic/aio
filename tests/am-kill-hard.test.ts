// Hard kills that are not said, and what they leave.
//
// On Windows `kill` is TerminateProcess: no handler runs, so `am kill` ended
// an app with no `onStop` and no final flush and printed "killed"; and an
// `am backup` / `am restore` it interrupted could not "remove its partial
// copy", whatever the answer claimed. Now the app is asked first and the
// answer says which happened — and the incomplete copy a KILLED op left is
// removed on the word of its own lock: by `am kill` there, and by the next
// `am backup` / `am restore` on every OS (a SIGKILL leaves the same thing).
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  askThenKill,
  ENDED_HARD,
  hardStopNote,
  killSaid,
} from "../src/am/am-cmd-process.ts";
import {
  holdLeftover,
  INCOMPLETE_MARK,
  sweepIncomplete,
} from "../src/am/am-cmd-data.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownPidNs } from "../src/server/single-instance-lock.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");
const CONFIG = join(REPO, "deno.json");
const AM = join(REPO, "src/am.ts");
const APP = "hardkill";

// ── am kill: asked first, then ended; the answer says which ────────────────

Deno.test("am kill (Windows path): an app that accepts the stop and exits was stopped cleanly — never terminated", async () => {
  let alive = true, killed = 0;
  const how = await askThenKill({
    ask: () => {
      setTimeout(() => alive = false, 20); // its onStop + final flush
      return Promise.resolve(true);
    },
    alive: () => alive,
    kill: () => killed++,
    waitMs: 2000,
    pollMs: 5,
  });
  assertEquals(how, "clean");
  assertEquals(killed, 0);
});

Deno.test("am kill (Windows path): no answer at the door → ended hard, and said so", async () => {
  let alive = true;
  const how = await askThenKill({
    ask: () => Promise.resolve(false),
    alive: () => alive,
    kill: () => alive = false,
    waitMs: 2000,
    pollMs: 5,
  });
  assertEquals(how, "hard");
});

// It had crashed, or somebody ended it, between `am kill` reading the lock
// and looking: it accepted nothing and nothing was terminated — so neither
// "stopped cleanly" nor "killed" is true.
Deno.test("am kill (Windows path): a process that never answered and is already gone is 'gone' — not stopped cleanly, not killed", async () => {
  let killed = 0;
  const how = await askThenKill({
    ask: () => Promise.resolve(false),
    alive: () => false,
    kill: () => killed++,
    waitMs: 30,
    pollMs: 5,
  });
  assertEquals(how, "gone");
  assertEquals(killed, 0);
  const said = killSaid("notes", 7, "gone");
  assertStringIncludes(said, "was not running any more");
  assert(!/cleanly|asked first|killed notes/.test(said), said);
  assertStringIncludes(killSaid("notes", 7, "clean"), "stopped notes cleanly");
  assertStringIncludes(killSaid("notes", 7, "hard"), ENDED_HARD);
  // …and the op branch says the outcome it got, in both spellings.
  const src = await Deno.readTextFile(
    join(REPO, "src/am/am-cmd-kill.ts"),
  );
  assert(!src.includes('how: "hard"'), "an outcome is hard-coded");
});

Deno.test("am kill (Windows path): an app that accepts and then hangs is ended after the bound", async () => {
  let alive = true, killed = 0;
  const t0 = Date.now();
  const how = await askThenKill({
    ask: () => Promise.resolve(true),
    alive: () => alive,
    kill: () => {
      killed++;
      alive = false;
    },
    waitMs: 60,
    pollMs: 5,
  });
  assertEquals(how, "hard");
  assertEquals(killed, 1);
  assert(Date.now() - t0 >= 60, "it was not given its bound");
});

Deno.test("am kill (Windows path): a process that survives termination is reported alive, not killed", async () => {
  const how = await askThenKill({
    ask: () => Promise.resolve(false),
    alive: () => true,
    kill: () => {},
    waitMs: 30,
    pollMs: 5,
  });
  assertEquals(how, "alive");
});

Deno.test("am stop: the hard fallback is said on Windows only — elsewhere it is SIGTERM, a clean stop", () => {
  assertStringIncludes(hardStopNote("killed", "windows"), ENDED_HARD);
  assertEquals(hardStopNote("graceful", "windows"), "");
  for (const os of ["linux", "darwin"]) {
    for (const how of ["graceful", "signal", "killed"] as const) {
      assertEquals(hardStopNote(how, os), "");
    }
  }
});

// ── what a killed backup / restore left ────────────────────────────────────

Deno.test("a hold's leftover is removed only when it has one of the two shapes am creates", () => {
  const data = join("/h", ".app", "data");
  const hold = (op: string, partial?: string) => ({
    maintenance: { op, since: 1, ...(partial ? { partial } : {}) },
  });
  const bk = join("/b", "bk.partial");
  const rs = join("/h", ".app", "data.restoring-20260101-000000");
  assertEquals(holdLeftover(hold("am backup", bk), data), bk);
  assertEquals(holdLeftover(hold("am restore", rs), data), rs);
  // Not a hold, nothing named, a relative path, or the wrong shape: nothing.
  assertEquals(holdLeftover(null, data), null);
  assertEquals(holdLeftover({}, data), null);
  assertEquals(holdLeftover(hold("am backup"), data), null);
  assertEquals(holdLeftover(hold("am backup", "bk.partial"), data), null);
  assertEquals(holdLeftover(hold("am backup", join("/b", "bk")), data), null);
  assertEquals(holdLeftover(hold("am backup", data), data), null);
  // A restore's staging copy lives BESIDE data/ and nowhere else.
  assertEquals(holdLeftover(hold("am restore", data), data), null);
  assertEquals(
    holdLeftover(hold("am restore", join("/x", "data.restoring-1")), data),
    null,
  );
  assertEquals(
    holdLeftover(
      hold("am restore", join("/h", ".app", "data.replaced-1")),
      data,
    ),
    null,
  );
});

Deno.test("an incomplete copy is swept only when its own mark names a process that is gone", async () => {
  const base = await tempDir("am-sweep-");
  try {
    const mk = (name: string, mark?: unknown) => {
      const dir = join(base, name);
      Deno.mkdirSync(dir);
      Deno.writeTextFileSync(join(dir, "state.db"), "HALF");
      if (mark !== undefined) {
        Deno.writeTextFileSync(
          join(dir, INCOMPLETE_MARK),
          typeof mark === "string" ? mark : JSON.stringify(mark),
        );
      }
      return dir;
    };
    // A process that has provably exited.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "0"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    await child.status;

    // What a mark written HERE carries: this host, this pid namespace.
    const here = { host: Deno.hostname(), ns: ownPidNs() };
    const dead = mk("dead.partial", {
      op: "am backup",
      pid: child.pid,
      ...here,
    });
    assertEquals(sweepIncomplete(dead), {
      path: dead,
      op: "am backup",
      pid: child.pid,
      removed: true,
    });
    assert(!isDir(dead));

    // Its maker is ALIVE (this process): never touched.
    const live = mk("live.partial", {
      op: "am backup",
      pid: Deno.pid,
      ...here,
    });
    assertEquals(sweepIncomplete(live), null);
    // Written somewhere else — a container, a second machine on a shared
    // destination: its pid says nothing HERE, so "that pid is gone here" is
    // no proof, and the copy may be a backup still running over there.
    const gone = { op: "am backup", pid: child.pid };
    const elsewhere = [
      mk("otherhost.partial", { ...gone, ...here, host: "not-this-machine" }),
      mk("nohost.partial", { ...gone, ns: here.ns }),
      mk("otherns.partial", { ...gone, ...here, ns: 12345 }),
      mk("container.partial", { op: "am backup", pid: 1, ns: 12345 }),
    ];
    // No mark, a mark that is not JSON, a mark with no pid: not provably
    // a dead op's — left exactly as found.
    const plain = mk("plain.partial");
    const junk = mk("junk.partial", "not json");
    const nopid = mk("nopid.partial", { op: "am backup" });
    for (const d of [live, plain, junk, nopid, ...elsewhere]) {
      assertEquals(sweepIncomplete(d), null, d);
      assertEquals(Deno.readTextFileSync(join(d, "state.db")), "HALF");
    }
    assertEquals(sweepIncomplete(join(base, "absent.partial")), null);
  } finally {
    await dropTempDir(base);
  }
});

async function denoDir(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

/** Start `verb` in a child, park it inside its copy, hard-kill it — it
 *  leaves its lock and its incomplete copy, as any uncatchable kill does. */
async function killedHold(
  env: Record<string, string>,
  verb: "backup" | "restore",
  arg: string,
): Promise<void> {
  const data = spec(join(REPO, "src/am/am-cmd-data.ts"));
  const dirs = spec(join(REPO, "src/server/app-dirs.ts"));
  const code = `
    import { cmdBackup, cmdRestore } from ${JSON.stringify(data)};
    import { appDirs, ensureAppDirs } from ${JSON.stringify(dirs)};
    const d = appDirs(${JSON.stringify(APP)});
    ensureAppDirs(d);
    Deno.writeTextFileSync(d.stateDb, "LIVE");
    Deno.copyFile = async () => {
      console.log("COPYING");
      await new Promise(() => {}); // parked: the hold is live, mid-copy
    };
    await ${verb === "backup" ? "cmdBackup" : "cmdRestore"}([${
    JSON.stringify(arg)
  }], { app: ${JSON.stringify(APP)}, json: true, force: true });
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", CONFIG, code],
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let err = "";
  const errPump = (async () => {
    for await (const c of child.stderr) err += new TextDecoder().decode(c);
  })().catch(() => {});
  const reader = child.stdout.getReader();
  let seen = "";
  const deadline = Date.now() + 30_000;
  while (!seen.includes("COPYING") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  try {
    child.kill("SIGKILL");
  } catch { /* aio-ok: it already exited — the assertion below says why */ }
  await child.status;
  await errPump;
  reader.releaseLock();
  await child.stdout.cancel().catch(() => {});
  assert(
    seen.includes("COPYING"),
    `the ${verb} never reached its copy:\n${seen}${err}`,
  );
}

async function world() {
  const base = await tempDir("am-kill-hard-");
  const cwd = join(base, "cwd");
  await Deno.mkdir(cwd, { recursive: true });
  await Deno.mkdir(join(base, "run"), { recursive: true, mode: 0o700 });
  await Deno.mkdir(join(base, "archive"), { recursive: true });
  await Deno.writeTextFile(join(base, "archive", "state.db"), "ARCHIVE");
  await Deno.writeTextFile(join(cwd, "main.ts"), "console.log(1);\n");
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    DENO_DIR: await denoDir(),
    HOME: join(base, "home"),
    USERPROFILE: join(base, "home"),
    AIO_APPS_DIR: join(base, "apps"),
    XDG_RUNTIME_DIR: join(base, "run"),
    AIO_AM_NO_DELEGATE: "1",
    NO_COLOR: "1",
  };
  for (const k of ["SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"]) {
    const v = Deno.env.get(k);
    if (v) env[k] = v;
  }
  const am = async (...argv: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, ...argv, `--app=${APP}`],
      cwd,
      clearEnv: true,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    return {
      code: o.code,
      said: new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr),
    };
  };
  return { base, env, am };
}

const isDir = (p: string) => {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "am backup: the next backup removes the .partial a KILLED backup left, and succeeds to the same place",
  fn: async () => {
    const { base, env, am } = await world();
    try {
      const dest = join(base, "bk");
      await killedHold(env, "backup", dest);
      assert(isDir(`${dest}.partial`), "the kill left no .partial to sweep");

      const r = await am("backup", dest, "--json");
      assertEquals(r.code, 0, r.said);
      assertStringIncludes(r.said, `removed ${dest}.partial`);
      assertStringIncludes(r.said, "a killed am backup (pid");
      assert(!isDir(`${dest}.partial`), "the .partial is still there");
      assertEquals(Deno.readTextFileSync(join(dest, "state.db")), "LIVE");
      // The mark is never part of a finished backup.
      assertEquals(
        [...Deno.readDirSync(dest)].some((e) => e.name === INCOMPLETE_MARK),
        false,
      );

      // A `.partial` that does NOT say a dead backup made it is not swept:
      // the refusal that was always there.
      Deno.mkdirSync(`${dest}2.partial`);
      Deno.writeTextFileSync(join(`${dest}2.partial`, "state.db"), "MINE");
      const r2 = await am("backup", `${dest}2`, "--json");
      assertEquals(r2.code, 1, r2.said);
      assertStringIncludes(r2.said, "an earlier backup did not finish");
      assertEquals(
        Deno.readTextFileSync(join(`${dest}2.partial`, "state.db")),
        "MINE",
      );
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name:
    "am restore: the next restore removes the data.restoring-* a KILLED restore left",
  fn: async () => {
    const { base, env, am } = await world();
    try {
      await killedHold(env, "restore", join(base, "archive"));
      const home = join(base, "apps", APP);
      const left = () =>
        [...Deno.readDirSync(home)].filter((e) =>
          e.name.startsWith("data.restoring-")
        ).map((e) => e.name);
      assertEquals(left().length, 1, "the kill left no staging copy to sweep");
      const name = left()[0]!;

      const r = await am("restore", join(base, "archive"), "--force", "--json");
      assertEquals(r.code, 0, r.said);
      assertStringIncludes(r.said, `removed ${join(home, name)}`);
      assertStringIncludes(r.said, "a killed am restore (pid");
      assertEquals(left(), []);
      assertEquals(
        Deno.readTextFileSync(join(home, "data", "state.db")),
        "ARCHIVE",
      );
      assertEquals(
        [...Deno.readDirSync(join(home, "data"))].some((e) =>
          e.name === INCOMPLETE_MARK
        ),
        false,
        "the mark reached the restored data",
      );
    } finally {
      await dropTempDir(base);
    }
  },
});

// ── the real thing, on the OS it is about ──────────────────────────────────
//
// Windows only: everywhere else `am kill` is a SIGTERM the app catches, and
// its answer is unchanged.

const MOD = spec(join(REPO, "mod.ts"));

/** Boot a real app in `env`; resolves once its control key is on disk. */
async function bootApp(base: string, env: Record<string, string>) {
  const dir = join(base, "cwd");
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: ${JSON.stringify(APP)}, cells: [c] });
`,
  );
  const { freePort } = await import("../src/testing/server-test.ts");
  const port = freePort();
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      CONFIG,
      "app.ts",
      `--port=${port}`,
      "--client=server-only",
    ],
    cwd: dir,
    clearEnv: true,
    env: { ...env, AIO_NO_OPEN: "1" },
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
  const keyFile = join(base, "apps", APP, "data", "control.key");
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert(!exited, `the app exited while booting:\n${log}`);
    assert(Date.now() < deadline, `the app never came up:\n${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
      await r.body?.cancel();
      if (r.ok && Deno.statSync(keyFile).isFile) break;
    } catch {
      // not up yet — the loop is the wait
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    keyFile,
    log: () => log,
    async end(): Promise<number> {
      if (!exited) {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch { /* aio-ok: gone */ }
        }, 20_000);
        await status;
        clearTimeout(t);
      }
      await pumps;
      return exited!.code;
    },
  };
}

Deno.test({
  name:
    "am kill (Windows, real app): asked first — it stops cleanly, and the answer says so",
  ignore: Deno.build.os !== "windows", // elsewhere am kill is SIGTERM, unchanged
  async fn() {
    const { base, env, am } = await world();
    try {
      const app = await bootApp(base, env);
      const r = await am("kill");
      const code = await app.end();
      assertEquals(r.code, 0, r.said);
      assertStringIncludes(r.said, '"how":"clean"');
      // The app's own account: it was ASKED, and it left by itself.
      assertStringIncludes(app.log(), "stop requested over the control API");
      assertEquals(code, 0, app.log());
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name:
    "am kill (Windows, real process): nothing answers the stop → ended hard, and the answer says what did not run",
  ignore: Deno.build.os !== "windows", // elsewhere am kill is SIGTERM, unchanged
  async fn() {
    const { base, env, am } = await world();
    try {
      // An "app" with a lock and no door: a live process on a port where
      // nothing listens (an app hung before it could serve, in effect).
      const { freePort } = await import("../src/testing/server-test.ts");
      const lockMod = spec(join(REPO, "src/server/single-instance-lock.ts"));
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          CONFIG,
          `const m = await import(${JSON.stringify(lockMod)});
           m.writeLock({ appId: ${JSON.stringify(APP)}, pid: Deno.pid,
             port: ${freePort()}, startedAt: Date.now(), status: "started",
             cwd: Deno.cwd(), ...m.ownerIdentity(Deno.pid) });
           console.log("LOCKED");
           setTimeout(() => {}, 120000);`,
        ],
        cwd: join(base, "cwd"),
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("LOCKED")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      assert(seen.includes("LOCKED"), "the stand-in never wrote its lock");
      const r = await am("kill");
      const st = await child.status;
      reader.releaseLock();
      await child.stdout.cancel().catch(() => {});
      assertEquals(r.code, 0, r.said);
      assertStringIncludes(r.said, '"how":"hard"');
      assert(st.code !== 0, "a terminated process exited 0");
      // …and a person is told what that means.
      const again = await am("status", "--json");
      assert(!again.said.includes('"pid":' + child.pid), again.said);
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name:
    "am kill (Windows, real backup): the op cannot clean up — am kill removes its partial copy and its lock, and says so",
  ignore: Deno.build.os !== "windows", // elsewhere the op catches SIGTERM and cleans up itself
  async fn() {
    const { base, env, am } = await world();
    try {
      const dest = join(base, "bk");
      const data = spec(join(REPO, "src/am/am-cmd-data.ts"));
      const dirs = spec(join(REPO, "src/server/app-dirs.ts"));
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          CONFIG,
          `import { cmdBackup } from ${JSON.stringify(data)};
           import { appDirs, ensureAppDirs } from ${JSON.stringify(dirs)};
           const d = appDirs(${JSON.stringify(APP)});
           ensureAppDirs(d);
           Deno.writeTextFileSync(d.stateDb, "LIVE");
           Deno.copyFile = async () => { console.log("COPYING"); await new Promise(() => {}); };
           await cmdBackup([${JSON.stringify(dest)}], { app: ${
            JSON.stringify(APP)
          }, json: true });`,
        ],
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("COPYING")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      assert(seen.includes("COPYING"), `the backup never reached its copy`);
      assert(isDir(`${dest}.partial`));

      const r = await am("kill");
      await child.status;
      reader.releaseLock();
      await child.stdout.cancel().catch(() => {});
      assertEquals(r.code, 0, r.said);
      assertStringIncludes(r.said, '"op":"am backup"');
      assertStringIncludes(r.said, '"partialRemoved":true');
      assert(!r.said.includes("removes its partial copy"), r.said);
      assert(!isDir(`${dest}.partial`), "the partial copy is still there");
      // Its lock went with it: the next command is not told a backup runs.
      const st = await am("status", "--json");
      assert(!st.said.includes("am backup"), st.said);
      assertEquals(
        Deno.readTextFileSync(
          join(base, "apps", APP, "data", "state.db"),
        ),
        "LIVE",
      );
    } finally {
      await dropTempDir(base);
    }
  },
});
