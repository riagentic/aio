// A stop that lands while the dev Electron launch is still in flight wins.
//
// The launch is fire-and-forget during boot: draw the icon, find Electron —
// on a first run that is `deno install npm:electron` (+ its `install.js`),
// minutes of it — then spawn the window. Nothing on that chain looked at the
// shutdown, so a SIGTERM mid-boot shut the app down and then logged
// "launching Electron" anyway, and the installer (and any window spawned
// after the orchestrator's electron phase) outlived the app as orphans.
//
// Instrument: a first-run launch whose `deno install` hangs forever — its
// registry (`.npmrc` in the app's cwd) is a local socket that accepts and
// never answers. SIGTERM once the installer is provably on the wire, then
// assert that no process is left in the app's cwd and the launch never
// happened. Linux-only: `/proc/<pid>/cwd` is how the survivors are found.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";

/** `p`, or null after `ms` — with the timer cleared either way. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((r) => t = setTimeout(() => r(null), ms)),
    ]);
  } finally {
    clearTimeout(t);
  }
}

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Every live pid whose cwd is `dir` (the installer runs in the app's cwd). */
function pidsIn(dir: string): number[] {
  const out: number[] = [];
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      if (Deno.readLinkSync(`/proc/${e.name}/cwd`) === dir) {
        out.push(Number(e.name));
      }
    } catch { /* aio-ok: exited mid-scan, or not ours to read */ }
  }
  return out;
}

