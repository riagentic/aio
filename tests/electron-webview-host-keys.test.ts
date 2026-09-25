// `<Browser hostKeys>` — keys pressed inside a guest's IFRAME reach the host.
//
// Field report: a desktop app embedding untrusted sites in `<webview>` guests
// has one rule, "Escape always gives the keyboard back", and it failed whenever
// the user had clicked into a video embed or a captcha iframe. The guest's
// preload runs in its top frame only (`nodeintegrationinsubframes` is forced
// off — on, it would put a preload into every third-party frame), so nothing
// in the app ever saw the key.
//
// The relay lives in main: the guest's `before-input-event` sees every frame's
// real input. These RUN the generated fragment with a fake window, guest and
// host document, so what is asserted is what the shell does — which keys leave
// main, and that the delivery script the host evaluates actually dispatches.
// The real-Electron proof (an iframe, a real key) is the ELECTRON_E2E case at
// the bottom.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  HOST_KEY_EVENT,
  HOST_KEYS_ATTR,
  tmplWillNavigate,
} from "../src/electron/electron-shared.ts";
import { Browser, type HostKey } from "../src/ui/browser.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

type Handler = (...a: unknown[]) => unknown;
type Input = {
  type: string;
  key: string;
  code?: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  isAutoRepeat?: boolean;
};

/** A host document with webview elements: `executeJavaScript` evaluates the
 *  shell's script against it, exactly as the renderer would. */
function fakeShell(attr: string | null, gid = 7) {
  const winHandlers: Record<string, Handler> = {};
  const guestHandlers: Record<string, Handler[]> = {};
  const warnings: string[] = [];
  const events: { type: string; detail: HostKey; bubbles: boolean }[] = [];
  const scripts: string[] = [];
  const el = (id: number | "throws", a: string | null) => ({
    getWebContentsId() {
      if (id === "throws") throw new Error("not attached");
      return id;
    },
    getAttribute: (k: string) => (k === HOST_KEYS_ATTR ? a : null),
    dispatchEvent(e: { type: string; detail: HostKey; bubbles: boolean }) {
      if (id === gid) events.push(e);
      return true;
    },
  });
  const document = {
    querySelectorAll: (sel: string) =>
      sel === "webview"
        ? [el("throws", null), el(gid + 1, '["a"]'), el(gid, attr)]
        : [],
  };
  class CustomEvent {
    type: string;
    detail: HostKey;
    bubbles: boolean;
    constructor(type: string, init: { detail: HostKey; bubbles: boolean }) {
      this.type = type;
      this.detail = init.detail;
      this.bubbles = init.bubbles;
    }
  }
  const host = {
    on(ev: string, fn: Handler) {
      winHandlers[ev] = fn;
    },
    setWindowOpenHandler() {},
    isDestroyed: () => false,
    executeJavaScript(code: string) {
      scripts.push(code);
      return Promise.resolve(
        new Function("document", "CustomEvent", `return ${code}`)(
          document,
          CustomEvent,
        ),
      );
    },
  };
  const guest = {
    id: gid,
    setWindowOpenHandler() {},
    isDestroyed: () => false,
    on(ev: string, fn: Handler) {
      (guestHandlers[ev] ??= []).push(fn);
    },
  };
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    tmplWillNavigate("_appOrigin"),
  )(
    { webContents: host },
    {},
    { sep: "/" },
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    "/app",
    "aio://app",
    () => ({ shell: { openExternal() {} } }),
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    async attach() {
      winHandlers["did-attach-webview"]!(null, guest);
      await flush();
    },
    async press(input: Input) {
      for (const f of guestHandlers["before-input-event"] ?? []) {
        f({ preventDefault() {} }, input);
      }
      await flush();
    },
    listeners: () => (guestHandlers["before-input-event"] ?? []).length,
    events,
    warnings,
    scripts,
  };
}

Deno.test("host keys: a declared keydown reaches THIS guest's element, with modifiers", async () => {
  const s = fakeShell('["Escape"]');
  await s.attach();
  await s.press({
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    shift: true,
    control: true,
    isAutoRepeat: true,
  });
  assertEquals(s.events.length, 1);
  assertEquals(s.events[0]!.type, HOST_KEY_EVENT);
  assert(s.events[0]!.bubbles, "bubbles, so a document listener sees it");
  assertEquals(s.events[0]!.detail, {
    key: "Escape",
    code: "Escape",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    repeat: true,
  });
  assertEquals(s.warnings, []);
});

Deno.test("host keys: an undeclared key, and a keyUp, never leave the main process", async () => {
  const s = fakeShell('["Escape"]');
  await s.attach();
  const before = s.scripts.length;
  await s.press({ type: "keyDown", key: "a", code: "KeyA" });
  await s.press({ type: "keyDown", key: "Enter", code: "Enter" });
  await s.press({ type: "keyUp", key: "Escape", code: "Escape" });
  assertEquals(s.events, []);
  assertEquals(
    s.scripts.length,
    before,
    "no script reaches the host renderer for a key the element did not declare",
  );
});

Deno.test("host keys: a guest with no declaration gets no listener at all", async () => {
  const s = fakeShell(null);
  await s.attach();
  assertEquals(s.listeners(), 0);
  assertEquals(s.warnings, []);
});

