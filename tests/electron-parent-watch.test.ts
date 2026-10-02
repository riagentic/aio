// An Electron window dies with the aio server that launched it.
//
// Electron is a plain child: when the server is SIGKILLed, OOM-killed or
// crashes, the window stayed up — "reconnecting" forever — and when the app
// was started again the OLD window reconnected to the NEW server while the
// new server opened its own. Two windows, one app. Both generated main scripts
// now watch the launcher's pid (handed over as AIO_PARENT_PID) and quit when
// it is gone; the launcher passes it. Pinned here on the generated source, so
// no window has to open on anybody's desktop to prove it.
import { assert, assertEquals } from "@std/assert";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import {
  LEAVE_BACKSTOP_MS,
  tmplCrashGuard,
  tmplParentWatch,
} from "../src/electron/electron-shared.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { electronChildEnv } from "../src/electron/electron-spawn.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";

const WATCH =
  /process\.env\.AIO_PARENT_PID[\s\S]*process\.kill\(__aioParent, 0\)[\s\S]*__aioLeave\(/;

Deno.test("electron: the WS shell watches its parent and quits when it is gone", () => {
  const src = electronMainScript("http://127.0.0.1:1/", { title: "t" });
  assert(WATCH.test(src), "parent watch missing from the WS main script");
  // The watch must come AFTER the crash guard defines __aioQuitting, which it sets.
  assert(
    src.indexOf("let __aioQuitting") <
      src.indexOf("process.env.AIO_PARENT_PID"),
    "watch must follow the crash guard (it sets __aioQuitting)",
  );
});

Deno.test("electron: the UDS shell watches its parent and quits when it is gone", () => {
  const src = electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
    meta: { title: "t" },
  });
  assert(WATCH.test(src), "parent watch missing from the UDS main script");
});

Deno.test("electron: the launcher hands its pid to the window", () => {
  // This used to grep electron-spawn.ts for the literal
  // `AIO_PARENT_PID: String(Deno.pid)`, which broke the moment the child's
  // environment moved into a function — while the behaviour it cares about
  // was unchanged. A source grep pins the SPELLING, not the fact. The fact is
  // now a pure function, so ask it: whatever else the environment carries, the
  // parent pid is in it, or the watch above is armed with nothing.
  const { env } = electronChildEnv(31337, () => undefined);
  assertEquals(env.AIO_PARENT_PID, "31337");
  // …and it survives beside the variables that DO get stripped.
  const hijacked = electronChildEnv(
    31337,
    (k) => k === "ELECTRON_RUN_AS_NODE" ? "1" : undefined,
  );
  assertEquals(hijacked.env.AIO_PARENT_PID, "31337");
});

// ── The exit the server causes is not the page's to refuse ───────────────────
//
// Measured (Electron 44.4.1, Linux and macOS, a page whose `beforeunload`
// cancels): `app.quit()` → before-quit, close, will-prevent-unload — and the
// window stays, for good. A SIGTERM takes the same path (Chromium's own
// handler). So a server that was killed, or stopped and told its window to go,
// left the window and its helpers running: 8 of 9 processes, nothing retrying.
// With the veto switched off for THAT quit: before-quit, close,
// will-prevent-unload (ignored), destroyed, closed, will-quit, exit 0.
//
// The emitted block is RUN here against a stub of what it touches, so the
// assertions are about what it does, not about its text.

type Fn = (...a: unknown[]) => void;

/** Run the emitted crash guard — and, as a window shell does, the parent
 *  watch after it — against a stub of what they touch. */
