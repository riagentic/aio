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

// The engine's snapshot watermark only works if the ack's `serverTs` actually
// reaches it. This wiring dropped the field, so the guard was inert on the one
// surface it exists for — the browser — while the engine-level tests kept
// passing. A frame field the engine branches on has to be tested THROUGH the
// frame router, not around it.
Deno.test("browser-sync: an ack for an op the snapshot already holds does not double-apply", async () => {
  const { sent } = setup();
  try {
    handleSyncLocalAction({ type: "bs-todos:add", payload: { args: ["x"] } });
    await new Promise((r) => setTimeout(r, 10));
    const opFrame = sent.map((r) => JSON.parse(r)).find((m) => m.t === "op");
    assert(opFrame, "the local op went out");

    // A catch-up snapshot lands first — the server's live state, which already
    // contains the op whose ack is still in flight.
    handleSyncMessage("sync-res", {
      mode: "snapshot",
      snapshot: { "bs-todos": { items: [{ args: ["x"] }] } },
      ops: [],
      // Pinned, not wall-clock. The snapshot must UNAMBIGUOUSLY contain the
      // local op, and `[Date.now(), 0, "s"]` does not guarantee that: the op
      // was stamped from the client clock moments earlier, so the two can land
      // in the same millisecond and the tie is then broken by node id — which
      // is a random client uuid compared against "s". That made this test's
      // premise a coin flip rather than a statement.
      lowWater: { "bs-todos": [Date.now() + 60_000, 0, "s"] },
      lastServerTs: { "bs-todos": 100 },
    });
    await new Promise((r) => setTimeout(r, 10));

    // …and only then the ack, stamped at or below the snapshot's cursor.
    handleSyncMessage("sync-ack", {
      cell: "bs-todos",
      opId: opFrame.d.id,
      // At or below the snapshot's cursor — stated, not hoped for.
      serverHlc: [Date.now() + 60_000, 0, "s"],
      serverTs: 100,
    });
    await new Promise((r) => setTimeout(r, 10));

    const sig = getCellSignal("bs-todos", { items: [] });
    assertEquals(
      (sig.value as { items: unknown[] }).items.length,
      1,
      "the snapshot already contained this op — the ack must not re-apply it",
    );
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

Deno.test("browser-sync: a sync cell named 'clientId' is refused — its document would overwrite the identity key", () => {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(makeSyncCell("clientId"));
  try {
    let threw = false;
    try {
      initBrowserSync(() => {});
    } catch (e) {
      threw = true;
      assert(String(e).includes("clientId"), "names the collision");
    }
    assert(threw, "misconfig must throw at the site, dev and prod alike");
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});

// A cell's `sync: { offline: { retention } }` has to REACH the eviction rule.
// It was normalized, typed and documented — and read by nobody, so every cell
// evicted at the shared 4h default no matter what it asked for. An app that
// asked for 7d had its unsent changes thrown away 42× earlier than it said,
// with nothing to see anywhere.
Deno.test("browser-sync: each cell's own retention reaches the eviction rule", async () => {
  const { _retentionMsOf } = await import("../src/browser/browser-sync.ts");
  const withRetention = (id: string, retention?: string): CellDef => {
    const def = makeSyncCell(id);
    (def as unknown as { __aio: { syncConfig: unknown } }).__aio.syncConfig =
      normalizeSyncConfig(
        retention === undefined ? true : { offline: { retention } },
      );
    return def;
  };
  const cells = new Map<string, CellDef>([
    ["patient", withRetention("patient", "7d")],
    ["quick", withRetention("quick", "30s")],
    ["silent", withRetention("silent")],
  ]);

  assertEquals(_retentionMsOf(cells, "patient"), 7 * 86_400_000);
  assertEquals(_retentionMsOf(cells, "quick"), 30_000);
  assertEquals(
    _retentionMsOf(cells, "silent"),
    4 * 3_600_000,
    "a cell that says nothing is normalized to the documented 4h default — " +
      "the same value the buffer would have used, now stated rather than " +
      "assumed",
  );
  assertEquals(
    _retentionMsOf(cells, "not-a-cell"),
    undefined,
    "and an unknown cell is not an error here",
  );
});

// ── Booting without usable localStorage ──────────────────────────────
//
// Every localStorage access in the sync path catches and degrades: reads come
// back empty, writes go nowhere, and `clientId` falls back to a fresh uuid.
// Each of those is the right LOCAL decision and together they were a silent
// lie — `sync: true` kept claiming durable offline state while the offline
// queue no longer survived a reload and the client took a NEW HLC identity on
// every load. A private window, blocked site data, or a partitioned
// third-party context all land here.
Deno.test("browser-sync: booting without usable localStorage is LOUD", async () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    // Exactly what a browser with site data blocked does: the accessor throws.
    get() {
      throw new Error("access to storage is not allowed from this context");
    },
    configurable: true,
  });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.includes("[aio:sync]")) errs.push(line);
    else orig(...a);
  };
  try {
    _resetBrowserSync();
    _resetCellRegistry();
    registerCell(makeSyncCell("bs-nostore"));
    const engine = initBrowserSync(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assert(engine, "sync must still boot — degraded, not dead");
    assertEquals(
      errs.length,
      1,
      `booting without localStorage must be reported exactly once — got:\n` +
        errs.join("\n"),
    );
    assert(
      errs[0]!.includes("no usable localStorage"),
      `the report must name the cause: ${errs[0]}`,
    );
    assert(
      errs[0]!.includes("reload") && errs[0]!.includes("identity"),
      `the report must name BOTH consequences — unsent changes lost on ` +
        `reload, and a new sync identity each load: ${errs[0]}`,
    );
  } finally {
    console.error = orig;
    _resetBrowserSync();
    _resetCellRegistry();
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
