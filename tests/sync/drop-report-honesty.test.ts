// A dropped op is reported for what is KNOWN about it, not for the worst case.
//
// One sentence covered all three drop reasons: "this mutation never reached
// the server and is now gone." It is true of `prune-failed` (the buffer
// refused the op before it was ever sent) and of `stale-beyond-retention` (the
// server itself refused it). It is NOT true of `stale-evicted`.
//
// `stale-evicted` is an op that WAS sent — possibly applied, possibly acked
// with the ack lost on a dropped socket — and that this client evicted from a
// full queue because it had sat unconfirmed past its retention. Whether the
// server holds that change is exactly what nobody knows. Telling the user it
// never arrived turns an unknown into a false negative: the app shows "your
// change was lost", the user makes it again, and the server now holds it
// twice. A report that overstates is the same class of bug as a report that
// stays silent.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
  dropReport,
} from "../../src/sync/op-buffer.ts";
import {
  _resetBrowserSync,
  handleSyncLocalAction,
  initBrowserSync,
} from "../../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../../src/state/cell-reactive.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { SYNC_DEFAULTS } from "../../src/sync/types.ts";
import type { CellDef, Msg } from "../../src/state/cell-types.ts";
import type { SyncOp } from "../../src/sync/types.ts";

function shimLocalStorage(): Map<string, string> {
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
  return store;
}

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

Deno.test("sync drop report: an evicted op is not claimed to have never arrived", () => {
  const evicted = dropReport("stale-evicted");
  assert(
    !/never reached the server|never arrived|is now gone/i.test(evicted.what),
    `an evicted op's fate is UNKNOWN, and the report says so: ${evicted.what}`,
  );
  // …and it says what IS known: no ack, and this client has stopped trying.
  assertStringIncludes(evicted.what, "never acknowledged");
  assert(
    /may have been applied|may already/i.test(evicted.what),
    `the report names the possibility it cannot rule out: ${evicted.what}`,
  );
  assert(
    /re-?send|retry|try/i.test(evicted.what + evicted.hint),
    `…and that this client will not re-send it: ${evicted.what}`,
  );

  // The two reasons that DO know the change never landed still say so.
  const refused = dropReport("prune-failed");
  assertStringIncludes(refused.what, "never reached the server");
  const stale = dropReport("stale-beyond-retention");
  assert(
    /the server refused it|was NOT applied/i.test(stale.what),
    `a server refusal is a known fact: ${stale.what}`,
  );

  // Every reason has its own sentence and its own hint — one shared sentence
  // is how the overstatement happened.
  const all =
    (["prune-failed", "stale-evicted", "stale-beyond-retention"] as const)
      .map((r) => dropReport(r));
  assertEquals(new Set(all.map((r) => r.what)).size, 3);
  assertEquals(new Set(all.map((r) => r.hint)).size, 3);
});

Deno.test("sync drop report: the buffer's own eviction path is reported honestly", async () => {
  const drops: string[] = [];
  const buffer = createOpBuffer(createMemoryStorage(), {
    pendingCap: 1,
    staleAfter: 1,
    onDrop: (op, reason) => drops.push(`${op.id}:${reason}`),
  });
  const op = (id: string, ageMs: number): SyncOp => ({
    id,
    cell: "c",
    action: "add",
    payload: id,
    hlc: [1, 0, "n"],
    confirmed: false,
    _clientTs: Date.now() - ageMs,
  });
  assertEquals(await buffer.add(op("a", 10_000)), true);
  assertEquals(await buffer.add(op("b", 0)), true, "the stale one made room");
  assertEquals(drops, ["a:stale-evicted"]);
});

Deno.test("sync drop report: the browser says the honest sentence, not the worst case", async () => {
  const store = shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  // A queue at the pending cap whose every op is older than the 4h retention:
  // the exact state the eviction path exists for.
  const cap = SYNC_DEFAULTS.pendingCap;
  const old = Date.now() - 5 * 3600_000;
  store.set(
    "__aio_sync:bs-drop",
    JSON.stringify({
      ops: Array.from({ length: cap }, (_, i) => ({
        id: `old-${i}`,
        cell: "bs-drop",
        action: "add",
        payload: { args: [i] },
        hlc: [old, i, "other"],
        confirmed: false,
        _clientTs: old,
      })),
    }),
  );
  registerCell(makeSyncCell("bs-drop"));
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    initBrowserSync(() => {});
    handleSyncLocalAction({ type: "bs-drop:add", payload: { args: ["new"] } });
    await new Promise((r) => setTimeout(r, 50));
    const lines = errors.filter((e) => e.includes("stale-evicted"));
    assert(lines.length > 0, `no eviction was reported: ${errors.join("\n")}`);
    for (const line of lines) {
      assert(
        !line.includes("never reached the server"),
        `an evicted op's fate is unknown, and the browser says so: ${line}`,
      );
      assertStringIncludes(line, "never acknowledged");
    }
  } finally {
    console.error = realError;
    _resetBrowserSync();
    _resetCellRegistry();
  }
});
