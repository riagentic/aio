// aio-client's LAN search, when its socket fails AFTER the probe left.
//
// 1.0.19 made a probe that could not be SENT say so. A socket that could not
// be opened, and one whose `error` event fired afterwards, still ended the
// sweep with an empty list and no word: the connect page went on saying
// "searching…" over a search that had stopped.
//
// The generated main script is RUN (the rule of
// electron-client-generated-eval.test.ts: a template literal that is only
// string-matched proves the line was typed, not what it does once cooked).
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createRequire } from "node:module";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

const nodeRequire = createRequire(import.meta.url);

type Sock = { handlers: Record<string, (...e: unknown[]) => void> };

/** The generated main against recorders: one window, one fake `dgram`. */
function boot(dgram: unknown, platform = "linux") {
  const handlers: Record<string, () => void> = {};
  const errors: string[] = [];
  const injected: string[] = [];
  const loaded: (() => void)[] = [];
  const timers: (() => void)[] = [];
  class BrowserWindow {
    webContents = {
      getURL: () => "",
      executeJavaScript: (js: string) => {
        injected.push(js);
        return Promise.resolve();
      },
      once: (n: string, f: () => void) =>
        n === "did-finish-load" && loaded.push(f),
      on() {},
      session: {},
      setWindowOpenHandler() {},
    };
    once() {}
    show() {}
    isDestroyed() {
      return false;
    }
    static getAllWindows() {
      return [];
    }
    loadURL() {}
    on() {}
    setResizable() {}
    setSize() {}
    setPosition() {}
    center() {}
    setTitle() {}
    setIcon() {}
  }
  const electron = {
    app: {
      name: "",
      on: (n: string, f: () => void) => void (handlers[n] = f),
      getPath: () => "/nonexistent-aio-client-test",
      quit() {},
      whenReady: () => new Promise(() => {}),
    },
    BrowserWindow,
    Menu: { setApplicationMenu() {} },
    nativeImage: { createFromBuffer: () => ({}) },
    session: { defaultSession: {} },
  };
  const req = (name: string) =>
    name === "electron"
      ? electron
      : name === "dgram"
      ? dgram
      : nodeRequire(name.startsWith("node:") ? name : "node:" + name);
  const proc = {
    env: {},
    argv: [],
    platform,
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    exit(code: number) {
      throw new Error("process.exit(" + code + ")");
    },
  };
  const con = {
    log() {},
    warn() {},
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
  };
  // Timers are recorded, never armed: the sweep's own timeout and the 4 s
  // re-scan are driven by hand.
  const api = new Function(
    "require",
    "process",
    "console",
    "setInterval",
    "setTimeout",
    electronClientScript(null) +
      "\nreturn { discoverApps, note: () => _discoveryNote };",
  )(
    req,
    proc,
    con,
    () => 0,
    (f: () => void) => (timers.push(f), timers.length),
  );
  return {
    /** Fire every timer the script has asked for so far (a sweep's timeout). */
    runTimers() {
      for (const f of timers.splice(0)) f();
    },
    api: api as {
      discoverApps: (ms: number, cb: (a: unknown[]) => void) => void;
      note: () => string;
    },
    errors,
    injected,
    /** Open the connect page and run its first sweep. */
    openConnectPage() {
      handlers["ready"]!();
      for (const f of loaded) f();
    },
  };
}

/** A socket that binds and sends, and whose handlers the test can fire. */
function liveSocket(socks: Sock[]) {
  return {
    createSocket: () => {
      const s: Sock = { handlers: {} };
      socks.push(s);
      return {
        on: (n: string, f: (...e: unknown[]) => void) =>
          void (s.handlers[n] = f),
        bind: (f: () => void) => f(),
        setBroadcast() {},
        close() {},
        send: (_p: unknown, _n: number, _t: string, cb: (e: unknown) => void) =>
          cb(null),
      };
    },
  };
}
const enetdown = () =>
  Object.assign(new Error("recvmsg ENETDOWN"), { code: "ENETDOWN" });

