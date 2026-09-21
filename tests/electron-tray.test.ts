// ui.tray — Electron main-process code cannot run in CI, so this tests the
// GENERATED scripts of BOTH shells (the zero-port UDS one and the WebSocket
// one), the way electron-openwindow.test.ts does: the gate reflects config,
// the template is the same in both, the scripts parse, and the shell bridge
// is exposed by both preloads without turning the WS window into an IPC one.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import {
  shellBridgePreload,
  udsPreloadScript,
} from "../src/electron/electron-shared.ts";

const tray = {
  tooltip: "Hi",
  closeToTray: true,
  menu: [
    { label: "Pause", method: "player:pause" },
    "-",
    { label: "Library", route: "/lib" },
  ],
};
const uds = (t: unknown) =>
  electronMainScriptUDS("http://127.0.0.1:8000", "/tmp/x.sock", {
    baseDir: "/app",
    title: "t",
    meta: { tray: t as never },
  });
const ws = (t: unknown) =>
  electronMainScript("http://127.0.0.1:8000/", {
    title: "t",
    tray: t as never,
  });
/** A syntax error in a generated main is a window that never opens. */
const parseError = (s: string): string | null => {
  try {
    new Function(s);
    return null;
  } catch (e) {
    return String(e);
  }
};

Deno.test("tray: both shells carry the same template, gated on ui.tray", () => {
  for (const [name, gen] of [["uds", uds], ["ws", ws]] as const) {
    const on = gen(tray), off = gen(undefined), bool = gen(true);
    assertStringIncludes(on, "new Tray(", name);
    assertStringIncludes(on, '"closeToTray":true', name);
    assertStringIncludes(on, "'__aio:tray'", name);
    assertStringIncludes(on, "'__aio:focus'", name);
    assertStringIncludes(on, '"label":"Pause"', name);
    assertStringIncludes(on, "player:pause", name);
    assertStringIncludes(off, "const TRAY = null", name);
    assertStringIncludes(bool, "const TRAY = {}", name);
    assertEquals(
      parseError(on),
      null,
      `${name}: the generated main must parse`,
    );
    assertEquals(parseError(off), null, `${name}: and without a tray`);
  }
});

Deno.test("tray: close-to-tray hides; a real quit still passes; the UDS close handler knows a hide from a close", () => {
  const s = uds(tray);
  assertStringIncludes(
    s,
    "__aioHiding = true; e.preventDefault(); win.hide();",
  );
  assertStringIncludes(s, "if (__aioHiding) { __aioHiding = false; return; }");
  assertStringIncludes(s, "__aioQuitting = true; app.quit();");
  // The hide listener is registered BEFORE the shell's own close handler —
  // listener order is what lets the flag be read in time.
  assert(
    s.indexOf("__aioHiding = true; e.preventDefault()") <
      s.indexOf("if (__aioHiding) { __aioHiding = false; return; }"),
    "the tray's close listener must come first",
  );
});

Deno.test("tray: the shell bridge is in BOTH preloads, and the WS one never looks like an IPC window", () => {
  const p = udsPreloadScript();
  assertStringIncludes(p, "__aioShell");
  assertStringIncludes(p, "onTray");
  assertStringIncludes(p, "'__aio:focus'");
  const standalone = shellBridgePreload({ standalone: true });
  assertStringIncludes(standalone, "require('electron')");
  assert(
    !standalone.includes("__aioIPC"),
    "the presence of __aioIPC selects the IPC transport; a WS window must not carry it",
  );
  assertEquals(parseError(standalone), null);
  // …and the WS shell still WRITES one (in its own 0600 file — see
  // tests/electron-preload-file.test.ts).
  assertStringIncludes(ws(undefined), "writeFileSync(preloadFile");
});
