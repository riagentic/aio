// A server state frame must not overwrite a SYNC cell's optimistic view.
//
// docs/persistence/crdt.md: "UI always reads optimistic". The cell signal of a
// sync cell is driven by the engine (confirmed + ops still awaiting an ack);
// `$patches` and full-state frames used to set that signal to the server's
// slice, which does not hold the pending op yet — so an unrelated write to the
// same cell (another client, a server effect) erased the user's change from
// the screen until its ack came back.
import { assertEquals } from "@std/assert";
import {
  _resetBrowserSync,
  getBrowserSyncEngine,
  handleSyncLocalAction,
  handleSyncMessage,
  initBrowserSync,
  setSyncOnline,
} from "../../src/browser/browser-sync.ts";
import { dec } from "../../src/protocol/envelope.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../../src/state/cell-reactive.ts";
import {
  getCellSignal,
  getStateSignal,
} from "../../src/state/state-signals.ts";
import { _reset, handleMessage } from "../../src/state-core.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { CellDef, Msg } from "../../src/state/cell-types.ts";

function shimLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    configurable: true,
  });
}

const ID = "sfko-todos";
function makeSyncCell(): CellDef {
  return {
    __aio: {
      id: ID,
      state: { items: [] as unknown[], title: "" },
      machine: false,
      selectors: {},
      actionKeys: ["add"],
      effectKeys: [],
      actions: {},
      effects: {},
      bound: false,
      syncConfig: normalizeSyncConfig(true),
      reduce: (draft: Record<string, unknown>, msg: Msg) => {
        if (msg.type === `${ID}:add`) {
          (draft.items as unknown[]).push(
            (msg.payload as { args: unknown[] }).args[0],
          );
        }
      },
    },
  } as unknown as CellDef;
}

type View = { items: unknown[]; title: string };

function fresh(): CellDef {
  shimLocalStorage();
  _reset();
  _resetBrowserSync();
  _resetCellRegistry();
  const def = makeSyncCell();
  registerCell(def);
  return def;
}

function teardown(): void {
  _resetBrowserSync();
  _resetCellRegistry();
  _reset();
}

const tick = () => new Promise((r) => setTimeout(r, 10));
/** Past the frame check (`FRAME_CHECK_MS`, 150). */
const quiet = () => new Promise((r) => setTimeout(r, 200));

async function withPendingOp(
  fn: (sig: { peek(): unknown }) => void,
): Promise<void> {
  const def = fresh();
  try {
    handleMessage({ [ID]: { items: [], title: "" } });
    initBrowserSync(() => {});
    await tick();
    // Local sync call — optimistic, unacked.
    handleSyncLocalAction({ type: `${ID}:add`, payload: { args: ["mine"] } });
    await tick();
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals((sig.peek() as View).items, ["mine"], "precondition");
    fn(sig);
  } finally {
    teardown();
  }
}

Deno.test("sync cell: a $patches frame keeps the pending op in the optimistic view", async () => {
  await withPendingOp((sig) => {
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "renamed" }],
    });
    assertEquals(
      (sig.peek() as View).items,
      ["mine"],
      "pending local op vanished from the optimistic view after a patch",
    );
    // The global state still tracks the server — only the cell signal is the
    // engine's.
    assertEquals((getStateSignal().peek()[ID] as View).title, "renamed");
  });
});

Deno.test("sync cell: a full-state frame keeps the pending op in the optimistic view", async () => {
  await withPendingOp((sig) => {
    handleMessage({ [ID]: { items: [], title: "renamed" } });
    assertEquals(
      (sig.peek() as View).items,
      ["mine"],
      "pending local op vanished from the optimistic view after a full frame",
    );
    assertEquals((getStateSignal().peek()[ID] as View).title, "renamed");
  });
});

Deno.test("sync cell with no engine (not booted / boot failed): state frames still paint it", () => {
  const def = fresh();
  try {
    handleMessage({ [ID]: { items: ["a"], title: "t" } });
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals(sig.peek() as View, { items: ["a"], title: "t" });
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "u" }],
    });
    assertEquals((sig.peek() as View).title, "u");
  } finally {
    teardown();
  }
});

