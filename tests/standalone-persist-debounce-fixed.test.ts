// On the standalone runtime (an APK, a web build) `aio.run({ persistDebounceMs
// })` may SHORTEN the lazy store's write window and never widens it past the
// 100 ms default.
//
// The option is the server's SQLite debounce, and an app has ONE `aio.run`
// config for both builds. 1.0.15 began forwarding it to this runtime's store,
// undeclared — so an app that tunes its server's disk writes to a few seconds
// shipped a phone build whose WebView, killed in the background without
// notice, lost that many seconds of changes instead of a tenth of one. The
// other half of that forward is kept: an app that asked for LESS (`0`, write
// on the next tick) got it for two releases, and still does.
import { assertEquals } from "@std/assert";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

Deno.test("standalone aio.run: persistDebounceMs does not widen the store's write window", async () => {
  storage.clear();
  const sa = await import("../src/standalone-air.ts");
  sa._reset();
  const counter = sa.cell("sa_debounce", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  try {
    await sa.aio.run({
      appId: "sa-debounce",
      cells: [counter],
      persist: true,
      persistDebounceMs: 60_000, // a server-sized window
    });
    // deno-lint-ignore no-explicit-any
    (counter as any).bump();
    const saved = () =>
      (storage.get("aio:sa-debounce") ?? "").includes('"n":1');
    const deadline = Date.now() + 5_000;
    while (!saved() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assertEquals(saved(), true, "the change was still unwritten after 5 s");
  } finally {
    sa._reset();
  }
});

Deno.test("standalone aio.run: persistDebounceMs below the default is honoured", async () => {
  const sa = await import("../src/standalone-air.ts");
  // The store's timer is the only one this runtime arms with the debounce:
  // record what it was armed with rather than race a 100 ms clock.
  const realSetTimeout = globalThis.setTimeout;
  const run = async (appId: string, persistDebounceMs?: number) => {
    storage.clear();
    sa._reset();
    const counter = sa.cell(appId.replace("-", "_"), {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n += 1;
        },
      },
    });
    const armed: unknown[] = [];
    globalThis.setTimeout = ((f: () => void, ms?: number, ...a: unknown[]) => {
      armed.push(ms);
      return realSetTimeout(f, ms, ...a);
    }) as typeof setTimeout;
    try {
      await sa.aio.run({
        appId,
        cells: [counter],
        persist: true,
        ...(persistDebounceMs === undefined ? {} : { persistDebounceMs }),
      });
      // deno-lint-ignore no-explicit-any
      (counter as any).bump();
      const saved = () => (storage.get(`aio:${appId}`) ?? "").includes('"n":1');
      const deadline = Date.now() + 5_000;
      while (!saved() && Date.now() < deadline) {
        await new Promise((r) => realSetTimeout(r, 5));
      }
      assertEquals(saved(), true, `${appId}: never written`);
      return armed;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      sa._reset();
    }
  };
  const zero = await run("sa-debounce-0", 0);
  assertEquals([zero.includes(0), zero.includes(100)], [true, false], "0 ms");
  assertEquals((await run("sa-debounce-40", 40)).includes(40), true, "40 ms");
  // The ceiling and the default, by the same instrument.
  const wide = await run("sa-debounce-wide", 60_000);
  assertEquals([wide.includes(100), wide.includes(60_000)], [true, false]);
  assertEquals((await run("sa-debounce-none")).includes(100), true);
});
