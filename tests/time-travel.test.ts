import { assert, assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import {
  createTT,
  markError,
  parseTTCommand,
  pause,
  record,
  redo,
  resume,
  stateAt,
  toBroadcast,
  travelTo,
  type TTState,
  undo,
} from "../src/diagnostics/time-travel.ts";
import {
  getTTState,
  handleTTMessage,
  resetTT,
  setSendFn,
  subscribeTT,
  type TTMeta,
} from "../src/air/time-travel-panel.ts";
import { useTimeTravel } from "../src/browser-air.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { createServer } from "../src/server/server.ts";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

type S = { count: number };
type A = { type: string };

function makeTT(): TTState<S, A> {
  let tt = createTT<S, A>();
  tt = record(tt, { type: "__init" }, { count: 0 });
  return tt;
}

// ── Pure function tests ──────────────────────────────────────────

Deno.test("tt: createTT returns empty state", () => {
  const tt = createTT<S, A>();
  assertEquals(tt.entries, []);
  assertEquals(tt.index, -1);
  assertEquals(tt.paused, false);
  assertEquals(tt.nextId, 0);
});

Deno.test("tt: record appends entry and increments id", () => {
  let tt = createTT<S, A>();
  tt = record(tt, { type: "A" }, { count: 1 });
  assertEquals(tt.entries.length, 1);
  assertEquals(tt.entries[0]!.id, 0);
  assertEquals(tt.entries[0]!.action, { type: "A" });
  assertEquals(tt.entries[0]!.state, { count: 1 });
  assertEquals(tt.index, 0);
  assertEquals(tt.nextId, 1);

  tt = record(tt, { type: "B" }, { count: 2 });
  assertEquals(tt.entries.length, 2);
  assertEquals(tt.entries[1]!.id, 1);
  assertEquals(tt.index, 1);
  assertEquals(tt.nextId, 2);
});

Deno.test("tt: record caps at 2000, evicts oldest", () => {
  // Entries are state REFERENCES (structural sharing), so the window is deep:
  // memory grows with the deltas, not entries × state size.
  let tt = createTT<S, A>();
  for (let i = 0; i < 2010; i++) {
    tt = record(tt, { type: `A${i}` }, { count: i });
  }
  assertEquals(tt.entries.length, 2000);
  // First entry should be id 10 (0-9 evicted)
  assertEquals(tt.entries[0]!.id, 10);
  assertEquals(tt.entries[tt.entries.length - 1]!.id, 2009);
  assertEquals(tt.index, 1999);
});

Deno.test("tt: record after undo truncates forward entries", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = record(tt, { type: "B" }, { count: 2 });
  assertEquals(tt.entries.length, 3);

  tt = undo(tt); // index 1
  tt = record(tt, { type: "C" }, { count: 10 });
  assertEquals(tt.entries.length, 3); // __init, A, C (B truncated)
  assertEquals(tt.entries[2]!.action, { type: "C" });
  assertEquals(tt.index, 2);
});

Deno.test("tt: undo decrements index and pauses", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = undo(tt);
  assertEquals(tt.index, 0);
  assertEquals(tt.paused, true);
});

Deno.test("tt: undo at index 0 is no-op", () => {
  const tt = makeTT();
  const after = undo(tt);
  assertEquals(after, tt); // same reference — no-op
});

Deno.test("tt: redo increments index, stays paused", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = undo(tt);
  assertEquals(tt.paused, true);
  tt = redo(tt);
  assertEquals(tt.index, 1);
  assertEquals(tt.paused, true); // stays paused
});

Deno.test("tt: redo at end is no-op", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  const after = redo(tt);
  assertEquals(after, tt); // same reference
});

Deno.test("tt: travelTo by id, auto-pauses", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = record(tt, { type: "B" }, { count: 2 });
  tt = record(tt, { type: "C" }, { count: 3 });

  tt = travelTo(tt, 1); // id=1 → second entry (action A)
  assertEquals(tt.index, 1);
  assertEquals(tt.paused, true);
  assertEquals(stateAt(tt), { count: 1 });
});

Deno.test("tt: travelTo invalid id is no-op", () => {
  const tt = makeTT();
  const after = travelTo(tt, 999);
  assertEquals(after, tt);
});

Deno.test("tt: pause / resume toggle", () => {
  let tt = makeTT();
  assertEquals(tt.paused, false);

  tt = pause(tt);
  assertEquals(tt.paused, true);

  tt = resume(tt);
  assertEquals(tt.paused, false);
});

