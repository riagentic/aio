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
  MOUNT_DEADLINE_MS,
  mountLine,
  RENDERER_TAG,
} from "../src/electron/electron-renderer-log.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import {
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
  assertEquals(m, { route: "info", text: "ui mounted 42 element(s)" });
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
