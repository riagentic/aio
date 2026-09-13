// `onConnect` / `onDisconnect` are observe-only and guarded — including when
// they are `async` and REJECT.
//
// The WebSocket layer wrapped each call in try/catch, which only sees a SYNC
// throw. An `async onDisconnect` that failed (a presence write to a service
// that is down) did not throw, it returned a rejected promise, and that
// escaped as an unhandled rejection — logged by the crash handler while the
// app runs, and fatal to the process during shutdown, when every socket
// disconnects at once. With plugins installed `composeHooks` guarded it; with
// only the app's own hook (the common case) nothing did.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("ws hooks: an async onConnect / onDisconnect that rejects is reported, never an unhandled rejection", async () => {
  const escaped: unknown[] = [];
  const onUnhandled = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    escaped.push(e.reason);
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  const warns: string[] = [];
  const prev = getLogger();
  const port = freePort();
  const dir = await tempDir("aio-wshooks-");
  let calls = 0;
  const app = await aio.run({
    cells: [cell("wshooks", { state: { n: 0 }, methods: {} })],
    appId: `wshooks-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    onConnect: async () => {
      calls++;
      await Promise.resolve();
      throw new Error("presence service down (connect)");
    },
    onDisconnect: async () => {
      calls++;
      await Promise.resolve();
      throw new Error("presence service down (disconnect)");
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  setLogger({
    logDir: "",
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn" || lvl === "error") warns.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    await sleep(100);
    const closed = new Promise<void>((r) => ws.onclose = () => r());
    ws.close();
    await closed;
    for (let i = 0; i < 50 && calls < 2; i++) await sleep(20);
    await sleep(100);
    assertEquals(calls, 2, "precondition: both hooks ran");
    assertEquals(
      escaped.map(String),
      [],
      "a rejected hook escaped as an unhandled rejection",
    );
    for (const which of ["connect", "disconnect"]) {
      assert(
        warns.some((w) => w.includes(`presence service down (${which})`)),
        `the on${which} failure is reported, not swallowed: ${warns}`,
      );
    }
  } finally {
    setLogger(prev);
    await app.close();
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
