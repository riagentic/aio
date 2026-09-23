// A killed `am backup` / `am restore` is NAMED by whoever cleans its lock up.
//
// Every cleanup site — `am start`'s singleton check, `am status`, `am
// instances` (and so every verb that lists instances) — removed a dead
// holder's lock without a word, so the boot-time explanation never ran: a
// restore killed between its two renames left data/ missing, and the app
// then booted on an empty data/ with nothing saying why. Now each site says
// which op was killed and what it left, before the lock goes.
//
// Real holds, really killed: `cmdBackup` / `cmdRestore` in a child, parked
// inside their copy, then SIGKILLed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const CONFIG = join(REPO, "deno.json");
const AM = join(REPO, "src/am.ts");
const APP = "deadhold";

async function denoDir(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

/** Start `verb` on APP in a child, park it inside its copy, SIGKILL it.
 *  It leaves `<dest>.partial` / `data.restoring-*` behind, as a real kill does. */
async function killedHold(
  env: Record<string, string>,
  base: string,
  verb: "backup" | "restore",
  dest = "bk",
): Promise<void> {
  const data = join(REPO, "src/am/am-cmd-data.ts");
  const dirs = join(REPO, "src/server/app-dirs.ts");
  const arg = verb === "backup" ? join(base, dest) : join(base, "archive");
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
  }], { app: ${JSON.stringify(APP)}, json: true });
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

Deno.test({
  name: "am: a killed backup/restore is named by status, instances and start",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const base = await tempDir("am-dead-hold-");
    try {
      const cwd = join(base, "cwd");
      await Deno.mkdir(cwd, { recursive: true });
      await Deno.mkdir(join(base, "run"), { recursive: true, mode: 0o700 });
      await Deno.mkdir(join(base, "archive"), { recursive: true });
      await Deno.writeTextFile(join(base, "archive", "state.db"), "ARCHIVE");
      await Deno.writeTextFile(join(cwd, "main.ts"), "console.log(1);\n");
      const env = {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        DENO_DIR: await denoDir(),
        HOME: join(base, "home"),
        AIO_APPS_DIR: join(base, "apps"),
        XDG_RUNTIME_DIR: join(base, "run"),
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      };
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
        return new TextDecoder().decode(o.stdout) +
          new TextDecoder().decode(o.stderr);
      };

      await killedHold(env, base, "backup");
      const st = await am("status", "--json");
      assertStringIncludes(st, "am backup (pid");
      assertStringIncludes(st, "was killed");
      assertStringIncludes(st, join(base, "bk.partial"));

      await killedHold(env, base, "restore");
      const inst = await am("instances", "--json");
      assertStringIncludes(inst, "am restore (pid");
      assertStringIncludes(inst, "data.restoring-");

      await killedHold(env, base, "backup", "bk2");
      const start = await am("start", "--json");
      assertStringIncludes(start, "am backup (pid");
      assertStringIncludes(start, "was killed");
      assertStringIncludes(start, join(base, "bk2.partial"));
    } finally {
      await dropTempDir(base);
    }
  },
});

/** Plant a lock record in the child env's lock dir. */
async function plant(
  env: Record<string, string>,
  rec: Record<string, unknown>,
) {
  const mod = join(REPO, "src/server/single-instance-lock.ts");
  const o = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      CONFIG,
      `const m = await import(${JSON.stringify(mod)});
       m.writeLock(${JSON.stringify(rec)});`,
    ],
    clearEnv: true,
    env,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(o.success, new TextDecoder().decode(o.stderr));
}

Deno.test({
  name: "am: stop --home names a dead hold ONCE; restart refuses a live hold " +
    "before announcing a relaunch; a recycled pid is not a live hold",
  ignore: Deno.build.os !== "linux", // the start-token check is /proc-based
  fn: async () => {
    const base = await tempDir("am-dead-hold-2-");
    const sleeper = new Deno.Command("sleep", {
      args: ["60"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const cwd = join(base, "cwd");
      const home = join(base, "elsewhere");
      await Deno.mkdir(cwd, { recursive: true });
      await Deno.mkdir(join(base, "run"), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(join(cwd, "main.ts"), "console.log(1);\n");
      const env = {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        DENO_DIR: await denoDir(),
        HOME: join(base, "home"),
        AIO_APPS_DIR: join(base, "apps"),
        XDG_RUNTIME_DIR: join(base, "run"),
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      };
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
          all: new TextDecoder().decode(o.stdout) +
            new TextDecoder().decode(o.stderr),
        };
      };
      const gone = new Deno.Command("true").spawn();
      await gone.status;
      const hold = (pid: number, extra: Record<string, unknown> = {}) => ({
        appId: APP,
        pid,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd,
        maintenance: { op: "am backup", partial: "/bk.partial" },
        ...extra,
      });

      // stop --home on a DEAD hold: named once, and the lock goes with it.
      await plant(env, hold(gone.pid, { home }));
      const s1 = await am("stop", `--home=${home}`, "--json");
      assertStringIncludes(s1.all, "am backup (pid");
      const s2 = await am("stop", `--home=${home}`, "--json");
      assert(!s2.all.includes("was killed"), `named again:\n${s2.all}`);

      // restart on a LIVE hold: refused by name, nothing announced first.
      await plant(env, hold(sleeper.pid, { home: join(base, "apps", APP) }));
      const rs = await am("restart", "--json");
      assertEquals(rs.code, 1, rs.all);
      assertStringIncludes(rs.all, "am backup is running");
      assert(!rs.all.includes("restart:"), `announced first:\n${rs.all}`);

      // A live pid whose START TOKEN differs is a recycled pid: the hold is
      // dead, and status says stopped — never "maintenance".
      await plant(
        env,
        hold(sleeper.pid, { home, startToken: "not-this-process" }),
      );
      const st = await am("status", `--home=${home}`, "--json");
      assertEquals(st.code, 1, st.all);
      assert(!st.all.includes('"maintenance"'), st.all);
    } finally {
      try {
        sleeper.kill("SIGKILL");
      } catch { /* aio-ok: already gone */ }
      await sleeper.status;
      await dropTempDir(base);
    }
  },
});
