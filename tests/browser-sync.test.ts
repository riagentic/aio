// Unit tests for the browser sync wiring (src/browser/browser-sync.ts) — the
// glue between transport, registered cells, and the CRDT engine. Covers: boot
// (idempotence, sync-cell discovery, no-op without sync cells), local-action
// routing (sync vs plain vs framework-internal), wire-frame routing
// (sync-ack/op/sync-res), optimistic signal push, and reset.
import { assert, assertEquals } from "@std/assert";
import {
  _resetBrowserSync,
  getBrowserSyncEngine,
  handleSyncLocalAction,
  handleSyncMessage,
  initBrowserSync,
  setSyncOnline,
  syncCellNames,
} from "../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../src/state/cell-reactive.ts";
import { getCellSignal } from "../src/state/state-signals.ts";
import { normalizeSyncConfig } from "../src/sync/types.ts";
import type { CellDef, Msg } from "../src/state/cell-types.ts";

// In-memory localStorage (tests must not touch the real disk-backed one).
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

/** Minimal sync-enabled cell def (the runtime shape registerCell expects). */
function makeSyncCell(id: string): CellDef {
  const def = {
    __aio: {
      id,
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
        if (msg.type === `${id}:add`) {
          (draft.items as unknown[]).push(
            (msg.payload as { args: unknown[] }).args[0],
          );
        }
      },
    },
  };
  return def as unknown as CellDef;
}

function makePlainCell(id: string): CellDef {
  return {
    __aio: {
      id,
      state: {},
      machine: false,
      selectors: {},
      actionKeys: [],
      effectKeys: [],
      actions: {},
      effects: {},
      bound: false,
    },
  } as unknown as CellDef;
}

function setup() {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(makeSyncCell("bs-todos"));
  registerCell(makePlainCell("bs-plain"));
  const sent: string[] = [];
  const engine = initBrowserSync((raw) => sent.push(raw));
  return { engine, sent };
}

Deno.test("browser-sync: boot discovers sync cells only, is idempotent", async () => {
  const { engine, sent } = setup();
  try {
    await new Promise((r) => setTimeout(r, 10)); // boot catch-up is async
    assert(engine, "engine boots when a sync cell is registered");
    assertEquals(syncCellNames(), new Set(["bs-todos"]));
    assertEquals(getBrowserSyncEngine(), engine);
    // Idempotent — a second init returns the SAME engine.
    assertEquals(initBrowserSync(() => {}), engine);
    // Boot fires an initial catch-up request for offline-queued ops.
    assert(
      sent.some((r) => r.includes('"t":"sync-req"')),
      "boot requests catch-up",
    );
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: no engine when no cell has sync config", () => {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(makePlainCell("bs-only-plain"));
  try {
    assertEquals(initBrowserSync(() => {}), null);
    assertEquals(getBrowserSyncEngine(), null);
    assertEquals(syncCellNames(), new Set());
    // All routing is a safe no-op without an engine.
    assertEquals(handleSyncLocalAction({ type: "bs-only-plain:x" }), false);
    handleSyncMessage("sync-ack", {
      cell: "x",
      opId: "1",
      serverHlc: [1, 0, "s"],
    });
    setSyncOnline(false);
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: local actions route sync cells through the engine", async () => {
  const { sent } = setup();
  try {
    // Sync cell → handled (op goes over the wire as an "op" frame).
    assertEquals(
      handleSyncLocalAction({
        type: "bs-todos:add",
        payload: { args: ["milk"] },
      }),
      true,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert(sent.some((r) => r.includes('"t":"op"')), "op sent on the wire");

    // Plain cell → NOT handled (falls through to the normal dispatch path).
    assertEquals(handleSyncLocalAction({ type: "bs-plain:doIt" }), false);
    // Framework-internal method on a sync cell → plain path too.
    assertEquals(handleSyncLocalAction({ type: "bs-todos:__init" }), false);
    // Malformed type → plain path.
    assertEquals(handleSyncLocalAction({ type: "notacell" }), false);
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: optimistic view lands in the cell signal (UI reads it)", async () => {
  setup();
  try {
    handleSyncLocalAction({ type: "bs-todos:add", payload: { args: ["a"] } });
    await new Promise((r) => setTimeout(r, 10));
    const sig = getCellSignal("bs-todos", { items: [] });
    const items = (sig.value as { items: unknown[] }).items;
    assertEquals(items, ["a"], "optimistic op visible to reactive reads");
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: remote op applies through the cell's own reducer", async () => {
  setup();
  try {
    handleSyncMessage("op", {
      id: "remote-1",
      hlc: [Date.now(), 0, "peer"],
      cell: "bs-todos",
      action: "add",
      payload: { args: ["from-peer"] },
      serverTs: 1234,
    });
    await new Promise((r) => setTimeout(r, 10));
    const sig = getCellSignal("bs-todos", { items: [] });
    assertEquals((sig.value as { items: unknown[] }).items, ["from-peer"]);
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: clientId is stable across engine resets (HLC identity)", async () => {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(makeSyncCell("bs-id"));
  const sent1: string[] = [];
  initBrowserSync((r) => sent1.push(r));
  await new Promise((r) => setTimeout(r, 10)); // let the async catch-up send
  _resetBrowserSync();
  // Same registry, fresh engine — the persisted clientId must be reused.
  const sent2: string[] = [];
  initBrowserSync((r) => sent2.push(r));
  await new Promise((r) => setTimeout(r, 10));
  try {
    const id = (raws: string[]) => {
      const req = raws.map((r) => JSON.parse(r)).find((m) =>
        m.t === "sync-req"
      );
      return req?.d?.clientId;
    };
    assert(id(sent1), "first boot sends a clientId");
    assertEquals(id(sent1), id(sent2), "clientId survives engine restarts");
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});
