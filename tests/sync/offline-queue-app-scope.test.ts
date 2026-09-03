// The offline queue is per APP, not per origin.
//
// `localStorage` is scoped to an ORIGIN, and an app id is not part of an
// origin: two aio apps served from the same host:port (a pinned port, a shared
// host, or simply one app taking over the dev port) wrote their pending ops to
// the same `__aio_sync:<cell>` key for every cell name they had in common.
// App B's first catch-up then flushed app A's unsent mutations into B's server.
// These tests pin the isolation, the one-time adoption of a legacy unscoped
// queue, and the fallback when the page was never told which app it is.
import { assert, assertEquals } from "@std/assert";
import {
  createLocalStorageOpStorage,
  SYNC_STORAGE_PREFIX,
  syncStoragePrefix,
} from "../../src/sync/browser-storage.ts";
import {
  _resetBrowserSync,
  initBrowserSync,
} from "../../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../../src/state/cell-reactive.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { CellDef, Msg } from "../../src/state/cell-types.ts";
import type { SyncOp } from "../../src/sync/types.ts";

function shimLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return store;
}

function op(id: string, cell = "todos", text = id): SyncOp {
  return {
    id,
    cell,
    action: "add",
    payload: { args: [text] },
    hlc: [1, 0, "c1"],
    confirmed: false,
    _clientTs: 1,
  };
}

Deno.test("offline queue: two apps on one origin do not share a cell's queue", async () => {
  shimLocalStorage();
  const appA = createLocalStorageOpStorage(syncStoragePrefix("app-a"));
  await appA.saveOp(op("a-1", "todos", "from app A"));

  const appB = createLocalStorageOpStorage(syncStoragePrefix("app-b"));
  assertEquals(
    await appB.loadOps("todos"),
    [],
    "an app must not inherit another app's offline queue",
  );

  await appB.saveOp(op("b-1", "todos", "from app B"));
  assertEquals((await appA.loadOps("todos")).map((o) => o.id), ["a-1"]);
  assertEquals((await appB.loadOps("todos")).map((o) => o.id), ["b-1"]);
});

Deno.test("offline queue: an app id cannot reshape the key into another app's", () => {
  // `<prefix>:<cell>` — an id carrying the separator must not be able to point
  // at "app-b"'s namespace (or at the unscoped one).
  assertEquals(syncStoragePrefix("app:b"), `${SYNC_STORAGE_PREFIX}.app_b`);
  assert(syncStoragePrefix("x").startsWith(`${SYNC_STORAGE_PREFIX}.`));
  assertEquals(syncStoragePrefix(undefined), SYNC_STORAGE_PREFIX);
  assertEquals(syncStoragePrefix(""), SYNC_STORAGE_PREFIX);
});

Deno.test("offline queue: a legacy unscoped queue is adopted ONCE, loudly", async () => {
  const store = shimLocalStorage();
  // A build from before app-scoping: unscoped keys, plus the two non-document
  // keys that share the prefix and must never be adopted as cell queues.
  const legacy = { ops: [op("old-1", "todos", "written offline")] };
  store.set(`${SYNC_STORAGE_PREFIX}:todos`, JSON.stringify(legacy));
  store.set(`${SYNC_STORAGE_PREFIX}:clientId`, "deadbeef");
  store.set(`${SYNC_STORAGE_PREFIX}:todos.corrupt`, "{broken");

  const appA = createLocalStorageOpStorage(syncStoragePrefix("app-a"));
  assertEquals(
    (await appA.loadOps("todos")).map((o) => o.id),
    ["old-1"],
    "the upgrade must not lose unsent mutations",
  );
  assert(
    !store.has(`${SYNC_STORAGE_PREFIX}:todos`),
    "the legacy key is removed, so it can only ever be adopted once",
  );
  assertEquals(
    store.get(`${SYNC_STORAGE_PREFIX}:clientId`),
    "deadbeef",
    "the sync identity is not a cell queue",
  );
  assertEquals(
    store.get(`${SYNC_STORAGE_PREFIX}:todos.corrupt`),
    "{broken",
    "a forensic copy is not a cell queue",
  );

  // A second app on the same origin finds nothing to adopt — no duplication.
  const appB = createLocalStorageOpStorage(syncStoragePrefix("app-b"));
  assertEquals(await appB.loadOps("todos"), []);
});

Deno.test("offline queue: adoption never overwrites this app's own queue", async () => {
  const store = shimLocalStorage();
  const appA = createLocalStorageOpStorage(syncStoragePrefix("app-a"));
  await appA.saveOp(op("mine", "todos", "mine"));
  // A legacy document appears afterwards (an older build ran in between).
  store.set(
    `${SYNC_STORAGE_PREFIX}:todos`,
    JSON.stringify({ ops: [op("theirs", "todos", "theirs")] }),
  );

  const again = createLocalStorageOpStorage(syncStoragePrefix("app-a"));
  assertEquals(
    (await again.loadOps("todos")).map((o) => o.id),
    ["mine"],
    "an existing scoped queue wins — never merged, never replaced",
  );
  assert(
    store.has(`${SYNC_STORAGE_PREFIX}:todos`),
    "the legacy key is left in place rather than silently discarded",
  );
});

Deno.test("offline queue: no app id keeps the legacy namespace untouched", async () => {
  const store = shimLocalStorage();
  const s = createLocalStorageOpStorage(syncStoragePrefix(undefined));
  await s.saveOp(op("x"));
  assert(
    store.has(`${SYNC_STORAGE_PREFIX}:todos`),
    "an unscoped client still reads and writes the queue it always had",
  );
});

// ── the wiring: browser-sync must actually pass the scope through ──

function makeSyncCell(id: string): CellDef {
  return {
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
  } as unknown as CellDef;
}

function withAppId<T>(appId: string | undefined, fn: () => T): T {
  const g = globalThis as unknown as { __aioConfig?: Record<string, unknown> };
  const prev = g.__aioConfig;
  g.__aioConfig = { ...(prev ?? {}), ...(appId ? { appId } : {}) };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.__aioConfig;
    else g.__aioConfig = prev;
  }
}

Deno.test("browser-sync: the queue lands under the app's own prefix", async () => {
  const store = shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(makeSyncCell("todos"));
  try {
    const { engine } = withAppId("shop", () => ({
      engine: initBrowserSync(() => {}),
    }));
    assert(engine, "a sync cell is registered, so the engine boots");
    await engine.handleLocalAction("todos", "add", { args: ["milk"] });
    await new Promise((r) => setTimeout(r, 10));
    const queueKeys = [...store.keys()].filter((k) => k.endsWith(":todos"));
    assertEquals(
      queueKeys,
      [`${SYNC_STORAGE_PREFIX}.shop:todos`],
      "the pending op is written to this app's namespace only",
    );
  } finally {
    _resetBrowserSync();
    _resetCellRegistry();
  }
});