Deno.test("tt: resume truncates forward entries", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = record(tt, { type: "B" }, { count: 2 });
  tt = record(tt, { type: "C" }, { count: 3 });

  tt = travelTo(tt, 1); // back to index 1, paused
  assertEquals(tt.entries.length, 4); // all still there
  tt = resume(tt);
  assertEquals(tt.entries.length, 2); // __init + A (B, C truncated)
  assertEquals(tt.paused, false);
});

Deno.test("tt: stateAt returns correct state", () => {
  let tt = createTT<S, A>();
  assertEquals(stateAt(tt), null);

  tt = record(tt, { type: "__init" }, { count: 0 });
  assertEquals(stateAt(tt), { count: 0 });

  tt = record(tt, { type: "A" }, { count: 42 });
  assertEquals(stateAt(tt), { count: 42 });

  tt = undo(tt);
  assertEquals(stateAt(tt), { count: 0 });
});

Deno.test("tt: toBroadcast omits state, includes action type", () => {
  let tt = makeTT();
  tt = record(tt, { type: "Inc" }, { count: 1 });
  tt = record(tt, { type: "Dec" }, { count: 0 });

  const b = toBroadcast(tt);
  assertEquals(b.index, 2);
  assertEquals(b.paused, false);
  assertEquals(b.entries.length, 3);
  assertEquals(b.entries[0]!.type, "__init");
  assertEquals(b.entries[1]!.type, "Inc");
  assertEquals(b.entries[2]!.type, "Dec");
  // No state in broadcast
  for (const e of b.entries) {
    assertEquals((e as Record<string, unknown>).state, undefined);
  }
});

Deno.test("tt: parseTTCommand parses all commands", () => {
  assertEquals(parseTTCommand("undo"), { cmd: "undo" });
  assertEquals(parseTTCommand("redo"), { cmd: "redo" });
  assertEquals(parseTTCommand("pause"), { cmd: "pause" });
  assertEquals(parseTTCommand("resume"), { cmd: "resume" });
  assertEquals(parseTTCommand("goto:5"), { cmd: "goto", arg: 5 });
  assertEquals(parseTTCommand("goto:0"), { cmd: "goto", arg: 0 });
});

Deno.test("tt: parseTTCommand rejects garbage", () => {
  assertEquals(parseTTCommand("hello"), null);
  assertEquals(parseTTCommand("fly"), null);
  assertEquals(parseTTCommand("goto:"), null);
  assertEquals(parseTTCommand("goto:-1"), null);
  assertEquals(parseTTCommand("goto:abc"), null);
  assertEquals(parseTTCommand("goto:9999999"), null); // network-facing bound
  assertEquals(parseTTCommand(""), null);
});

// ── Integration tests ────────────────────────────────────────────

