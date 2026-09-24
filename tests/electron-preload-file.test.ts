// The PRELOAD file every generated Electron shell writes — an audit item.
//
// It is the one file in a launch that is CODE the renderer will run, and both
// shells wrote it as `<temp>/__aio_preload_<pid>.cjs` with no mode: a name
// anybody on the box can predict, at the default umask (0644), in a directory
// every user shares. The main script beside it was always `Deno.makeTempFile()`
// — random name, 0600 — so this was the odd one out rather than a policy.
//
// Two facts are checked, and the second one is the test that could not lie: the
// emitted block is CUT OUT OF THE GENERATED SCRIPT AND RUN, against real
// `node:fs`, so the assertion is about the mode on a real file rather than
// about the text that was supposed to produce it. A `mode:` written into a
// template that never runs is exactly the class this repo keeps finding.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { udsPreloadScript } from "../src/electron/electron-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { permissiveUmask } from "./permissive-umask.ts";

const udsMain = () =>
  electronMainScriptUDS("http://127.0.0.1:8000", "/tmp/x.sock", {
    baseDir: "/app",
    title: "t",
    meta: { title: "t" },
  });
const wsMain = () =>
  electronMainScript("http://127.0.0.1:8000", { title: "t" });

const SHELLS: [string, () => string][] = [
  ["UDS shell", udsMain],
  ["WebSocket shell", wsMain],
];

/** The emitted preload block, between its markers. */
function preloadBlock(src: string): string {
  const open = src.indexOf("// ── aio preload file");
  const close = src.indexOf("// ── end aio preload file");
  assert(open >= 0 && close > open, "the preload block markers are gone");
  return src.slice(open, close);
}

Deno.test("preload: neither shell writes a predictable path at the default umask", () => {
  for (const [name, gen] of SHELLS) {
    const src = gen();
    const block = preloadBlock(src);
    assertStringIncludes(block, "mkdtempSync", `${name}: no private dir`);
    assertStringIncludes(block, "mode: 0o600", `${name}: no mode`);
    assert(
      !src.includes("'__aio_preload_' + process.pid"),
      `${name}: the pid-predictable preload path is back`,
    );
    assert(
      !src.includes("'__aio_shell_preload_' + process.pid"),
      `${name}: the pid-predictable preload path is back`,
    );
    // …and it is swept: a private directory left behind is still litter.
    assertStringIncludes(src, "rmSync(preloadDir", `${name}: no cleanup`);
    // ORDER, not just presence. The sweep must be armed BEFORE the directory
    // exists: arming second leaves a window in which a SIGTERM takes the
    // default action and the directory outlives the process. The suite caught
    // exactly that, under load, after the sweep had already shipped — so the
    // ordering is the fix and this is the assertion that keeps it.
    // Both anchors are checked for PRESENCE first. `indexOf` answers -1 on a
    // miss, and `-1 < anything` is true — so a bare comparison would go
    // permanently green the day either string is re-quoted or reflowed, with
    // the bug back and the file passing. That is the shape this suite keeps
    // finding; a verifier proved it on this very assertion by changing
    // `'exit'` to `"exit"` in the emitted text.
    const armed = src.indexOf("process.on('exit', __aioSweepPreload)");
    const made = src.indexOf("fs.mkdtempSync");
    assert(armed > 0, `${name}: the sweep's arming line moved — re-anchor`);
    assert(made > 0, `${name}: the mkdtemp line moved — re-anchor`);
    assert(
      armed < made,
      `${name}: the preload sweep is armed AFTER the directory is created — ` +
        `a signal in that window leaks it`,
    );
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      assertStringIncludes(src, `'${sig}'`, `${name}: ${sig} is unhandled`);
    }
    // The whole script still parses — a template is a language boundary with
    // no compiler on the far side.
    new Function(src);
  }
});

Deno.test("preload: the emitted block RUNS and leaves 0600 in a 0700 dir", () =>
  permissiveUmask(async () => {
    const home = await tempDir("secB-preload");
    try {
      for (const [name, gen] of SHELLS) {
        const block = preloadBlock(gen());
        const run = new Function(
          "fs",
          "path",
          "app",
          "preloadCode",
          `${block}\nreturn { preloadFile, preloadDir };`,
        ) as (
          fs: typeof nodeFs,
          path: typeof nodePath,
          app: { getPath: (k: string) => string },
          preloadCode: string,
        ) => { preloadFile: string; preloadDir: string };
        const { preloadFile, preloadDir } = run(
          nodeFs,
          nodePath,
          { getPath: () => home },
          udsPreloadScript(),
        );
        const file = Deno.statSync(preloadFile);
        const dir = Deno.statSync(preloadDir);
        assertEquals(
          (file.mode ?? 0) & 0o777,
          0o600,
          `${name}: the preload is readable by someone else`,
        );
        assertEquals(
          (dir.mode ?? 0) & 0o777,
          0o700,
          `${name}: the preload's directory is readable by someone else`,
        );
        assert(
          Deno.readTextFileSync(preloadFile).includes("__aio"),
          `${name}: the preload written is not the preload generated`,
        );
      }
    } finally {
      await dropTempDir(home);
    }
  }));