Deno.test("sync cell: before the engine has driven it, a state frame paints it", async () => {
  const def = fresh();
  try {
    initBrowserSync(() => {});
    await tick();
    // Engine up, but it has produced no view for the cell yet: nothing
    // optimistic to protect, and its confirmed state is still the declared
    // initial one — the server's frame is the paint.
    handleMessage({ [ID]: { items: ["srv"], title: "" } });
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals((sig.peek() as View).items, ["srv"]);
  } finally {
    teardown();
  }
});

// …but only while the engine HOLDS something the frame lacks. A server write
// that is no sync op (an async method, serverFn, effect, cron, `am dispatch`)
// reaches the engine only as a push debounced up to 500 ms; with no op
// pending, the frame is the freshest view — `await notes.importAsync()` then
// reading `notes.items` must not see the old list, and a quick
// "building" → "done" must show "building".
type Op = { id: string; hlc: [number, number, string] };
const frames = (sent: string[], t: string) =>
  sent.map(dec).filter((f) => f?.t === t);

/** Engine booted and caught up, one local op sent and still pending. */
async function bootWithPendingOp(sent: string[]): Promise<Op> {
  handleMessage({ [ID]: { items: [], title: "" } });
  initBrowserSync((raw) => void sent.push(raw));
  setSyncOnline(true);
  await tick();
  // Answer the boot catch-up: nothing to replay.
  handleSyncMessage("sync-res", {
    mode: "ops",
    ops: [],
    lowWater: {},
    lastServerTs: { [ID]: 0 },
  });
  await tick();
  handleSyncLocalAction({ type: `${ID}:add`, payload: { args: ["mine"] } });
  await tick();
  const op = frames(sent, "op")[0]?.d as Op | undefined;
  assertEquals(typeof op?.id, "string", "precondition: op sent");
  return op!;
}

async function ack(op: Op, serverTs = 1): Promise<void> {
  handleSyncMessage("sync-ack", {
    cell: ID,
    opId: op.id,
    serverHlc: op.hlc,
    serverTs,
  });
  await tick();
}

async function withAckedOp(
  fn: (sig: { peek(): unknown }) => void,
): Promise<void> {
  const def = fresh();
  try {
    await ack(await bootWithPendingOp([]));
    assertEquals(getBrowserSyncEngine()!.getStatus(ID).pending, 0);
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals((sig.peek() as View).items, ["mine"], "precondition");
    fn(sig);
  } finally {
    teardown();
  }
}

Deno.test("sync cell, nothing pending: a $patches frame (server write) paints at once", async () => {
  await withAckedOp((sig) => {
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "building" }],
    });
    assertEquals((sig.peek() as View).title, "building");
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "done" }],
    });
    assertEquals((sig.peek() as View).title, "done");
  });
});

Deno.test("sync cell, nothing pending: a full-state frame paints at once", async () => {
  await withAckedOp((sig) => {
    handleMessage({ [ID]: { items: ["mine", "imported"], title: "" } });
    assertEquals((sig.peek() as View).items, ["mine", "imported"]);
  });
});

// A frame that arrives WHILE an op is pending is skipped (above) — and the
// server write it carried must not then wait for the debounced push once the
// ack lands: the engine repaints its confirmed state, which lacks that write,
// for up to 500 ms. The skipped frame may predate the op's commit on the
// server, so it cannot simply be painted; the engine asks for the cell.
Deno.test("sync cell: a frame skipped while pending is caught up after the ack", async () => {
  const def = fresh();
  try {
    const sent: string[] = [];
    const op = await bootWithPendingOp(sent);
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "imported" }],
    });
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals(sig.peek() as View, { items: ["mine"], title: "" });
    const reqsBefore = frames(sent, "sync-req").length;
    await ack(op);
    await quiet();
    const reqs = frames(sent, "sync-req");
    assertEquals(
      reqs.length,
      reqsBefore + 1,
      "the ack must ask for the cell the skipped frame changed",
    );
    handleSyncMessage("sync-res", {
      mode: "snapshot",
      reqId: (reqs.at(-1)!.d as { reqId: number }).reqId,
      snapshot: { [ID]: { items: ["mine"], title: "imported" } },
      ops: [],
      lowWater: { [ID]: [Date.now() + 60_000, 0, "s"] },
      lastServerTs: { [ID]: 2 },
    });
    await tick();
    assertEquals(sig.peek() as View, { items: ["mine"], title: "imported" });
  } finally {
    teardown();
  }
});

