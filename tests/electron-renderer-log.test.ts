// Renderer errors reach the framework log — and the pipe that carries them.
//
// The field report (a desktop wallet, packaged as an AppImage): the window
// came up blank, the app logged `errors=0`, and the renderer's
// `ReferenceError: Buffer is not defined` reached no log at all. Three parts
// make that impossible now, and each is pinned here:
//
//   1. the CLASSIFIER — which Electron stderr lines are dropped (GPU probe
//      noise, exact shapes), which are forwarded at which level, which pass
//      through untouched (pure function, no Electron needed);
//   2. the SHELLS — both generated main scripts hook every renderer failure
//      (`console-message`, `render-process-gone`, `preload-error`,
//      `unresponsive`, `did-fail-load`) and write them with the tag the
//      classifier reads; the UDS preload reports the mount;
//   3. the FLAG — `AIO_ELECTRON_PROTOCOL=1` makes the dev window take the
//      packaged `aio://` path (test what you ship).
//
// The live half — a real Electron window, a real throw, the line in the app
// log — is tests/build-e2e.test.ts ("window mounts the App over aio://").

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyElectronLine,
  formatRendererLine,
  GPU_PROBE_NOISE,
  MAIN_TAG,
  MOUNT_DEADLINE_MS,
  mountLine,
  RENDERER_TAG,
} from "../src/electron/electron-renderer-log.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import {
  electronStderrTail,
  forwardStderr,
} from "../src/electron/electron-spawn.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  tmplCrashGuard,
  tmplRendererDiagnostics,
  udsPreloadScript,
} from "../src/electron/electron-shared.ts";

Deno.test("classifier: a tagged renderer error is forwarded at error, text intact", () => {
  const line = formatRendererLine(
    "error",
    "Uncaught ReferenceError: Buffer is not defined (aio://app/app.js:1:22073)",
  );
  const r = classifyElectronLine(line);
  assertEquals(r.route, "error");
  assert(r.route === "error");
  assertStringIncludes(r.text, "ReferenceError: Buffer is not defined");
  assertStringIncludes(r.text, "app.js:1:22073");
});

Deno.test("classifier: warn and info tags map to their level", () => {
  assertEquals(
    classifyElectronLine(formatRendererLine("warn", "slow")).route,
    "warn",
  );
  const m = classifyElectronLine(formatRendererLine("info", mountLine(42)));
  assertEquals(m, {
    route: "info",
    text: "ui mounted 42 element(s)",
    from: "renderer",
  });
});

Deno.test("classifier: GPU device-probe noise is dropped — exactly those shapes, nothing wider", () => {
  const noise = [
    "KMS: DRM_IOCTL_MODE_CREATE_DUMB failed: Permission denied",
    "pci id for fd 21: 10de:2204, driver (null)",
    "MESA-LOADER: failed to open nouveau: /usr/lib/dri/nouveau_dri.so",
    "MESA-LOADER: failed to retrieve device information",
    "failed to load driver: nouveau",
    "  KMS: DRM_IOCTL_MODE_CREATE_DUMB failed: Permission denied  ",
  ];
  for (const l of noise) {
    assertEquals(classifyElectronLine(l).route, "drop", l);
  }
  // Neighbours that LOOK like noise and are not: a real error must never be
  // swallowed by a regex that grew a little.
  const kept = [
    "failed to load driver: nouveau (and then the app crashed)",
    "FATAL:setuid_sandbox_host.cc(166)] The SUID sandbox helper binary was found",
    "Permission denied",
    "[1234:0828/165000.123:ERROR:gpu_init.cc(523)] Passthrough is not supported",
    "",
  ];
  for (const l of kept) {
    assertEquals(classifyElectronLine(l), { route: "raw", text: l }, l);
  }
  assertEquals(GPU_PROBE_NOISE.length, 4, "the noise list grew — justify it");
});

Deno.test("classifier: a renderer line is never mistaken for noise, and a folded stack stays one line", () => {
  const stack = "Uncaught TypeError: x\n    at a.js:1\n    at b.js:2";
  const line = formatRendererLine("error", stack);
  assert(
    !line.includes("\n"),
    "newlines must be folded — the parent reads lines",
  );
  const r = classifyElectronLine(line);
  assert(r.route === "error" && r.text.includes("at a.js:1"));
  // An untagged line that merely mentions the tag is still raw.
  assertEquals(
    classifyElectronLine("echo " + RENDERER_TAG + "error] x").route,
    "raw",
  );
});