Deno.test("host keys: a malformed declaration is IGNORED loudly, never half-applied", async () => {
  for (
    const bad of [
      "Escape",
      "[]",
      "[1]",
      '[""]',
      JSON.stringify(Array(17).fill("x")),
    ]
  ) {
    const s = fakeShell(bad);
    await s.attach();
    assertEquals(s.listeners(), 0, bad);
    assertEquals(s.warnings.length, 1, bad);
    assertStringIncludes(s.warnings[0]!, HOST_KEYS_ATTR);
    assertStringIncludes(s.warnings[0]!, "IGNORED");
  }
});

Deno.test("host keys: <Browser> declares the attribute the shell reads, and validates it", () => {
  const v = Browser({ src: "https://a.test/", hostKeys: ["Escape", "F1"] });
  assertEquals(v.props[HOST_KEYS_ATTR], '["Escape","F1"]');
  assertEquals(
    Browser({ src: "https://a.test/" }).props[HOST_KEYS_ATTR],
    undefined,
  );
  for (const bad of [[], [""], [1], Array(17).fill("x"), "Escape"]) {
    // deno-lint-ignore no-explicit-any
    assertThrows(() => Browser({ src: "x", hostKeys: bad as any }), TypeError);
  }
});

Deno.test("host keys: <Browser onHostKey> receives the relayed event, newest handler wins", async () => {
  const seen: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const el = {
    getAttribute: () => null,
    setAttribute() {},
    addEventListener: (t: string, f: (e: unknown) => void) => {
      assert(
        !listeners[t],
        "one listener per element, however often it is wired",
      );
      listeners[t] = f;
    },
    src: "",
  };
  // Driven the way the renderer drives it: the `use` action during the
  // commit, the ref (which carries the props) at its end, and the mount one
  // microtask later.
  const mount = async (tag: string) => {
    const v = Browser({
      src: "",
      hostKeys: ["Escape"],
      onHostKey: (k) => seen.push(tag + k.key),
    });
    (v.props.use as (e: unknown) => unknown)(el);
    (v.props.ref as (e: unknown) => unknown)(el);
    await Promise.resolve();
  };
  await mount("1:");
  await mount("2:");
  listeners[HOST_KEY_EVENT]!({ detail: { key: "Escape" } });
  assertEquals(seen, ["2:Escape"]);
});

// ── Real Electron: an iframe inside a guest, a real key ─────────────────────
// Opt-in like every real-window test (ELECTRON_E2E=1), and ONLY on the nested
// test display — never the user's desktop.

const ELECTRON_BIN = "node_modules/.bin/electron";

function e2eSkip(): string | null {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed";
  }
  if (!Deno.env.get("ELECTRON_E2E")) return "set ELECTRON_E2E=1 to run";
  if (!testDisplayEnv().DISPLAY) return "no nested test display";
  return null;
}

Deno.test({
  name:
    "host keys e2e: Escape pressed inside a guest's IFRAME reaches the host element",
  ignore: e2eSkip() !== null,
  sanitizeResources: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  sanitizeOps: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  async fn() {
    const dir = await tempDir("aio-hostkeys-");
    try {
      const inner = encodeURIComponent(
        `<script>window.__k=[];addEventListener('keydown',e=>__k.push(e.key))</script><input id=i>`,
      );
      const guestHtml =
        `<h1>guest</h1><iframe src="data:text/html,${inner}"></iframe>`;
      const hostHtml =
        `<script>window.__got=[];addEventListener('${HOST_KEY_EVENT}',e=>__got.push(e.detail))</script>` +
        `<webview ${HOST_KEYS_ATTR}='["Escape"]' src="data:text/html,${
          encodeURIComponent(guestHtml)
        }" style="width:400px;height:300px"></webview>`;
      const main = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const BASE_DIR = ${JSON.stringify(dir)};
const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); app.exit(0); };
setTimeout(() => out({ error: 'timeout' }), 20000);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 500, height: 400, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const _appOrigin = 'data:';
${tmplWillNavigate("_appOrigin")}
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.on('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 300));
        const sub = guest.mainFrame.frames[0];
        await sub.executeJavaScript("document.getElementById('i').focus()");
        guest.focus();
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', modifiers: ['shift'] });
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', modifiers: ['shift'] });
        await new Promise((r) => setTimeout(r, 700));
        out({
          iframe: await sub.executeJavaScript('window.__k'),
          host: await win.webContents.executeJavaScript('window.__got'),
        });
      } catch (e) { out({ error: String(e) }); }
    });
  });
  win.loadURL('data:text/html,' + encodeURIComponent(${
        JSON.stringify(hostHtml)
      }));
});`;
      const file = join(dir, "main.cjs");
      await Deno.writeTextFile(file, main);
      const { stdout, stderr } = await new Deno.Command(ELECTRON_BIN, {
        args: [file, "--no-sandbox"],
        env: { ...testDisplayEnv(), ELECTRON_ENABLE_LOGGING: "0" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const line = new TextDecoder().decode(stdout).split("\n").find((l) =>
        l.startsWith("RESULT ")
      );
      assert(
        line,
        "no result: " + new TextDecoder().decode(stderr).slice(-2000),
      );
      const r = JSON.parse(line.slice(7));
      assertEquals(r.error, undefined);
      // The focus WAS in the iframe: it saw both keys.
      assertEquals(r.iframe, ["a", "Escape"]);
      // The host got Escape (with Shift), and never the undeclared "a".
      assertEquals(r.host, [{
        key: "Escape",
        code: "Escape",
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        repeat: false,
      }]);
    } finally {
      await dropTempDir(dir);
    }
  },
});