// SIGHUP too: the installer has its own session, so a closed terminal's
// hangup never reaches it — only the app's shutdown can, and SIGHUP's default
// (terminate on the spot) skipped the shutdown.
for (const sig of ["SIGTERM", "SIGHUP"] as const) {
  Deno.test({
    name:
      `electron launch: ${sig} mid-boot (installer running) — no child survives, no window after shutdown`,
    ignore: Deno.build.os !== "linux",
    fn: async () => {
      const dir = await Deno.realPath(await tempDir("aio-elstop"));
      // The registry that never answers — held connections prove the installer
      // really was mid-install when the signal landed.
      const regPort = freePort();
      const reg = Deno.listen({ hostname: "127.0.0.1", port: regPort });
      const held: Deno.Conn[] = [];
      const accepting = (async () => {
        try {
          for await (const c of reg) held.push(c);
        } catch { /* aio-ok: listener closed at teardown */ }
      })();
      // The app's code + config (repo imports, so it runs from the checkout)…
      const app = join(dir, "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
      const imports: Record<string, string> = {};
      for (
        const [k, v] of Object.entries(head.imports as Record<string, string>)
      ) {
        imports[k] = v.startsWith("./") ? `${ROOT}/${v.slice(2)}` : v;
      }
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
      );
      await Deno.writeTextFile(
        join(app, "src", "cell.ts"),
        `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n`,
      );
      await Deno.writeTextFile(
        join(app, "src", "App.tsx"),
        `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.n}</p>; }\n`,
      );
      await Deno.writeTextFile(
        join(app, "src", "app.ts"),
        `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({ ui: { title: "Stopped" } });\n`,
      );
      // …and a separate cwd: no node_modules (so the dev launch installs), and
      // an .npmrc that only the installer — run HERE — reads.
      const cwd = join(dir, "cwd");
      await Deno.mkdir(cwd);
      await Deno.writeTextFile(join(cwd, "deno.json"), "{}\n");
      await Deno.writeTextFile(
        join(cwd, ".npmrc"),
        `registry=http://127.0.0.1:${regPort}/\n`,
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          join(app, "deno.json"),
          join(app, "src", "app.ts"),
          "--client=electron",
          `--port=${freePort()}`,
        ],
        cwd,
        env: {
          ...testDisplayEnv(),
          ELECTRON_PATH: "", // the dev lookup, not an override
          AIO_APPS_DIR: join(dir, "home"),
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let log = "";
      const dec = new TextDecoder();
      const pump = (s: ReadableStream<Uint8Array>) =>
        (async () => {
          for await (const c of s) log += dec.decode(c);
        })();
      const pumps = [pump(child.stdout), pump(child.stderr)];
      let survivors: number[] = [];
      try {
        for (let i = 0; i < 600; i++) {
          if (log.includes("auto-installing") && held.length > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert(
          log.includes("auto-installing") && held.length > 0,
          `the installer never reached the registry — nothing was in flight:\n${
            log.slice(-2000)
          }`,
        );
        // The installer is a live process in the app's cwd right now.
        assert(pidsIn(cwd).length > 0, "no installer process found to orphan");
        child.kill(sig);
        const st = await within(child.status, 30_000);
        assert(st, `the app did not exit on ${sig}:\n${log.slice(-2000)}`);
        // NOT awaited unbounded: an orphan inherited the app's stdout, so the
        // pipe stays open exactly when the bug is present — a hang, not a fail.
        await within(Promise.all(pumps), 3_000);
        // A killed group can take a moment to be reaped.
        for (let i = 0; i < 50; i++) {
          survivors = pidsIn(cwd);
          if (survivors.length === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assertEquals(
          survivors,
          [],
          `processes outlived the app (orphaned installer):\n${
            log.slice(-2000)
          }`,
        );
        assert(
          !log.includes("launching Electron"),
          `Electron launched after the shutdown began:\n${log.slice(-2000)}`,
        );
        // The lifecycle's own guard: a launch that came back empty BECAUSE
        // of the stop is not "Electron not installed" — no false alarm.
        assert(
          !log.includes("auto-install failed"),
          `a stopped launch was reported as a failed install:\n${
            log.slice(-2000)
          }`,
        );
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* aio-ok: already exited */ }
        await child.status;
        // Kill survivors FIRST: they hold the stdout pipe the pumps read.
        for (const pid of pidsIn(cwd)) {
          try {
            Deno.kill(pid, "SIGKILL");
          } catch { /* aio-ok: exited between scan and kill */ }
        }
        reg.close();
        for (const c of held) {
          try {
            c.close();
          } catch { /* aio-ok: peer already gone */ }
        }
        await accepting;
        await Promise.all(pumps);
      }
    },
  });
}

Deno.test({
  name:
    "electron launch: an aborted stop signal spawns nothing, even with a runtime at hand",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { launchElectron } = await import(
      "../src/electron/electron-spawn.ts"
    );
    const dir = await tempDir("aio-elstop-unit");
    const marker = join(dir, "spawned");
    const fake = join(dir, "electron");
    await Deno.writeTextFile(fake, `#!/bin/sh\ntouch "${marker}"\n`);
    await Deno.chmod(fake, 0o755);
    const was = Deno.env.get("ELECTRON_PATH");
    Deno.env.set("ELECTRON_PATH", fake);
    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: () => {},
    };
    try {
      const stop = new AbortController();
      stop.abort();
      const proc = await launchElectron(
        "http://127.0.0.1:1/",
        log as never,
        undefined,
        undefined,
        undefined,
        undefined,
        stop.signal,
      );
      if (proc) {
        proc.kill("SIGKILL");
        await proc.status;
      }
      assertEquals(proc, null, "a launch after the stop returned a window");
      assert(
        !lines.some((l) => l.includes("launching Electron")),
        lines.join("\n"),
      );
      assert(
        !(await Deno.stat(marker).then(() => true, () => false)),
        "the Electron binary was spawned after the stop",
      );
    } finally {
      if (was === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", was);
    }
  },
});

Deno.test({
  name:
    "electron install: aborting kills the installer's WHOLE group (install.js is a grandchild)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { runInstaller } = await import("../src/electron/electron-spawn.ts");
    const dir = await tempDir("aio-elstop-group");
    const pidFile = join(dir, "grandchild.pid");
    // A `deno` child that spawns a long-lived grandchild and waits on it —
    // the shape of `deno install` running electron's `install.js`.
    const stop = new AbortController();
    const run = runInstaller(
      [
        "eval",
        `const g = new Deno.Command("sleep", { args: ["60"] }).spawn();
         Deno.writeTextFileSync(${JSON.stringify(pidFile)}, String(g.pid));
         await g.status;`,
      ],
      dir,
      stop.signal,
    );
    let gpid = 0;
    for (let i = 0; i < 200 && !gpid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      gpid = Number(await Deno.readTextFile(pidFile).catch(() => "0"));
    }
    assert(gpid > 0, "the grandchild never started");
    stop.abort();
    const r = await run;
    assertEquals(r.success, false);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        Deno.kill(gpid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        Deno.kill(gpid, "SIGKILL");
      } catch { /* aio-ok: exited just now */ }
    }
    assert(!alive, "the grandchild (install.js) outlived the abort");
  },
});

// Every way out that skips the abort: Deno.exit (`unload`), an uncaught
// error and an unhandled rejection (NO `unload` on Deno 2.9 — measured).
const EXITS = {
  "Deno.exit": "Deno.exit(0);",
  "an uncaught error": 'setTimeout(() => { throw new Error("boom"); }, 0);',
  "an unhandled rejection": 'void Promise.reject(new Error("boom"));',
} as const;
for (const [how, exit] of Object.entries(EXITS)) {
  Deno.test({
    name:
      `electron install: a process ending by ${how} still kills the installer group`,
    ignore: Deno.build.os === "windows",
    fn: async () => {
      const dir = await tempDir("aio-elstop-exit");
      const pidFile = join(dir, "grandchild.pid");
      const mod = new URL("../src/electron/electron-spawn.ts", import.meta.url);
      // A host that starts an installer (signal never aborted) and then exits
      // through Deno.exit — the way no abort ever reaches.
      const host = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `const { runInstaller } = await import(${JSON.stringify(mod.href)});
         const stop = new AbortController();
         void runInstaller(["eval", ${
            JSON.stringify(
              `const g = new Deno.Command("sleep", { args: ["60"] }).spawn();
             Deno.writeTextFileSync(${
                JSON.stringify(pidFile)
              }, String(g.pid)); await g.status;`,
            )
          }], ${JSON.stringify(dir)}, stop.signal);
         for (let i = 0; i < 200; i++) {
           try { Deno.statSync(${JSON.stringify(pidFile)}); break; }
           catch { await new Promise((r) => setTimeout(r, 50)); }
         }
         ${exit}`,
        ],
        // NOT piped: a surviving grandchild would hold the pipe open, and the
        // read would wait out its sleep and report a pass a minute late.
        stdout: "null",
        stderr: "null",
      }).output();
      // Exit 0 for Deno.exit; the two crashes exit 1 — either way it ENDED.
      assert(
        host.code === (how === "Deno.exit" ? 0 : 1),
        `host code ${host.code}`,
      );
      const gpid = Number(await Deno.readTextFile(pidFile).catch(() => "0"));
      assert(gpid > 0, "the grandchild never started");
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          Deno.kill(gpid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          alive = false;
        }
      }
      if (alive) {
        try {
          Deno.kill(gpid, "SIGKILL");
        } catch { /* aio-ok: exited just now */ }
      }
      assert(!alive, "the installer group outlived its host's exit");
    },
  });
}