Deno.test("shells: both generated main scripts hook every renderer failure and tag the line", () => {
  const uds = electronMainScriptUDS("http://localhost:1234", "/tmp/x.sock", {});
  const ws = electronMainScript("http://localhost:1234");
  for (const [name, script] of [["uds", uds], ["ws", ws]] as const) {
    for (
      const hook of [
        "'console-message'",
        "'render-process-gone'",
        "'preload-error'",
        "'unresponsive'",
        "'did-fail-load'",
        `process.stderr.write(${JSON.stringify(RENDERER_TAG)}`,
      ]
    ) {
      assertStringIncludes(script, hook, `${name} shell lacks ${hook}`);
    }
    // Both Electron signatures of console-message are read, so an app's
    // Electron pin cannot silence the forwarding.
    assertStringIncludes(script, "typeof e.level === 'string'");
    assertStringIncludes(script, "['debug', 'info', 'warning', 'error'][a[0]]");
  }
  // Only the shell with a preload (and therefore a mount signal) runs the
  // empty-#root watchdog; on the WS shell it would fire on every healthy page.
  assertStringIncludes(uds, `${MOUNT_DEADLINE_MS}ms of the page loading`);
  assert(
    !ws.includes("did not mount within"),
    "ws shell must not run the mount watchdog",
  );
  assertStringIncludes(tmplRendererDiagnostics(false), "'console-message'");
});

Deno.test("shells: the UDS preload reports the mount, and the main script logs it with the one spelling", () => {
  const preload = udsPreloadScript();
  assertStringIncludes(preload, "'__aio:mounted'");
  assertStringIncludes(preload, "getElementById('root')");
  assertStringIncludes(preload, "MutationObserver");
  const uds = electronMainScriptUDS("http://localhost:1234", "/tmp/x.sock", {});
  // The wire spelling is `mountLine` — split around the number.
  const [pre, post] = mountLine(0).split("0");
  assertStringIncludes(uds, JSON.stringify(pre));
  assertStringIncludes(uds, JSON.stringify(post));
});

Deno.test("AIO_ELECTRON_PROTOCOL: forceProtocol makes a dev window with a TCP port load aio://app/ proxied to http", () => {
  const off = electronMainScriptUDS("http://localhost:1234", "/tmp/x.sock", {});
  const on = electronMainScriptUDS("http://localhost:1234", "/tmp/x.sock", {
    forceProtocol: true,
  });
  assertStringIncludes(off, "const FORCE_PROTOCOL = false;");
  assertStringIncludes(on, "const FORCE_PROTOCOL = true;");
  assertStringIncludes(on, 'const HTTP_URL = "http://localhost:1234";');
  assertStringIncludes(
    on,
    "const USE_PROTOCOL = FROM_DISK || FROM_SOCKET || FROM_HTTP;",
  );
  // The proxy reaches the HTTP server when there is no socket — same handler.
  assertStringIncludes(on, "target = { host: u.hostname, port: u.port");
  // …and says so, once, at launch (never a silent loader swap).
  assertStringIncludes(
    on,
    "AIO_ELECTRON_PROTOCOL=1 — the window loads aio://app/",
  );
});

Deno.test("classifier: a tagged main-process warn/error is forwarded under `electron`; other levels stay raw", () => {
  assertEquals(
    classifyElectronLine(
      MAIN_TAG + 'warn] [aio:electron] permission "clipboard-read" DENIED',
    ),
    {
      route: "warn",
      text: '[aio:electron] permission "clipboard-read" DENIED',
      from: "electron",
    },
  );
  assertEquals(classifyElectronLine(MAIN_TAG + "error] boom"), {
    route: "error",
    text: "boom",
    from: "electron",
  });
  for (const l of [MAIN_TAG + "info] x", "echo " + MAIN_TAG + "warn] x"]) {
    assertEquals(classifyElectronLine(l), { route: "raw", text: l }, l);
  }
});