Deno.test("aio-client discovery: a socket `error` event is said once, with the OS reason, and the sweep still answers", () => {
  for (const platform of ["linux", "darwin"]) {
    const socks: Sock[] = [];
    const c = boot(liveSocket(socks), platform);
    const answers: unknown[][] = [];
    for (let sweep = 0; sweep < 3; sweep++) {
      c.api.discoverApps(5, (apps) => answers.push(apps));
      socks.at(-1)!.handlers["error"]!(enetdown());
    }
    assertEquals(answers, [[], [], []], "every sweep ends, empty");
    assertEquals(c.errors.length, 1, `once, not per sweep: ${c.errors}`);
    assertMatch(
      c.errors[0]!,
      /discovery: the search socket failed \(ENETDOWN\)/,
    );
    assertMatch(c.errors[0]!, /Type the address instead/);
    assertEquals(c.errors[0]!.includes("Local Network"), platform === "darwin");
    assert(!/255\.255|:\/\//.test(c.errors[0]!), `an address: ${c.errors[0]}`);
  }
});

Deno.test("aio-client discovery: a socket that cannot be opened is said once too", () => {
  const c = boot({
    createSocket() {
      throw Object.assign(new Error("socket EMFILE"), { code: "EMFILE" });
    },
  });
  const answers: unknown[][] = [];
  c.api.discoverApps(5, (apps) => answers.push(apps));
  c.api.discoverApps(5, (apps) => answers.push(apps));
  assertEquals(answers, [[], []]);
  assertEquals(c.errors.length, 1, String(c.errors));
  assertMatch(c.errors[0]!, /search socket could not be opened \(EMFILE\)/);
});

Deno.test("aio-client discovery: the connect page shows the reason where it said 'searching…' — and only while sweeps fail", () => {
  const socks: Sock[] = [];
  const c = boot(liveSocket(socks));
  c.openConnectPage();
  const note = () =>
    c.injected.filter((js) => js.includes("#discovered .empty"));
  assertEquals(note(), [], "a sweep still running says nothing");
  socks.at(-1)!.handlers["error"]!(enetdown());
  assertEquals(note().length, 1, c.injected.join("\n"));
  assertMatch(note()[0]!, /search unavailable \(ENETDOWN\)/);
  // …in the order the page needs: the list first (it draws "searching…"),
  // then the reason over it, then the end of the sweep.
  assertMatch(
    c.injected.join("\n"),
    /__aioSetDiscovered\(\[\]\)[\s\S]*#discovered \.empty[\s\S]*__aioScanDone/,
  );
  // The element it writes into is the one the shipped connect page draws.
  assertMatch(
    electronClientScript(null),
    /id="discovered"[\s\S]*<div class="empty">searching/,
  );

  // A sweep that works forgets the reason: nothing is written over a
  // healthy search.
  assertMatch(c.api.note(), /ENETDOWN/);
  c.api.discoverApps(5, () => {});
  assertEquals(c.api.note(), "");
});

Deno.test("aio-client discovery: a sweep answers once — not at the error and again at its timeout", () => {
  const socks: Sock[] = [];
  const c = boot(liveSocket(socks));
  const answers: unknown[][] = [];
  const sweep = () => c.api.discoverApps(5, (apps) => answers.push(apps));
  const app = (port: number) =>
    socks.at(-1)!.handlers["message"]!(
      { toString: () => `AIO1 {"name":"n","port":${port}}` },
      { address: "10.0.0.2" },
    );

  // The error, the same error again, then the timeout that was already armed.
  sweep();
  socks.at(-1)!.handlers["error"]!(enetdown());
  socks.at(-1)!.handlers["error"]!(enetdown());
  c.runTimers();
  assertEquals(answers, [[]], "one answer for one sweep");

  // The other order: a sweep that FOUND an app keeps its answer when the
  // socket then fails on the way out — the late error is not a second, empty
  // answer over the list the page just drew.
  answers.length = 0;
  sweep();
  app(8000);
  c.runTimers();
  socks.at(-1)!.handlers["error"]!(enetdown());
  assertEquals(answers.length, 1);
  assertEquals((answers[0] as { port: number }[]).map((a) => a.port), [8000]);
  assertEquals(c.api.note(), "", "a sweep that answered has nothing to excuse");
});
