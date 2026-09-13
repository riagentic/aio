// tests/sync/offline-edit-no-false-warning.test.ts — editing something that
// is itself still unconfirmed must not log a reducer failure.
//
// The engine's early check for a method that does not give the same answer
// twice re-ran each local call's method — on CONFIRMED state, not on the state
// the op is applied to (confirmed plus the ops still pending before it). Every
// offline edit of an item created offline therefore replayed `rename("i1")`
// against a state with no `i1`: the method threw, and the browser reducer
// printed "[aio:sync] reducer failed … no item i1" on every such edit, for a
// call that had succeeded and was queued. A warning that fires on correct use
// teaches people to ignore the one that matters.
import { assert, assertEquals } from "@std/assert";
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

const CELL = "oe-notes";

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

type Item = { id: string; text: string; stamp?: number };

function notesCell(): CellDef {
  return {
    __aio: {
      id: CELL,
      state: { items: [] as Item[] },
      machine: false,
      selectors: {},
      actionKeys: ["add", "rename", "touch"],
      effectKeys: [],
      actions: {},
      effects: {},
      bound: false,
      syncConfig: normalizeSyncConfig(true),
      reduce: (draft: Record<string, unknown>, msg: Msg) => {
        const [id, text] = (msg.payload as { args: [string, string] }).args;
        const items = draft.items as Item[];
        if (msg.type === `${CELL}:add`) items.push({ id, text });
        const it = items.find((x) => x.id === id);
        if (msg.type === `${CELL}:rename` || msg.type === `${CELL}:touch`) {
          if (!it) throw new Error(`no item ${id}`);
          it.text = text;
          // A clock read — the shape the determinism check exists to catch.
          if (msg.type === `${CELL}:touch`) it.stamp = Math.random();
        }
      },
    },
  } as unknown as CellDef;
}

async function offline<T>(
  fn: (engine: NonNullable<ReturnType<typeof initBrowserSync>>) => Promise<T>,
): Promise<{ warns: string[]; errors: string[] }> {
  shimLocalStorage();
  _resetBrowserSync();
  _resetCellRegistry();
  registerCell(notesCell());
  const warns: string[] = [];
  const errors: string[] = [];
  const ow = console.warn;
  const oe = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const engine = initBrowserSync(() => {});
  try {
    assert(engine, "engine boots for a sync cell");
    engine.setOnline(false);
    await fn(engine);
  } finally {
    console.warn = ow;
    console.error = oe;
    engine?.dispose();
    _resetBrowserSync();
    _resetCellRegistry();
  }
  return { warns, errors };
}

Deno.test("an offline edit of an item created offline logs no reducer failure", async () => {
  const { warns, errors } = await offline(async (engine) => {
    await engine.handleLocalAction(CELL, "add", { args: ["i1", "hello"] });
    await engine.handleLocalAction(CELL, "rename", { args: ["i1", "world"] });
  });
  assertEquals(
    [...warns, ...errors].filter((l) => l.includes("reducer failed")),
    [],
  );
});

Deno.test("the check still runs on that op's real input: a clock read in it is reported", async () => {
  const { errors } = await offline(async (engine) => {
    await engine.handleLocalAction(CELL, "add", { args: ["i1", "hello"] });
    await engine.handleLocalAction(CELL, "touch", { args: ["i1", "world"] });
  });
  assert(
    errors.some((l) => l.includes(`${CELL}.touch is not deterministic`)),
    `expected the nondeterminism report, got: ${errors.join(" | ")}`,
  );
});

Deno.test("a call that really throws still rejects, with the method's error", async () => {
  let rejected: unknown;
  await offline(async (engine) => {
    try {
      await engine.handleLocalAction(CELL, "rename", { args: ["nope", "x"] });
    } catch (e) {
      rejected = e;
    }
  });
  assert(rejected instanceof Error && /no item nope/.test(rejected.message));
});
