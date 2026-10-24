// An icon is window state, and `appIcon()` reached only the UI clients
// connected at the call: a window opened afterwards (a second window, a
// reconnect after sleep, an app that sets its icon in onStart) showed the
// app's own icon until the next call. The server now keeps what was set and
// sends it to every UI client that connects later — on both doors. And the
// zero-port desktop shape (no HTTP server at all) had no `broadcastUi`, so
// its `appIcon()` and `notify()` reached nobody with the window open.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appIcon } from "../src/state/app-icon.ts";
import { cell } from "../src/state/cell.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { appIconPayload } from "../src/state/app-icon.ts";
import { createIconReplay } from "../src/server/icon-replay.ts";
import { _udsOnlyBroadcastUi } from "../src/server/aio-server.ts";
import { createUDSListener } from "../src/server/aio.ts";
import {
  connectRW,
  localEndpoint,
  localIdle,
} from "./local-endpoint-helper.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const frame = (o: Parameters<typeof appIcon>[0]) =>
  enc("icon", appIconPayload(appIcon(o)));
const parts = (raws: string[]) =>
  raws.map((r) => (dec(r)!.d as Record<string, unknown>));

Deno.test("icon replay: a later frame replaces the parts it sets; all-null resets to nothing to replay", () => {
  const warned: string[] = [];
  const r = createIconReplay((m) => warned.push(m));
  r.remember(frame({ tray: "/a.png", tooltip: "busy" }));
  r.remember(frame({ window: "/w.png" }));
  assertEquals(r.frames().length, 2);
  // Both of the first frame's parts set again: it goes.
  r.remember(frame({ tray: "/b.png", tooltip: "2 running" }));
  assertEquals(parts(r.frames()).map((d) => d.tray ?? d.window), [
    "/w.png",
    "/b.png",
  ]);
  // A partial reset is kept: the tray frame still carries the tray.
  r.remember(frame({ tray: null }));
  assertEquals(parts(r.frames()).at(-1), { tray: null, fps: 8 });
  // Everything back to the app's own: nothing a new window needs.
  r.remember(frame({ window: null, tray: null, tooltip: null }));
  assertEquals(r.frames(), []);
  // …and an all-null with nothing kept is not kept either.
  r.remember(frame({ tooltip: null }));
  assertEquals(r.frames(), []);
  assertEquals(warned, []);
});

Deno.test("icon replay: the zero-port shape reaches the socket's clients, and keeps the icon", () => {
  const r = createIconReplay(() => {});
  const sent: string[] = [];
  const ref = { fn: (raw: string) => void sent.push(raw) };
  const icon = frame({ window: "/w.png" });
  assertEquals(_udsOnlyBroadcastUi(icon, r, ref, { fn: () => 1 }), 1);
  assertEquals(sent, [icon]);
  // Nobody connected: nothing sent, the icon still kept for the window.
  assertEquals(_udsOnlyBroadcastUi(icon, r, ref, { fn: () => 0 }), 0);
  assertEquals(sent.length, 1);
  assertEquals(r.frames(), [icon]);
  // A notification is not state: not kept.
  _udsOnlyBroadcastUi(enc("notify", { title: "x" }), r, ref, { fn: () => 1 });
  assertEquals(r.frames(), [icon]);
});

Deno.test({
  name:
    "icon replay: a desktop window that connects after appIcon() is sent the icon after its state",
  sanitizeResources: false, // aio-ok: the probe conn is closed below
  sanitizeOps: false, // aio-ok: as above
  async fn() {
    const dir = await tempDir("aio-icon-replay-");
    const socketPath = localEndpoint(join(dir, "icon.sock"));
    const icon = frame({ window: "/w.png" });
    const uds = createUDSListener(
      socketPath,
      () => ({ c: { n: 1 } }),
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => [icon],
    );
    const conn = await connectRW(socketPath);
    try {
      let text = "";
      const buf = new Uint8Array(65536);
      const deadline = Date.now() + 5000;
      while (!text.includes('"t":"icon"') && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const n = await Promise.race([
          conn.read(buf),
          new Promise<null>((r) => timer = setTimeout(() => r(null), 1000)),
        ]).finally(() => clearTimeout(timer));
        if (n === null) break;
        text += new TextDecoder().decode(buf.subarray(0, n));
      }
      const kinds = text.split("\n").filter(Boolean).map((l) => dec(l)?.t);
      assert(kinds.includes("icon"), text);
      assert(kinds.indexOf("state") < kinds.indexOf("icon"), kinds.join());
    } finally {
      conn.close();
      uds.shutdown();
      await localIdle();
      await dropTempDir(dir);
    }
  },
});

const busy = cell("icon-replay-busy", {
  state: { n: 0 },
  methods: {
    start(s) {
      s.n++;
      s.$do(appIcon({ window: "/busy.png" }));
    },
  },
});

Deno.test("icon replay: a browser/WS client that connects after appIcon() gets it after its state", async () => {
  await using srv = await testServer({ cells: [busy] });
  await busy.start();
  const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
  const kinds: string[] = [];
  let icon: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no icon: ${kinds}`)), 5000);
      ws.addEventListener("message", (e) => {
        const f = dec(String((e as MessageEvent).data));
        if (!f) return;
        kinds.push(f.t);
        if (f.t === "icon") {
          icon = f.d;
          clearTimeout(t);
          resolve();
        }
      });
      ws.addEventListener("error", () => reject(new Error("ws failed")));
    });
    assertEquals(icon, { window: "/busy.png", fps: 8 });
    assert(kinds.indexOf("state") < kinds.indexOf("icon"), kinds.join());
  } finally {
    ws.close();
  }
});
