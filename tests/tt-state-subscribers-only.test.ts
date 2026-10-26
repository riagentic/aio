// Dev `tt-state` goes only to a client that SHOWS the history (aipro §9).
//
// It is the whole action log — up to MAX_ENTRIES (2 000) entries, ~240 KB —
// and it was re-sent on every recorded dispatch to EVERY socket: a field app
// with three `peer()` links measured ~104 MB/min of it, to sockets that never
// show a panel. Now: a UI is greeted (Ctrl+. binds on the first frame) and
// keeps receiving it only while it says it wants it (`tt-cmd` `sub`/`unsub`;
// a UI that never says keeps the old behavior); a peer gets none, on WS and
// on the local socket alike.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Window } from "happy-dom";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  _ttHookOn,
  handleTTMessage,
  resetTT,
  setSendFn,
} from "../src/air/time-travel-panel.ts";

const isTT = (f: string) => f.includes('"t":"tt-state"');
const until = async (p: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !p(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return p();
};

const ttsub = cell("ttsub", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
    },
  },
});

function openWs(port: number, first: string) {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = (e) => void frames.push(String(e.data));
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => {
      ws.send(first);
      res();
    };
    ws.onerror = () => rej(new Error("ws failed to open"));
  });
  const closed = new Promise<void>((res) => (ws.onclose = () => res()));
  return { ws, frames, opened, closed, tt: () => frames.filter(isTT).length };
}

Deno.test("ws: tt-state reaches a subscribed UI only — never a peer", async () => {
  await using srv = await testServer({ cells: [ttsub] });
  // A `peer()` says `proto` and never `type`; a page says `type`.
  const peer = openWs(srv.port, enc("proto", protoHello("1.0.0")));
  const ui = openWs(srv.port, enc("type", { kind: "browser" }));
  const bump = (n: number) =>
    ui.ws.send(enc("action", {
      type: "ttsub:bump",
      payload: { args: [] },
      cid: `b${n}`,
    }));
  try {
    await Promise.all([peer.opened, ui.opened]);
    assert(await until(() => ui.tt() >= 1), "a UI is greeted with tt-state");
    bump(1);
    assert(
      await until(() => ui.frames.some((f) => isTT(f) && f.includes("bump"))),
      "a UI that never said keeps the live frames (old clients)",
    );
    assertEquals(peer.tt(), 0, "a peer is sent no history, ever");

    // The panel is closed: `unsub` stops the flush.
    ui.ws.send(enc("tt-cmd", { cmd: "unsub" }));
    await new Promise((r) => setTimeout(r, 100));
    const before = ui.tt();
    bump(2);
    bump(3);
    await until(() => ui.frames.some((f) => f.includes('"cid":"b3"')));
    await new Promise((r) => setTimeout(r, 400)); // past the TT throttle
    assertEquals(ui.tt(), before, "unsubscribed: no tt-state");

    // The panel opens: `sub` answers at once with what it missed, then live.
    ui.ws.send(enc("tt-cmd", { cmd: "sub" }));
    assert(await until(() => ui.tt() === before + 1), "sub sends a fresh one");
    bump(4);
    assert(await until(() => ui.tt() >= before + 2), "…and live ones again");
    assertEquals(peer.tt(), 0, "still nothing to the peer");
  } finally {
    for (const c of [peer, ui]) c.ws.close();
    await Promise.all([peer.closed, ui.closed]);
  }
});

Deno.test("uds: tt-state reaches the window only — never a peer", async () => {
  const dir = await tempDir("aio-uds-ttsub-");
  const cmds: string[] = [];
  const uds = createUDSListener(
    localEndpoint(join(dir, "tt.sock")),
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    {
      onCommand: (c) => void cmds.push(c),
      getBroadcast: () => ({ entries: [], index: 0, paused: false }),
    },
  );
  const te = new TextEncoder();
  const open = async (first: string) => {
    const conn = await connectLocal(uds.socketPath);
    const w = conn.writable.getWriter();
    const r = conn.readable.getReader();
    let got = "";
    void (async () => {
      const td = new TextDecoder();
      for (;;) {
        const { value, done } = await r.read().catch(() => ({
          value: undefined,
          done: true,
        }));
        if (done) return;
        got += td.decode(value);
      }
    })();
    await w.write(te.encode(first + "\n"));
    const tt = () => got.split("\n").filter(isTT).length;
    return { conn, tt, send: (f: string) => w.write(te.encode(f + "\n")) };
  };
  try {
    const peer = await open(enc("proto", protoHello("1.0.0")));
    const win = await open(enc("type", { kind: "electron" }));
    assert(await until(() => win.tt() === 1), "the window is greeted");
    uds.broadcast(enc("tt-state", { entries: [] }));
    assert(await until(() => win.tt() === 2), "…and gets the live frames");
    // The page's own spelling, relayed as-is by the Electron main process.
    await win.send(enc("tt-cmd", { cmd: "unsub" }));
    await new Promise((r) => setTimeout(r, 100));
    uds.broadcast(enc("tt-state", { entries: [] }));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(win.tt(), 2, "unsubscribed: no tt-state");
    await win.send(enc("tt-cmd", { cmd: "sub" }));
    assert(await until(() => win.tt() === 3), "sub sends a fresh one");
    assertEquals(peer.tt(), 0, "a peer is sent no history, ever");
    // The page's `{cmd}` spelling runs a command too — it was dropped here,
    // so the Electron panel's buttons did nothing over the local socket.
    await win.send(enc("tt-cmd", { cmd: "undo" }));
    assert(await until(() => cmds.length === 1), "the page's undo ran");
    assertEquals(cmds, ["undo"]);
    for (const c of [peer, win]) c.conn.close();
  } finally {
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});

Deno.test("client: subscribes while the panel is open or useTimeTravel reads", async () => {
  const win = new Window({ url: "https://localhost" });
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document, prevWin = g.window;
  g.document = win.document;
  g.window = win;
  const sent: string[] = [];
  const cmds = () =>
    sent.map((f) => (JSON.parse(f).d as { cmd: string }).cmd).join(",");
  const ctrlDot = () =>
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", { ctrlKey: true, code: "Period" }),
    );
  try {
    resetTT();
    setSendFn((m) => void sent.push(m));
    const tt = { entries: [], index: 0, paused: false };
    handleTTMessage(tt);
    assertEquals(cmds(), "unsub", "an unwanted frame is declined");
    ctrlDot();
    assertEquals(cmds(), "unsub,sub", "the panel opens: subscribe");
    handleTTMessage(tt);
    assertEquals(cmds(), "unsub,sub", "a wanted frame says nothing");
    ctrlDot();
    assertEquals(cmds(), "unsub,sub,unsub", "the panel closes: unsubscribe");
    _ttHookOn();
    assertEquals(cmds(), "unsub,sub,unsub,sub", "a hook reader subscribes");
    ctrlDot();
    ctrlDot();
    assertEquals(
      cmds(),
      "unsub,sub,unsub,sub",
      "the panel no longer decides",
    );
  } finally {
    setSendFn(null);
    resetTT();
    g.document = prevDoc;
    g.window = prevWin;
    await closeWindow(win);
  }
});