function runWatch(parentAlive: () => boolean, withWatch = true) {
  const calls: string[] = [];
  const appOn = new Map<string, Fn>();
  const sig = new Map<string, Fn[]>();
  const timers: { ms: number; fn: Fn; every: boolean; live: boolean }[] = [];
  const wcOn = new Map<string, Fn>();
  const env = { AIO_PARENT_PID: "4242" };
  const run = new Function(
    "app",
    "process",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "console",
    "require",
    `${tmplCrashGuard()}${withWatch ? tmplParentWatch() : ""}
     return { quitting: () => __aioQuitting, leave: __aioLeave };`,
  );
  const out = run(
    {
      on: (e: string, f: Fn) => appOn.set(e, f),
      quit: () => calls.push("quit"),
      exit: (c: number) => calls.push(`exit ${c}`),
    },
    {
      env,
      kill: (pid: number, s: number) => {
        assertEquals([pid, s], [4242, 0]);
        if (!parentAlive()) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
      on: (s: string, f: Fn) => sig.set(s, [...(sig.get(s) ?? []), f]),
      removeAllListeners: (s: string) => sig.set(s, []),
      exit: (c: number) => calls.push(`process.exit ${c}`),
      stdout: { on() {} },
      stderr: { on() {} },
    },
    (fn: Fn, ms: number) => {
      const t = { ms, fn, every: true, live: true };
      timers.push(t);
      return { unref() {}, t };
    },
    (h: { t: { live: boolean } }) => (h.t.live = false),
    (fn: Fn, ms: number) => timers.push({ ms, fn, every: false, live: true }),
    {
      warn: (m: string) => calls.push(`warn ${m}`),
      error: (m: string) => calls.push(`error ${m}`),
    },
    () => ({ format: (...a: unknown[]) => a.join(" ") }),
  ) as { quitting: () => boolean; leave: (why?: string) => void };
  // The window's page: its veto, as Electron hands it over.
  appOn.get("web-contents-created")!({}, {
    on: (e: string, f: Fn) => wcOn.set(e, f),
  });
  const veto = () => {
    let ignored = false;
    wcOn.get("will-prevent-unload")!({ preventDefault: () => ignored = true });
    return ignored ? "ignored" : "honoured";
  };
  return {
    calls,
    sig,
    timers,
    veto,
    ready: () => appOn.get("ready")!(),
    ...out,
  };
}

Deno.test("server gone: the watch quits with the page's veto OFF, says why, and ends the process itself if the quit hangs", () => {
  let alive = true;
  const w = runWatch(() => alive);
  const tick = w.timers.find((t) => t.every)!;
  assertEquals(tick.ms, 2000);
  tick.fn();
  assertEquals(w.calls, [], "a living server must not close the window");
  // A user's own close keeps the page's say — that is Electron's behaviour.
  assertEquals(w.veto(), "honoured");
  alive = false;
  tick.fn();
  assertEquals(w.calls.length, 2, w.calls.join(" | "));
  assert(w.calls[0]!.includes("the aio server (pid 4242) is gone"), w.calls[0]);
  assertEquals(w.calls[1], "quit");
  assertEquals(w.quitting(), true, "close-to-tray must let this close pass");
  assertEquals(w.veto(), "ignored", "the page could still refuse the exit");
  assertEquals(tick.live, false, "the watch kept polling after it fired");
  // The backstop: a renderer too stuck to unload.
  const back = w.timers.find((t) => !t.every)!;
  assertEquals(back.ms, LEAVE_BACKSTOP_MS);
  back.fn();
  assertEquals(w.calls[2], "exit 0");
  // Once: a second cause does not quit twice.
  w.leave("again");
  assertEquals(w.calls.length, 3);
});

Deno.test("server stop: SIGTERM, SIGINT and SIGHUP take the same exit — registered after ready, replacing what was there", () => {
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const w = runWatch(() => true);
    // A listener from load time (the preload sweep's re-raise) is registered
    // before Chromium's own handler and must not survive beside this one.
    let early = 0;
    w.sig.set(s, [() => early++]);
    assertEquals(w.veto(), "honoured");
    w.ready();
    const now = w.sig.get(s)!;
    assertEquals(now.length, 1, `${s}: the load-time listener is still there`);
    now[0]!();
    assertEquals(early, 0);
    assertEquals(w.calls, ["quit"], `${s}: a stop is not a warning`);
    assertEquals(w.veto(), "ignored", `${s}: the page could refuse the stop`);
  }
});

// ── …and so is the exit a CRASHED main process takes ─────────────────────────
//
// The crash guard answered an uncaught exception with a plain `app.quit()`:
// a page that cancels `beforeunload` kept a window whose main process had just
// thrown — broken, and alive. The client shell has the guard and no parent
// watch, so the exit lives in the guard and every template carries it.

Deno.test("main crash: an uncaught exception quits with the page's veto OFF, exit code 1 — in a shell with no parent watch too", () => {
  for (const withWatch of [true, false]) {
    const w = runWatch(() => true, withWatch);
    assertEquals(w.veto(), "honoured");
    const crash = w.sig.get("uncaughtException")!;
    assertEquals(crash.length, 1);
    crash[0]!(new Error("boom"));
    assertEquals(w.calls.length, 2, w.calls.join(" | "));
    assert(
      w.calls[0]!.includes("uncaught exception in main process") &&
        w.calls[0]!.includes("boom"),
      w.calls[0],
    );
    assertEquals(w.calls[1], "quit");
    assertEquals(w.veto(), "ignored", "the page could keep a crashed window");
    const back = w.timers.find((t) => !t.every)!;
    assertEquals(back.ms, LEAVE_BACKSTOP_MS);
    back.fn();
    assertEquals(w.calls[2], "exit 1", "a crash must not end as a clean exit");
    // A second throw on the way out is noted, and quits nothing twice.
    crash[0]!(new Error("again"));
    assertEquals(w.calls.length, 4);
    assert(w.calls[3]!.includes("exception during quit (ignored)"));
  }
});

Deno.test("app-decided exit: every main-script template carries it, after the crash guard and with ONE veto switch", () => {
  const client = electronClientScript();
  assert(!client.includes("AIO_PARENT_PID"), "the client has no server");
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/", { title: "t" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        meta: { title: "t" },
      }),
      client,
    ]
  ) {
    // The crash guard takes it — nothing quits past the veto switch.
    assert(src.includes("__aioLeave(undefined, 1);"));
    assert(
      !/uncaughtException[\s\S]{0,400}try \{ app\.quit\(\); \}/.test(src),
      "the crash guard quits on its own again",
    );
    assertEquals(src.split("'will-prevent-unload'").length - 1, 1);
    assertEquals(src.split("const __aioLeave = ").length - 1, 1);
    assert(
      src.indexOf("let __aioQuitting") < src.indexOf("const __aioLeave = "),
    );
    new Function(src); // parses
  }
});