// A packaged app has no terminal: an untagged main-process warning (a
// permission DENIED, an openWindow, a main-process crash) reached
// nobody. RUN the generated guard (not a string match) and classify what it
// writes: every call must reach the framework log, as one line.
Deno.test("shells: the main process's console.warn/error reach the app log, one tagged line each", async () => {
  for (
    const [name, script] of [
      [
        "uds",
        electronMainScriptUDS("http://localhost:1234", "/tmp/x.sock", {}),
      ],
      ["ws", electronMainScript("http://localhost:1234")],
      ["client", electronClientScript("http://localhost:1234")],
    ] as const
  ) {
    assertStringIncludes(script, tmplCrashGuard(), `${name} lacks the guard`);
  }
  const code = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const app = { on() {}, quit() {} };
${tmplCrashGuard()}
console.warn('[aio:electron] permission "%s" DENIED', "clipboard-read");
console.error("line1\\nline2", { n: 1 });
console.error("(node:42) [DEP0005] DeprecationWarning: Buffer() is deprecated");
console.warn("[aio:electron] load http://127.0.0.1:4321/?token=SECRETKEY123&x=1");`;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", code],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(out.stderr);
  assert(out.success, err);
  assertEquals(err.split("\n").filter((l) => l).map(classifyElectronLine), [
    {
      route: "warn",
      text: '[aio:electron] permission "clipboard-read" DENIED',
      from: "electron",
    },
    { route: "error", text: "line1 ⏎ line2 { n: 1 }", from: "electron" },
    // Node prints a process warning (an Electron or Node deprecation) through
    // console.error; it is a warning, not an error.
    {
      route: "warn",
      text: "(node:42) [DEP0005] DeprecationWarning: Buffer() is deprecated",
      from: "electron",
    },
    // app.log is copied into reports: the app's key never reaches it.
    {
      route: "warn",
      text: "[aio:electron] load http://127.0.0.1:4321/?token=\u2026&x=1",
      from: "electron",
    },
  ]);
});

// The parent half: a tagged line lands in the framework log at its level,
// under the category the classifier named — main-process lines as
// `electron`, a page's as `renderer`.
Deno.test("forwardStderr: tagged lines reach the log sink under their category", async () => {
  const got: [string, string, string][] = [];
  setLogger({
    pub: (lvl: string, cat: string, msg: string) => got.push([lvl, cat, msg]),
  } as unknown as LogSink);
  try {
    const lines = [
      formatRendererLine("error", "page threw"),
      MAIN_TAG + 'warn] [aio:electron] permission "x" DENIED',
      MAIN_TAG + "error] main boom",
    ];
    const proc = {
      stderr: ReadableStream.from([
        new TextEncoder().encode(lines.join("\n") + "\n"),
      ]),
    } as unknown as Deno.ChildProcess;
    forwardStderr(proc);
    await electronStderrTail(proc, 2000);
  } finally {
    setLogger(null);
  }
  assertEquals(got, [
    ["error", "renderer", "page threw"],
    ["warn", "electron", '[aio:electron] permission "x" DENIED'],
    ["error", "electron", "main boom"],
  ]);
});

// The aio server gone = the stderr pipe's reader gone. Every write then fails
// with EPIPE; unguarded, that 'error' is an uncaughtException whose handler
// logs through console.error — another EPIPE — a loop measured at ~67k
// exceptions (and app.quit() calls) in 1.5 s. Run in Electron's own Node.
const ELECTRON_REAL = (() => {
  try {
    const rel = Deno.readTextFileSync("node_modules/electron/path.txt").trim();
    return "node_modules/electron/dist/" + rel;
  } catch {
    return "";
  }
})();
Deno.test({
  name:
    "shells: a dead stderr pipe never loops EPIPE → uncaughtException → console.error",
  ignore: ELECTRON_REAL === "",
  async fn() {
    const dir = await tempDir("aio-epipe-");
    try {
      const out = join(dir, "out.json");
      const script = join(dir, "main.cjs");
      await Deno.writeTextFile(
        script,
        `let quits = 0, uncaught = 0;
const hooks = {};
const app = {
  on(ev, f) { hooks[ev] = f; },
  quit() { quits++; if (hooks['before-quit']) hooks['before-quit'](); },
};
${tmplCrashGuard()}
process.on('uncaughtException', () => { uncaught++; });
const t = setInterval(() => console.warn('[aio:electron] tick'), 1);
setTimeout(() => {
  clearInterval(t);
  require('fs').writeFileSync(${
          JSON.stringify(out)
        }, JSON.stringify({ quits, uncaught }));
  process.exit(0);
}, 1500);
`,
      );
      const child = new Deno.Command(ELECTRON_REAL, {
        args: [script],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      await child.stderr.cancel(); // the reader dies before the first line
      await child.status;
      const r = JSON.parse(await Deno.readTextFile(out));
      assert(r.uncaught < 5, `EPIPE loop: ${JSON.stringify(r)}`);
      assert(r.quits <= 1, `quit more than once: ${JSON.stringify(r)}`);
    } finally {
      await dropTempDir(dir);
    }
  },
});
