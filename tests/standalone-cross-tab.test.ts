// Two tabs of ONE standalone app (the `--web` PWA, or the standalone page in a
// browser) share one localStorage key.
//
// THE BUG, measured before the fix: each tab held its own in-memory state and
// wrote the WHOLE document on every change, never reading another tab's write
// (no `storage` listener, no check before writing). Tab A saves ["from-A"],
// tab B — booted earlier, still holding [] — saves ["from-B"]: the store held
// only ["from-B"], and nothing was logged. A tab still on an OLDER build wrote
// its old shape over the data a newer tab had migrated, the same way.
//
// Each "tab" here is its own copy of src/standalone-air.ts (a query string
// makes a new module instance) over ONE shared localStorage, and a `storage`
// event is what a browser fires in every OTHER tab after a write.
import { assert, assertEquals } from "@std/assert";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

type Mod = typeof import("../src/standalone-air.ts");
const SRC = new URL("../src/standalone-air.ts", import.meta.url).href;
let tabs = 0;
const load = async (): Promise<Mod> =>
  await import(`${SRC}?cross-tab=${++tabs}`) as Mod;

type S = { items: string[] };
type A = { type: "add"; v: string };
const KEY = "aio_state";

async function bootTab() {
  const m = await load();
  const app = m.initStandalone<S, A, never>({ items: [] }, {
    reduce: (s, a) => ({ state: { items: [...s.items, a.v] }, effects: [] }),
    execute: () => {},
    persist: true,
    persistDebounceMs: 5,
  });
  return { m, app };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** What a browser fires in the OTHER tabs after a localStorage write. */
const storageEvent = (key: string | null) => {
  const e = new Event("storage") as Event & { key: string | null };
  Object.defineProperty(e, "key", { value: key });
  globalThis.dispatchEvent(e);
};

/** Run `fn` with the console captured, returning what each level said. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<[T, { info: string[]; warn: string[]; error: string[] }]> {
  const said = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };
  const orig = { info: console.info, warn: console.warn, error: console.error };
  console.info = (...a: unknown[]) => void said.info.push(a.join(" "));
  console.warn = (...a: unknown[]) => void said.warn.push(a.join(" "));
  console.error = (...a: unknown[]) => void said.error.push(a.join(" "));
  try {
    return [await fn(), said];
  } finally {
    Object.assign(console, orig);
  }
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "cross-tab: sequential edits in two tabs both survive",
  ...opts,
  async fn() {
    storage.clear();
    const [, said] = await capture(async () => {
      const a = await bootTab();
      const b = await bootTab();
      try {
        a.app.dispatch({ type: "add", v: "from-A" });
        await tick();
        storageEvent(KEY); // the browser tells tab B (and only B)
        assertEquals((b.app.getState() as S).items, ["from-A"]);
        b.app.dispatch({ type: "add", v: "from-B" });
        await tick();
        storageEvent(KEY);
        assertEquals((a.app.getState() as S).items, ["from-A", "from-B"]);
        a.app.dispatch({ type: "add", v: "from-A2" });
        await tick();
      } finally {
        a.m._reset();
        b.m._reset();
      }
    });
    assertEquals(
      (JSON.parse(storage.get(KEY)!) as S).items,
      ["from-A", "from-B", "from-A2"],
    );
    assertEquals(said.error, []);
  },
});

Deno.test({
  name: "cross-tab: a storage event for another key changes nothing",
  ...opts,
  async fn() {
    storage.clear();
    const b = await bootTab();
    try {
      storage.set("unrelated", "x");
      storageEvent("unrelated");
      assertEquals((b.app.getState() as S).items, []);
    } finally {
      b.m._reset();
    }
  },
});

Deno.test({
  name: "cross-tab: a write over another tab's newer save is never silent " +
    "(no storage event delivered — the store wins, the drop is said)",
  ...opts,
  async fn() {
    storage.clear();
    const [, said] = await capture(async () => {
      const a = await bootTab();
      const b = await bootTab();
      try {
        a.app.dispatch({ type: "add", v: "from-A" });
        await tick();
        // No event reaches B: its change is made on the OLD base.
        b.app.dispatch({ type: "add", v: "from-B" });
        await tick();
        // A's save is not overwritten…
        assertEquals((JSON.parse(storage.get(KEY)!) as S).items, ["from-A"]);
        // …B now shows what the store holds…
        assertEquals((b.app.getState() as S).items, ["from-A"]);
        // …and B's next change lands on top of it.
        b.app.dispatch({ type: "add", v: "from-B2" });
        await tick();
        assertEquals(
          (JSON.parse(storage.get(KEY)!) as S).items,
          ["from-A", "from-B2"],
        );
      } finally {
        a.m._reset();
        b.m._reset();
      }
    });
    const line = said.error.find((l) => l.includes("another tab"));
    assert(line, `the dropped change must be said: ${JSON.stringify(said)}`);
    assert(line.includes("add"), line);
  },
});

Deno.test({
  name: "cross-tab: a storage event while this tab has unsaved changes " +
    "adopts the store and says what was dropped",
  ...opts,
  async fn() {
    storage.clear();
    const [, said] = await capture(async () => {
      const a = await bootTab();
      const m = await load();
      const b = m.initStandalone<S, A, never>({ items: [] }, {
        reduce: (s, x) => ({
          state: { items: [...s.items, x.v] },
          effects: [],
        }),
        execute: () => {},
        persist: true,
        persistDebounceMs: 10_000, // B's change stays pending
      });
      try {
        b.dispatch({ type: "add", v: "from-B" });
        a.app.dispatch({ type: "add", v: "from-A" });
        await tick();
        storageEvent(KEY);
        assertEquals((b.getState() as S).items, ["from-A"]);
        m._flushPendingPersist(); // nothing pending any more
        assertEquals((JSON.parse(storage.get(KEY)!) as S).items, ["from-A"]);
      } finally {
        a.m._reset();
        m._reset();
      }
    });
    assert(
      said.error.some((l) => l.includes("another tab") && l.includes("add")),
      JSON.stringify(said),
    );
  },
});

// ── Version stamps: a tab on an OLDER build never writes over a newer one ──

type C = { prefs: { theme?: string; colour?: string } };
type CA = { type: "set"; v: string };
const PKEY = "aio:cross-tab-versions";

async function bootBuild(version: number) {
  const m = await load();
  const declared: C = version >= 2
    ? { prefs: { colour: "none" } }
    : { prefs: { theme: "none" } };
  const app = m.initStandalone<C, CA, never>(declared, {
    reduce: (s, a) => ({
      state: version >= 2
        ? { prefs: { colour: a.v } }
        : { prefs: { theme: a.v } },
      effects: [],
    }),
    execute: () => {},
    persist: true,
    persistKey: PKEY,
    persistDebounceMs: 5,
    restorable: new Set(["prefs"]),
    cells: {
      migrations: new Map(
        version >= 2
          ? [["prefs", {
            version: 2,
            initialState: declared.prefs,
            onMigrate: (s: Record<string, unknown>, from: number) =>
              from < 2 ? { colour: s.theme } : s,
          }]]
          : [],
      ),
      restores: new Map(),
      shaped: new Set(),
    },
  });
  return { m, app };
}

Deno.test({
  name: "cross-tab: a tab on an older build refuses to write over a newer " +
    "build's save, and says reload",
  ...opts,
  async fn() {
    storage.clear();
    storage.set(
      PKEY,
      JSON.stringify({ prefs: { theme: "dark" }, __versions: {} }),
    );
    const [, said] = await capture(async () => {
      const old = await bootBuild(1);
      const neu = await bootBuild(2);
      try {
        assertEquals((neu.app.getState() as C).prefs.colour, "dark");
        neu.app.dispatch({ type: "set", v: "blue" });
        await tick();
        const migrated = storage.get(PKEY)!;
        assertEquals(JSON.parse(migrated).prefs, { colour: "blue" });
        assertEquals(JSON.parse(migrated).__versions.prefs, 2);
        // The old tab: its event is refused, and so is its write.
        storageEvent(PKEY);
        old.app.dispatch({ type: "set", v: "light" });
        await tick();
        assertEquals(storage.get(PKEY), migrated);
      } finally {
        old.m._reset();
        neu.m._reset();
      }
    });
    assert(
      said.error.some((l) => /newer/i.test(l) && /reload/i.test(l)),
      JSON.stringify(said),
    );
  },
});