// ── …and it has to be gone the way the window actually ENDS ───────────────
//
// The sweep lived in `window-all-closed` alone, which is one of the ways an
// Electron main process stops and not the common one. aio's own shutdown is
// `ep.kill()` (shutdown.ts, phase "electron") — a SIGTERM — so every `deno
// task dev --client=electron` ended with Ctrl-C, every restart, every test
// that stops an app, left the private directory behind. A directory per
// launch, forever, in `<temp>`.
//
// Measured, not read: the REAL generated main runs as a child process, gets
// the REAL signal, and the assertion is `readDir` on the directory afterwards.
// (One shell is enough here — `tmplPreloadWrite`/`tmplPreloadCleanup` is the
// single decider both shells emit, which the test above pins.)
const STUB_ELECTRON = `
const appH = {};
module.exports = {
  app: {
    on: (e, fn) => { (appH[e] = appH[e] || []).push(fn); },
    getPath: () => process.env.AIO_STUB_DIR,
    quit: () => {},
    name: 'stub',
  },
  BrowserWindow: class {
    constructor(o) { this.opts = o; this.webContents = { on(){}, send(){}, setWindowOpenHandler(){}, session: {} }; }
    on(){} center(){} loadURL(){} setMenuBarVisibility(){} setIcon(){}
    isDestroyed(){ return false; } isVisible(){ return true; } isMinimized(){ return false; }
    getBounds(){ return { x: 0, y: 0, width: 800, height: 600 }; }
  },
  Menu: { setApplicationMenu: () => {} },
  ipcMain: { on: () => {} },
  shell: { openExternal: () => {} },
  net: { fetch: () => Promise.resolve({ ok: false }) },
  nativeImage: {},
};
setTimeout(() => { for (const f of (appH['ready'] || [])) f(); }, 0);
setInterval(() => {}, 1000);
`;

/** Runs the generated WebSocket shell as a real child process, with a stub
 *  `electron` module and `<temp>` pointed at `home`. */
async function runShell(home: string) {
  await Deno.mkdir(nodePath.join(home, "node_modules", "electron"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    nodePath.join(home, "node_modules", "electron", "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0", main: "index.js" }),
  );
  await Deno.writeTextFile(
    nodePath.join(home, "node_modules", "electron", "index.js"),
    STUB_ELECTRON,
  );
  // `nodeModulesDir: manual` keeps Deno from resolving the REAL npm:electron.
  await Deno.writeTextFile(
    nodePath.join(home, "deno.json"),
    JSON.stringify({ nodeModulesDir: "manual" }),
  );
  await Deno.writeTextFile(nodePath.join(home, "main.cjs"), wsMain());
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--quiet", nodePath.join(home, "main.cjs")],
    cwd: home,
    env: { AIO_STUB_DIR: home },
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const errs: string[] = [];
  (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stderr) {
      errs.push(dec.decode(c, { stream: true }));
    }
  })().catch(() => {});
  return { proc, errs };
}

const preloadDirs = (home: string) =>
  [...Deno.readDirSync(home)].map((e) => e.name).filter((n) =>
    n.startsWith("aio-preload-")
  );

Deno.test({
  name: "preload: the private directory does not outlive a SIGTERM'd window",
  ignore: Deno.build.os === "windows", // no SIGTERM to send
  fn: async () => {
    const home = await tempDir("secB-preload-kill");
    try {
      const { proc, errs } = await runShell(home);
      const t0 = Date.now();
      while (preloadDirs(home).length === 0) {
        if (Date.now() - t0 > 20_000) {
          try {
            proc.kill("SIGKILL");
          } catch { /* already gone */ }
          await proc.status;
          throw new Error(
            `the shell never wrote its preload: ${errs.join("")}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      // THE signal aio sends: shutdown.ts phase "electron" is `ep.kill()`,
      // and Deno's default signal is SIGTERM.
      proc.kill("SIGTERM");
      await proc.status;
      assertEquals(
        preloadDirs(home),
        [],
        "a killed launch left its private preload directory in <temp> — one " +
          "per run, forever",
      );
    } finally {
      await dropTempDir(home);
    }
  },
});
