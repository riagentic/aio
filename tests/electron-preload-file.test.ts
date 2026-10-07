// The PRELOAD file every generated Electron shell writes — an audit item.
//
// It is the one file in a launch that is CODE the renderer will run, and both
// shells wrote it as `<temp>/__aio_preload_<pid>.cjs` with no mode: a name
// anybody on the box can predict, at the default umask (0644), in a directory
// every user shares. The main script beside it was always `Deno.makeTempFile()`
// — random name, 0600 — so this was the odd one out rather than a policy.
//
// It then lived in a private `mkdtemp` directory per launch in `<temp>` — and
// a window that was SIGKILLed left that directory behind for good (16 after 20
// kills). The file cannot simply be removed once loaded: Electron reads the
// preload again for every document (measured — a reload after the file is
// gone raises `preload-error` and the page has no bridge). So it lives in the
// app's own profile directory now, as `aio-preload/<pid>.cjs`, and a launch
// first removes every file there whose process is gone.
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
import { modeBitsAreMeaningful } from "../src/server/dir-permissions.ts";
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

/** A pid whose process has exited (and been reaped). */
async function deadPid(): Promise<number> {
  const p = new Deno.Command(Deno.execPath(), {
    args: ["-V"],
    stdout: "null",
  }).spawn();
  await p.status;
  return p.pid;
}

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
    assertStringIncludes(
      block,
      "path.join(app.getPath('userData'), 'aio-preload')",
      `${name}: not in the app's own profile`,
    );
    assert(!block.includes("getPath('temp')"), `${name}: back in <temp>`);
    assertStringIncludes(block, "mode: 0o700", `${name}: no dir mode`);
    assertStringIncludes(block, "mode: 0o600", `${name}: no mode`);
    // `mode:` is ignored for a file that already exists — it is created.
    assertStringIncludes(block, "flag: 'wx'", `${name}: not created fresh`);
    // The profile directory is decided by the app's name: set before this.
    const named = src.indexOf("app.name = ");
    assert(named > 0, `${name}: the app.name line moved — re-anchor`);
    assert(
      named < src.indexOf("// ── aio preload file"),
      `${name}: the preload is written before the app is named — it would ` +
        `land in another app's profile`,
    );
    assert(
      !src.includes("'__aio_preload_' + process.pid"),
      `${name}: the pid-predictable preload path is back`,
    );
    assert(
      !src.includes("'__aio_shell_preload_' + process.pid"),
      `${name}: the pid-predictable preload path is back`,
    );
    // …and it is swept: a private directory left behind is still litter.
    assertStringIncludes(src, "rmSync(preloadFile", `${name}: no cleanup`);
    // ORDER, not just presence. The sweep must be armed BEFORE the file
    // exists: arming second leaves a window in which a SIGTERM takes the
    // default action and the file outlives the process. The suite caught
    // exactly that, under load, after the sweep had already shipped — so the
    // ordering is the fix and this is the assertion that keeps it.
    // Both anchors are checked for PRESENCE first. `indexOf` answers -1 on a
    // miss, and `-1 < anything` is true — so a bare comparison would go
    // permanently green the day either string is re-quoted or reflowed, with
    // the bug back and the file passing. That is the shape this suite keeps
    // finding; a verifier proved it on this very assertion by changing
    // `'exit'` to `"exit"` in the emitted text.
    const armed = src.indexOf("process.on('exit', __aioSweepPreload)");
    const made = src.indexOf("fs.writeFileSync(preloadFile");
    assert(armed > 0, `${name}: the sweep's arming line moved — re-anchor`);
    assert(made > 0, `${name}: the preload write moved — re-anchor`);
    assert(
      armed < made,
      `${name}: the preload sweep is armed AFTER the file is written — ` +
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
        // Windows has no mode bits to read: `stat().mode` is 0o666 for every
        // file there, the ACL-private profile included (measured, see
        // `modeBitsAreMeaningful`). The boundary on Windows is the ACL of
        // `userData` (under the user's own %APPDATA%), which the block does
        // not set and Deno cannot read — so the mode is asserted where it is
        // a fact, and everything else below runs on every OS.
        if (modeBitsAreMeaningful()) {
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
        }
        assert(
          Deno.readTextFileSync(preloadFile).includes("__aio"),
          `${name}: the preload written is not the preload generated`,
        );
        assertEquals(
          preloadFile,
          nodePath.join(home, "aio-preload", `${Deno.pid}.cjs`),
        );
        // WHAT A KILLED WINDOW LEFT is taken away by the next launch — and a
        // file whose process is alive is another window's, and stays. Run
        // again, over: a dead pid's file (a child that has exited), a live
        // one's (this process's parent), junk, and this launch's own name
        // from an earlier life (0644 — the mode must not be inherited).
        const dead = await deadPid();
        const at = (n: string) => nodePath.join(preloadDir, n);
        Deno.writeTextFileSync(at(`${dead}.cjs`), "left by a killed window");
        Deno.writeTextFileSync(at(`${Deno.ppid}.cjs`), "a running window's");
        Deno.writeTextFileSync(at("junk"), "?");
        Deno.writeTextFileSync(preloadFile, "stale", { mode: 0o644 });
        run(nodeFs, nodePath, { getPath: () => home }, udsPreloadScript());
        assertEquals(
          [...Deno.readDirSync(preloadDir)].map((e) => e.name).sort(),
          [`${Deno.pid}.cjs`, `${Deno.ppid}.cjs`].sort(),
          `${name}: the launch did not clear what dead windows left, or ` +
            `removed a live window's preload`,
        );
        if (modeBitsAreMeaningful()) {
          assertEquals((Deno.statSync(preloadFile).mode ?? 0) & 0o777, 0o600);
        }
        assert(Deno.readTextFileSync(preloadFile).includes("__aio"));
        Deno.removeSync(preloadDir, { recursive: true });
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
// that stops an app, left the preload behind.
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
    // A quit that does NOT end the process — the stub's ready handler throws
    // (no session), and the crash guard's quit must not end the run before
    // the test looks. So the stop the shell takes once it is ready
    // (tmplParentWatch) ends here through its backstop, app.exit().
    quit: () => {},
    exit: (c) => process.exit(c),
    name: 'stub',
    whenReady: () => new Promise((r) => setTimeout(r, 0)),
  },
  BrowserWindow: class {
    constructor(o) { this.opts = o; this.webContents = { on(){}, send(){}, setWindowOpenHandler(){}, session: {} }; }
    on(){} center(){} loadURL(){} setMenuBarVisibility(){} setIcon(){}
    isDestroyed(){ return false; } isVisible(){ return true; } isMinimized(){ return false; }
    getBounds(){ return { x: 0, y: 0, width: 800, height: 600 }; }
  },
  // macOS: the generated main builds its menu after whenReady (tmplAppMenu;
  // the menu itself is pinned by electron-window-close-and-menu.test.ts).
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: (t) => t },
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

/** The preload files in the stub's profile directory. */
const preloadFiles = (home: string): string[] => {
  try {
    return [...Deno.readDirSync(nodePath.join(home, "aio-preload"))].map((e) =>
      e.name
    );
  } catch {
    return []; // aio-ok: no directory yet — nothing written
  }
};

Deno.test({
  name: "preload: the file does not outlive a SIGTERM'd window",
  ignore: Deno.build.os === "windows", // no SIGTERM there: a killed window's preload is swept by the next launch
  fn: async () => {
    const home = await tempDir("secB-preload-kill");
    try {
      const { proc, errs } = await runShell(home);
      const t0 = Date.now();
      while (preloadFiles(home).length === 0) {
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
        preloadFiles(home),
        [],
        "a stopped launch left its preload behind",
      );
    } finally {
      await dropTempDir(home);
    }
  },
});
