// tests/sync/browser-reducer-failure.test.ts — M1, end to end through the
// browser wiring (the ONLY place the reducer's failure signal is produced).
//
// The browser reducer wraps each cell's own `reduce` in try/catch and used to
// return `null` when it threw — the engine's "applied, changed nothing". The
// op was then marked applied and the cursor advanced past it, so no
// re-delivery could ever bring it back: the server had the change, this client
// never would, and neither side could see the difference. The signal for
// "could not apply" has to be distinct from the one for "nothing changed".
import { assert, assertEquals } from "@std/assert";
import {
  _resetBrowserSync,
  handleSyncMessage,
  initBrowserSync,
} from "../../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../../src/state/cell-reactive.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { CellDef, Msg } from "../../src/state/cell-types.ts";

const CELL = "brf-notes";

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

/** A cell whose method THROWS for one payload — the shape a real app ships
 *  when a method assumes something the payload does not carry. */
function throwingCell(): CellDef {
  return {
    __aio: {
      id: CELL,
      state: { items: [] as unknown[] },
      machine: false,
      selectors: {},
      actionKeys: ["add"],
      effectKeys: [],
      actions: {},
      effects: {},
      bound: false,
      syncConfig: normalizeSyncConfig(true),
      reduce: (draft: Record<string, unknown>, msg: Msg) => {
        if (msg.type !== `${CELL}:add`) return;
        const p = msg.payload as { boom?: boolean; text?: string };
        if (p.boom) throw new Error("method threw on this payload");
        (draft.items as unknown[]).push(p.text);
      },
    },
  } as unknown as CellDef;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

Deno.test("M1 (browser): a throwing method does not advance the sync cursor past its op", async () => {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(throwingCell());
  const sent: string[] = [];
  const engine = initBrowserSync((raw) => sent.push(raw));
  try {
    assert(engine, "engine boots for a sync cell");
    await tick();
    sent.length = 0;

    // A catch-up carrying one op this client's reducer cannot apply.
    handleSyncMessage("sync-res", {
      mode: "incremental",
      ops: [{
        id: "peer-1",
        cell: CELL,
        action: "add",
        payload: { boom: true },
        hlc: [1000, 0, "peer"],
        confirmed: true,
        serverTs: 50,
      }],
      lowWater: {},
      lastServerTs: { [CELL]: 50 },
    });
    await tick();

    // The next catch-up request must still ask from BELOW that op. With the
    // throw reported as `null` the cursor read 50 and the op was gone for good.
    await engine.requestSync();
    await tick();
    const req = sent.map((r) => JSON.parse(r)).findLast((m) =>
      m.t === "sync-req"
    );
    assert(req, `expected a sync-req, got ${sent.join(" | ")}`);
    const cursor = req.d.cells[CELL]?.lastServerTs;
    assert(
      cursor === undefined || cursor < 50,
      `the cursor must not pass an op the reducer could not apply (got ${cursor})`,
    );
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("M1 (browser): a method that applies cleanly DOES advance the cursor", async () => {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(throwingCell());
  const sent: string[] = [];
  const engine = initBrowserSync((raw) => sent.push(raw));
  try {
    assert(engine);
    await tick();
    sent.length = 0;
    handleSyncMessage("sync-res", {
      mode: "incremental",
      ops: [{
        id: "peer-2",
        cell: CELL,
        action: "add",
        payload: { text: "hello" },
        hlc: [1000, 0, "peer"],
        confirmed: true,
        serverTs: 50,
      }],
      lowWater: {},
      lastServerTs: { [CELL]: 50 },
    });
    await tick();
    await engine.requestSync();
    await tick();
    const req = sent.map((r) => JSON.parse(r)).findLast((m) =>
      m.t === "sync-req"
    );
    assertEquals(
      req.d.cells[CELL]?.lastServerTs,
      50,
      "a clean fold advances the cursor exactly as before",
    );
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});