Deno.test("sync cell: a skipped frame the ack already explains asks for nothing", async () => {
  const def = fresh();
  try {
    const sent: string[] = [];
    const op = await bootWithPendingOp(sent);
    // The op's own commit, broadcast before its ack (key order differs from
    // the engine's view on purpose — equality is by value).
    handleMessage({ [ID]: { title: "", items: ["mine"] } });
    const reqsBefore = frames(sent, "sync-req").length;
    await ack(op);
    await quiet();
    assertEquals(frames(sent, "sync-req").length, reqsBefore);
    assertEquals(
      getCellSignal(ID, def.__aio.state).peek() as View,
      { items: ["mine"], title: "" },
    );
  } finally {
    teardown();
  }
});

// A server-only write painted with nothing pending must survive the user's
// next call: the engine repaints confirmed + the new op, and its confirmed
// state gets the write only by the debounced push (up to 500 ms) — unless the
// frame check has already caught it up.
Deno.test("sync cell: a painted server write does not vanish on the next local call", async () => {
  const def = fresh();
  try {
    const sent: string[] = [];
    await ack(await bootWithPendingOp(sent));
    handleMessage({
      $patches: [{ op: "replace", path: [ID, "title"], value: "X" }],
    });
    const sig = getCellSignal(ID, def.__aio.state);
    assertEquals((sig.peek() as View).title, "X", "precondition: painted");
    const reqsBefore = frames(sent, "sync-req").length;
    await quiet();
    const reqs = frames(sent, "sync-req");
    assertEquals(
      reqs.length,
      reqsBefore + 1,
      "the frame check must ask for the cell the engine lacks a write of",
    );
    handleSyncMessage("sync-res", {
      mode: "snapshot",
      reqId: (reqs.at(-1)!.d as { reqId: number }).reqId,
      snapshot: { [ID]: { items: ["mine"], title: "X" } },
      ops: [],
      lowWater: { [ID]: [Date.now() + 60_000, 0, "s"] },
      lastServerTs: { [ID]: 2 },
    });
    await tick();
    handleSyncLocalAction({ type: `${ID}:add`, payload: { args: ["two"] } });
    await tick();
    assertEquals(sig.peek() as View, { items: ["mine", "two"], title: "X" });
  } finally {
    teardown();
  }
});

// Steady typing: op A's commit echo arrives after A's ack while B is pending
// (skipped), then B's echo after B's ack. Every frame is explained by acked
// ops — no catch-up may be asked for.
Deno.test("sync cell: steady ops with late echoes ask for no extra catch-up", async () => {
  const def = fresh();
  try {
    const sent: string[] = [];
    const a = await bootWithPendingOp(sent);
    const reqsBefore = frames(sent, "sync-req").length;
    await ack(a, 1);
    handleSyncLocalAction({ type: `${ID}:add`, payload: { args: ["b"] } });
    await tick();
    const b = frames(sent, "op")[1]!.d as Op;
    handleMessage({ [ID]: { items: ["mine"], title: "" } }); // A's echo, skipped
    await ack(b, 2);
    handleMessage({ [ID]: { items: ["mine", "b"], title: "" } }); // B's echo
    await quiet();
    assertEquals(frames(sent, "sync-req").length, reqsBefore);
    assertEquals(
      getCellSignal(ID, def.__aio.state).peek() as View,
      { items: ["mine", "b"], title: "" },
    );
  } finally {
    teardown();
  }
});