Deno.test("mayTakeSighup: exact from procfs, else only on a terminal stdout (nohup takes it off)", async () => {
  const { mayTakeSighup } = await import("../src/server/aio-lifecycle.ts");
  const tty = () => true, pipe = () => false;
  // Linux: SigIgn bit 0 decides, whatever stdout is.
  assertEquals(mayTakeSighup(() => "SigIgn:\t0000000000000001\n", tty), false);
  assertEquals(mayTakeSighup(() => "SigIgn:\t0000000000001000\n", pipe), true);
  // No procfs (macOS): a nohup'd process never has a terminal stdout.
  assertEquals(mayTakeSighup(() => null, pipe), false);
  assertEquals(mayTakeSighup(() => null, tty), true);
});

Deno.test({
  name:
    "electron launch: a stop landing WHILE the runtime is looked up spawns nothing",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { launchElectron } = await import(
      "../src/electron/electron-spawn.ts"
    );
    const dir = await tempDir("aio-elstop-mid");
    const marker = join(dir, "spawned");
    const fake = join(dir, "electron");
    await Deno.writeTextFile(fake, `#!/bin/sh\ntouch "${marker}"\n`);
    await Deno.chmod(fake, 0o755);
    const was = Deno.env.get("ELECTRON_PATH");
    Deno.env.set("ELECTRON_PATH", fake);
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    try {
      const stop = new AbortController();
      // Not aborted at the call, so the entry check passes; the lookup (an
      // awaited stat of $ELECTRON_PATH) is in flight when the stop lands and
      // FINDS the binary — only the post-lookup check stands in the way.
      const pending = launchElectron(
        "http://127.0.0.1:1/",
        log as never,
        undefined,
        undefined,
        undefined,
        undefined,
        stop.signal,
      );
      stop.abort();
      const proc = await pending;
      if (proc) await proc.status;
      assertEquals(proc, null, "a window was spawned after the stop");
      assert(
        !(await Deno.stat(marker).then(() => true, () => false)),
        "the Electron binary ran after the stop",
      );
    } finally {
      if (was === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", was);
    }
  },
});