const TT_PORT = freePort();

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("tt integration: TT commands via WS protocol", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  let state = { count: 0 };
  const ttCommands: string[] = [];

  const server = createServer({
    port: TT_PORT,
    title: "TTTest",
    getUIState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string; payload?: { by?: number } };
      if (a.type === "INC") {
        state = { count: state.count + (a.payload?.by ?? 1) };
        server.broadcast();
      }
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    onTTCommand: (cmd, arg) => {
      ttCommands.push(arg !== undefined ? `${cmd}:${arg}` : cmd);
    },
    getTTBroadcast: () => ({ entries: [], index: 0, paused: false }),
  });

  await new Promise((r) => setTimeout(r, 50));

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${TT_PORT}/ws`);
    const received: string[] = [];
    ws.addEventListener("message", (e) => {
      received.push(e.data as string);
    });
    await new Promise<void>((resolve, reject) => {
      // Fail fast instead of hanging forever if the upgrade never completes
      const timer = setTimeout(
        () => reject(new Error("ws connect timeout")),
        5000,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("ws connect failed"));
      };
    });
    await waitFor(() => received.length >= 1); // initial state

    // Should receive TT metadata on connect
    await waitFor(() => received.some((m) => m.includes('"t":"tt-state"')));
    const ttMsg = received.find((m) => m.includes('"t":"tt-state"'))!;
    const ttData = JSON.parse(ttMsg).d;
    assertEquals(ttData.paused, false);

    // Send TT commands
    for (const cmd of ["undo", "redo", "goto:3", "pause", "resume"]) {
      ws.send(JSON.stringify({ v: 2, t: "tt-cmd", d: { cmd } }));
    }

    await waitFor(() => ttCommands.length >= 5);
    assertEquals(ttCommands, ["undo", "redo", "goto:3", "pause", "resume"]);

    // Regular action should still work
    ws.send(
      JSON.stringify({
        v: 2,
        t: "action",
        d: { type: "INC", payload: { by: 5 } },
      }),
    );
    await waitFor(() => state.count === 5);

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tt integration: paused dispatch drops actions", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = undo(tt); // pauses

  assertEquals(tt.paused, true);
  // Simulating what aio.ts does: check paused before reducing
  const shouldSkip = tt.paused;
  assertEquals(shouldSkip, true);
  // State stays at index 0
  assertEquals(stateAt(tt), { count: 0 });
});

Deno.test("tt: entries store the state reference — immutability is the store's", () => {
  // Committed state is a fresh immutable tree per action (Immer, frozen in
  // dev where TT runs), so the reference IS the snapshot. This replaced a
  // structuredClone per dispatch (~1 MB/s at 60 fps in the space-invaders
  // field report). Distinct commits keep distinct references.
  let tt = createTT<{ count: number }, A>();
  const s1 = Object.freeze({ count: 1 });
  const s2 = Object.freeze({ count: 2 });
  tt = record(tt, { type: "A" }, s1);
  tt = record(tt, { type: "B" }, s2);
  assertEquals(tt.entries[0]!.state === s1, true, "no copy, no serialization");
  assertEquals(tt.entries[1]!.state === s2, true);
  assertEquals(tt.entries[0]!.state.count, 1, "history preserved per commit");
});

Deno.test("tt: non-serializable state records fine (no clone step to fail)", () => {
  let tt = createTT<{ fn: () => void; count: number }, A>();
  const live = { fn: () => {}, count: 0 };
  tt = record(tt, { type: "A" }, live);
  assertEquals(tt.entries[0]!.state.count, 0);
  assertEquals(typeof tt.entries[0]!.state.fn, "function");
});

Deno.test("tt integration: state restores correctly on undo/redo cycle", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  tt = record(tt, { type: "B" }, { count: 2 });
  tt = record(tt, { type: "C" }, { count: 3 });

  assertEquals(stateAt(tt), { count: 3 });

  // Undo all the way back
  tt = undo(tt);
  assertEquals(stateAt(tt), { count: 2 });
  tt = undo(tt);
  assertEquals(stateAt(tt), { count: 1 });
  tt = undo(tt);
  assertEquals(stateAt(tt), { count: 0 });

  // Redo forward
  tt = redo(tt);
  assertEquals(stateAt(tt), { count: 1 });
  tt = redo(tt);
  assertEquals(stateAt(tt), { count: 2 });
  tt = redo(tt);
  assertEquals(stateAt(tt), { count: 3 });

  // Jump to specific entry
  tt = travelTo(tt, 1); // __init=0, A=1
  assertEquals(stateAt(tt), { count: 1 });
});

Deno.test("tt integration: resume then record branches correctly", () => {
  let tt = makeTT(); // [__init:0]
  tt = record(tt, { type: "A" }, { count: 1 }); // [__init, A]
  tt = record(tt, { type: "B" }, { count: 2 }); // [__init, A, B]
  tt = record(tt, { type: "C" }, { count: 3 }); // [__init, A, B, C]

  tt = travelTo(tt, 1); // go to A (index 1), paused
  assertEquals(tt.paused, true);
  assertEquals(tt.entries.length, 4); // all still exist

  tt = resume(tt); // truncate forward
  assertEquals(tt.entries.length, 2); // [__init, A]
  assertEquals(tt.paused, false);

  // New branch
  tt = record(tt, { type: "D" }, { count: 10 });
  assertEquals(tt.entries.length, 3); // [__init, A, D]
  assertEquals(stateAt(tt), { count: 10 });
  assertEquals(tt.entries[2]!.action, { type: "D" });
});

Deno.test("tt: markError tags current entry, error travels over broadcast", () => {
  let tt = makeTT();
  tt = record(tt, { type: "A" }, { count: 1 });
  markError(tt, { code: "E_FX", message: "boom" });

  const b = toBroadcast(tt);
  assertEquals(b.entries[1]!.error, { code: "E_FX", message: "boom" });
  assertEquals(b.entries[0]!.error, undefined); // only current entry tagged
});

// ═══════════════════════════════════════════════════════════════════
// Browser side — useTimeTravel hook (src/air/time-travel-air.ts via
// src/browser-air.ts) and panel (src/air/time-travel-panel.ts).
//
// Test ORDER matters for module-level state:
//   - Hook tests run BEFORE any resetTT(): resetTT clears the panel
//     Listeners set, which would sever the hook's one-time subscription
//     (_ttSubbed latch never re-subscribes).
//   - The "hook returns null" test runs before the first handleTTMessage
//     call in this process.
// ═══════════════════════════════════════════════════════════════════

/** Build a wire-format __tt: payload like the server broadcasts. */
function ttJSON(
  entries: { id: number; type: string; ts?: number }[],
  index: number,
  paused = false,
): string {
  return JSON.stringify({
    entries: entries.map((e) => ({ ...e, ts: e.ts ?? 1_000_000 })),
    index,
    paused,
  });
}

/** happy-dom window installed as the global `document` (panel uses globals). */
function setupDOM(): {
  win: Window;
  doc: Document;
  root: HTMLElement;
  cleanup: () => Promise<void>;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).document = doc;
  return {
    win,
    doc,
    root,
    cleanup: async () => {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).document;
      await win.happyDOM.close();
    },
  };
}

function pressCtrlPeriod(win: Window, doc: Document): void {
  const ev = new win.KeyboardEvent("keydown", {
    ctrlKey: true,
    code: "Period",
    cancelable: true,
  });
  doc.dispatchEvent(ev as unknown as Event);
}

// ── useTimeTravel hook ───────────────────────────────────────────────

Deno.test({
  name: "useTimeTravel: returns null until time travel is active",
  async fn() {
    const { root, cleanup } = setupDOM();
    _setDocument(root.ownerDocument);
    const App = () => {
      const tt = useTimeTravel();
      return h("div", null, tt === null ? "tt-off" : "tt-on");
    };
    const handle = mount(root, App);
    try {
      assertEquals(root.innerHTML, "<div>tt-off</div>");
    } finally {
      _unmount(handle);
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "useTimeTravel: __tt: message activates hook and re-renders with entries/index/paused",
  async fn() {
    const { root, cleanup } = setupDOM();
    _setDocument(root.ownerDocument);
    const App = () => {
      const tt = useTimeTravel();
      if (!tt) return h("div", null, "tt-off");
      return h(
        "div",
        null,
        `n=${tt.entries.length} i=${tt.index} p=${tt.paused} ` +
          tt.entries.map((e) => e.type).join(","),
      );
    };
    const handle = mount(root, App);
    try {
      assertEquals(root.innerHTML, "<div>tt-off</div>");

      // Server broadcasts history — hook goes live
      handleTTMessage(ttJSON([
        { id: 0, type: "__init" },
        { id: 1, type: "INC" },
      ], 1));
      handle._flush();
      assertEquals(root.innerHTML, "<div>n=2 i=1 p=false __init,INC</div>");

      // Server broadcasts a travel-back (paused, earlier index) — hook updates
      handleTTMessage(ttJSON(
        [
          { id: 0, type: "__init" },
          { id: 1, type: "INC" },
        ],
        0,
        true,
      ));
      handle._flush();
      assertEquals(root.innerHTML, "<div>n=2 i=0 p=true __init,INC</div>");
    } finally {
      _unmount(handle);
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "useTimeTravel: undo/redo/goto/pause/resume send wire commands via transport send fn",
  async fn() {
    const { root, cleanup } = setupDOM();
    _setDocument(root.ownerDocument);
    const sent: string[] = [];
    setSendFn((m) => sent.push(m));
    handleTTMessage(ttJSON([
      { id: 0, type: "__init" },
      { id: 1, type: "INC" },
      { id: 2, type: "INC" },
    ], 2));

    const App = () => {
      const tt = useTimeTravel();
      if (!tt) return h("div", null, "tt-off");
      return h(
        "div",
        null,
        h("button", { id: "undo", onClick: () => tt.undo() }, "u"),
        h("button", { id: "redo", onClick: () => tt.redo() }, "r"),
        h("button", { id: "goto", onClick: () => tt.goto(1) }, "g"),
        h("button", { id: "pause", onClick: () => tt.pause() }, "p"),
        h("button", { id: "resume", onClick: () => tt.resume() }, "s"),
      );
    };
    const handle = mount(root, App);
    try {
      assertExists(root.querySelector("#undo"), "hook should be active");
      (root.querySelector("#undo") as HTMLElement).click();
      (root.querySelector("#redo") as HTMLElement).click();
      (root.querySelector("#goto") as HTMLElement).click();
      (root.querySelector("#pause") as HTMLElement).click();
      (root.querySelector("#resume") as HTMLElement).click();
      assertEquals(sent, [
        '{"v":2,"t":"tt-cmd","d":{"cmd":"undo"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"redo"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"goto:1"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"pause"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"resume"}}',
      ]);
    } finally {
      setSendFn(null);
      _unmount(handle);
      await cleanup();
    }
  },
});

// ── Panel — wire protocol + DOM rendering ────────────────────────────

Deno.test({
  name:
    "tt-panel: handleTTMessage stores state, notifies subscribers; bad JSON is swallowed",
  async fn() {
    const { doc, cleanup } = setupDOM();
    resetTT(); // clear residue from hook tests
    try {
      const seen: TTMeta[] = [];
      const unsub = subscribeTT((t) => seen.push(t));

      handleTTMessage(ttJSON([{ id: 0, type: "__init" }], 0));
      assertEquals(getTTState()?.entries.length, 1);
      assertEquals(getTTState()?.index, 0);
      assertEquals(seen.length, 1);
      assertEquals(seen[0]!.entries[0]!.type, "__init");

      // Malformed payload: warn, keep prior state, no throw
      handleTTMessage("{not json");
      assertEquals(getTTState()?.entries.length, 1);
      assertEquals(seen.length, 1);

      unsub();
      handleTTMessage(ttJSON([{ id: 0, type: "__init" }], 0));
      assertEquals(seen.length, 1); // unsubscribed — no more notifications
      assertEquals(doc.getElementById("__aio-tt"), null); // hidden → no panel DOM
    } finally {
      resetTT();
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "tt-panel: Ctrl+. toggles the floating panel; shows position and history entries",
  async fn() {
    const { win, doc, cleanup } = setupDOM();
    resetTT();
    try {
      handleTTMessage(ttJSON([
        { id: 0, type: "__init" },
        { id: 1, type: "ADD_TODO" },
        { id: 2, type: "TOGGLE" },
      ], 2));
      assertEquals(doc.getElementById("__aio-tt"), null); // hidden by default

      pressCtrlPeriod(win, doc);
      const panel = doc.getElementById("__aio-tt");
      assertExists(panel);
      assertEquals(panel.style.display, "flex");
      assert(panel.textContent!.includes("3/3"), "header shows index/total");
      assert(panel.textContent!.includes("ADD_TODO"));
      assert(panel.textContent!.includes("▸ TOGGLE"), "current entry marked");

      pressCtrlPeriod(win, doc); // toggle off
      assertEquals(doc.getElementById("__aio-tt")!.style.display, "none");
    } finally {
      resetTT();
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "tt-panel: buttons and history rows send wire commands (undo/redo/goto/pause→resume)",
  async fn() {
    const { win, doc, cleanup } = setupDOM();
    resetTT();
    const sent: string[] = [];
    setSendFn((m) => sent.push(m));
    try {
      handleTTMessage(ttJSON([
        { id: 0, type: "__init" },
        { id: 1, type: "INC" },
        { id: 2, type: "INC" },
      ], 1));
      pressCtrlPeriod(win, doc);
      const panel = doc.getElementById("__aio-tt")!;

      const buttons = () =>
        Array.from(panel.querySelectorAll("button")) as HTMLButtonElement[];
      let [undoBtn, redoBtn, lockBtn] = buttons();
      assertEquals(undoBtn!.textContent, "◀ undo");
      assertEquals(redoBtn!.textContent, "redo ▶");
      assertEquals(lockBtn!.textContent, "🔒 lock");

      undoBtn!.click();
      redoBtn!.click();
      lockBtn!.click();
      assertEquals(sent, [
        '{"v":2,"t":"tt-cmd","d":{"cmd":"undo"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"redo"}}',
        '{"v":2,"t":"tt-cmd","d":{"cmd":"pause"}}',
      ]);

      // Clicking a history row sends goto:<id> — rows render newest-first
      const list = panel.children[2] as HTMLElement;
      const rows = Array.from(list.children) as HTMLElement[];
      assertEquals(rows.length, 3);
      const initRow = rows.find((r) => r.textContent!.includes("__init"))!;
      initRow.click();
      assertEquals(sent[3], '{"v":2,"t":"tt-cmd","d":{"cmd":"goto:0"}}');

      // Server confirms pause — visible panel re-renders, lock → unlock → resume
      handleTTMessage(ttJSON(
        [
          { id: 0, type: "__init" },
          { id: 1, type: "INC" },
          { id: 2, type: "INC" },
        ],
        1,
        true,
      ));
      assert(panel.textContent!.includes("🔒"), "paused marker in header");
      [undoBtn, redoBtn, lockBtn] = buttons();
      assertEquals(lockBtn!.textContent, "🔓 unlock");
      lockBtn!.click();
      assertEquals(sent[4], '{"v":2,"t":"tt-cmd","d":{"cmd":"resume"}}');
    } finally {
      setSendFn(null);
      resetTT();
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "tt-panel: undo disabled at history start, redo disabled at end — clicks send nothing",
  async fn() {
    const { win, doc, cleanup } = setupDOM();
    resetTT();
    const sent: string[] = [];
    setSendFn((m) => sent.push(m));
    try {
      // Single entry: index is both start and end → both nav buttons disabled
      handleTTMessage(ttJSON([{ id: 0, type: "__init" }], 0));
      pressCtrlPeriod(win, doc);
      const panel = doc.getElementById("__aio-tt")!;
      const [undoBtn, redoBtn] = Array.from(
        panel.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      undoBtn!.click();
      redoBtn!.click();
      assertEquals(sent, []); // disabled buttons have no handler
    } finally {
      setSendFn(null);
      resetTT();
      await cleanup();
    }
  },
});

Deno.test({
  name: "tt-panel: resetTT removes panel, clears state and key binding",
  async fn() {
    const { win, doc, cleanup } = setupDOM();
    resetTT();
    try {
      handleTTMessage(ttJSON([{ id: 0, type: "__init" }], 0));
      pressCtrlPeriod(win, doc);
      assertExists(doc.getElementById("__aio-tt"));

      resetTT();
      assertEquals(doc.getElementById("__aio-tt"), null); // panel removed
      assertEquals(getTTState(), null); // state cleared

      // Key handler unbound — Ctrl+. no longer creates a panel
      pressCtrlPeriod(win, doc);
      assertEquals(doc.getElementById("__aio-tt"), null);
    } finally {
      resetTT();
      await cleanup();
    }
  },
});

Deno.test("markError via reportOpts getter tags the CURRENT entry, not the boot snapshot", async () => {
  // Regression: record() replaces the TTState object per action; capturing the
  // boot value pinned markError to the orphaned __init entry forever.
  const { buildReportOpts } = await import("../src/server/aio-run-helpers.ts");
  const { createTT, record } = await import(
    "../src/diagnostics/time-travel.ts"
  );
  let tt = createTT<{ n: number }, { type: string }>();
  tt = record(tt, { type: "__init" }, { n: 0 });
  const reportOpts = buildReportOpts<{ n: number }>({
    onError: undefined,
    getTT: () => tt,
    prod: false,
  });
  tt = record(tt, { type: "a" }, { n: 1 });
  tt = record(tt, { type: "b" }, { n: 2 });
  reportOpts.tt!.markError({ code: "REDUCE_ERROR", message: "boom" });
  // the CURRENT entry (action b) carries the mark; __init does not
  assertEquals(tt.entries[tt.index]!.error?.code, "REDUCE_ERROR");
  assertEquals(tt.entries[0]!.error, undefined);
});

Deno.test("time-travel: large state records fully — no size cap, no warning", () => {
  // The old clone-based recorder skipped snapshots above 100KB (and needed a
  // once-only warning for it). Reference entries have no serialization step,
  // so a large state keeps FULL history and stays silent.
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(String(a[0]));
  try {
    let tt = createTT<{ blob: string; n: number }, { type: string }>();
    const blob = "x".repeat(200_000);
    for (let i = 0; i < 60; i++) {
      tt = record(tt, { type: `a${i}` }, { blob, n: i });
    }
    assertEquals(warnings.filter((w) => w.includes("time-travel")).length, 0);
    assertEquals(tt.entries.length, 60);
    assertEquals(tt.entries[5]!.state.n, 5, "every entry distinct and intact");
  } finally {
    console.warn = orig;
  }
});
