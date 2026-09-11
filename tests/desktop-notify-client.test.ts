// The client half of notify(), measured branch by branch — and the tray's
// click, which is a dispatch through the page's own door.
//
// No window here: the Notification API is a class the test supplies, so every
// permission outcome is reachable and deterministic, and what the runtime
// DOES with each (show / ask then show / say so once) is what is asserted.
import { assert, assertEquals } from "@std/assert";
import {
  focusApp,
  navigateTo,
  requestNotificationPermission,
  showDesktopNotification,
} from "../src/browser/desktop-notify.ts";
import { bindShellTray, runTrayAction } from "../src/browser/tray-actions.ts";
import {
  _resetTransport,
  _takeOfflineQueue,
} from "../src/state/state-transport.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

type G = Record<string, unknown>;
const g = globalThis as G;

function fakeNotification(permission: "default" | "granted" | "denied") {
  const made: { title: string; opts: Record<string, unknown> }[] = [];
  let asked = 0;
  class N {
    static permission = permission;
    static requestPermission() {
      asked++;
      N.permission = "granted";
      return Promise.resolve("granted" as const);
    }
    onclick: ((e: unknown) => void) | null = null;
    closed = false;
    constructor(title: string, opts: Record<string, unknown>) {
      made.push({ title, opts });
      last = this;
    }
    close() {
      this.closed = true;
    }
  }
  let last: N | null = null;
  return { N, made, asked: () => asked, last: () => last };
}

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  return { lines, restore: () => (console.warn = orig) };
}

Deno.test("notify client: granted → shown with the app's icon, tag and body; click focuses and routes", () => {
  const { N, made, last } = fakeNotification("granted");
  const w = captureWarn();
  const focused: string[] = [];
  const pushed: string[] = [];
  g.Notification = N;
  g.__aioShell = { focus: () => focused.push("shell") };
  g.history = {
    pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
  };
  g.location = { origin: "aio://app" };
  try {
    showDesktopNotification({
      title: "Done",
      body: "3 files",
      tag: "job",
      route: "/exports",
    });
    assertEquals(made.length, 1);
    assertEquals(made[0]!.title, "Done");
    assertEquals(made[0]!.opts.body, "3 files");
    assertEquals(made[0]!.opts.tag, "job");
    assertEquals(
      made[0]!.opts.icon,
      "aio://app/icon.png",
      "one app, one monogram",
    );
    last()!.onclick!({});
    assertEquals(
      focused,
      ["shell"],
      "focus goes through the shell bridge when there is one",
    );
    assertEquals(pushed, ["/exports"]);
    assert(last()!.closed, "the card closes once acted on");
    assertEquals(w.lines, [], "nothing to warn about");
  } finally {
    w.restore();
    delete g.Notification;
    delete g.__aioShell;
    delete g.history;
    delete g.location;
  }
});

Deno.test("notify client: default → asks once, then shows; denied → says so ONCE and drops; no API → says so once", async () => {
  const w = captureWarn();
  try {
    const d = fakeNotification("default");
    g.Notification = d.N;
    showDesktopNotification({ title: "First" });
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(d.asked(), 1, "asked the browser");
    assertEquals(
      d.made.map((m) => m.title),
      ["First"],
      "and showed once granted",
    );

    const den = fakeNotification("denied");
    g.Notification = den.N;
    showDesktopNotification({ title: "A" });
    showDesktopNotification({ title: "B" });
    assertEquals(den.made.length, 0, "nothing shown when blocked");
    assertEquals(
      w.lines.filter((l) => /BLOCKED/.test(l)).length,
      1,
      "said once, not per card",
    );

    delete g.Notification;
    showDesktopNotification({ title: "C" });
    showDesktopNotification({ title: "D" });
    assertEquals(
      w.lines.filter((l) => /no Notification API/.test(l)).length,
      1,
    );
    assertEquals(await requestNotificationPermission(), "unsupported");
  } finally {
    w.restore();
    delete g.Notification;
  }
});

Deno.test("notify client: focusApp and navigateTo degrade without a shell or a history", () => {
  delete g.__aioShell;
  delete g.history;
  focusApp(); // no throw
  navigateTo("/x"); // no history: nothing to do, no throw
  assert(true);
});

Deno.test("tray click: a `cell:method` item is dispatched through the page's own door; a route navigates; junk is ignored", () => {
  _resetTransport();
  const h: { fn: ((item: unknown) => void) | null } = { fn: null };
  const pushed: string[] = [];
  g.__aioShell = { onTray: (fn: (item: unknown) => void) => (h.fn = fn) };
  g.history = {
    pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
  };
  try {
    bindShellTray();
    assert(h.fn, "bound to the shell bridge");
    h.fn!({ method: "player:pause", args: [1, "x"] });
    h.fn!({ route: "/library" });
    h.fn!({ method: "nocolon" });
    h.fn!("garbage");
    const queued = _takeOfflineQueue().map((e) =>
      (e as { action: { type: string; payload: unknown } }).action
    );
    assertEquals(
      queued.length,
      1,
      "one dispatch, offline-queued until a transport exists",
    );
    assertEquals(queued[0]!.type, "player:pause");
    assertEquals((queued[0]!.payload as { args: unknown[] }).args, [1, "x"]);
    assertEquals(pushed, ["/library"]);
    runTrayAction({}); // no method, no route: nothing
    assertEquals(_takeOfflineQueue().length, 0);
  } finally {
    delete g.__aioShell;
    delete g.history;
    _resetTransport();
  }
});

Deno.test("server: broadcastUi reaches every WS client AND the UDS peers, and counts them", () => {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (m: string) => sent.push(m),
  } as unknown as WebSocket;
  const meta = {
    id: "c1",
    index: 0,
    subscriptions: null,
    disconnected: false,
  } as unknown as ClientMeta;
  const udsGot: string[] = [];
  let udsClients = 0;
  const b = createBroadcaster({
    connections: new Map([[ws, meta]]),
    payloadStats: new Map(),
    getUIState: () => ({}),
    debug: () => {},
    syncIntervalMs: 1,
    udsBroadcastRef: { fn: (raw: string) => udsGot.push(raw) },
    udsClientCount: () => udsClients,
  });
  try {
    assertEquals(
      b.broadcastUi('{"v":2,"t":"notify","d":{"title":"x"}}'),
      1,
      "one WS client",
    );
    udsClients = 2;
    assertEquals(b.broadcastUi("raw"), 3, "one WS + two UDS");
    assertEquals(udsGot, ["raw"], "the UDS ref is called once, not per peer");
    assertEquals(sent.length, 2);
    const none = createBroadcaster({
      connections: new Map(),
      payloadStats: new Map(),
      getUIState: () => ({}),
      debug: () => {},
      syncIntervalMs: 1,
    });
    assertEquals(
      none.broadcastUi("raw"),
      0,
      "nobody there — the number the server logs on",
    );
    none.shutdown();
  } finally {
    b.shutdown();
  }
});
