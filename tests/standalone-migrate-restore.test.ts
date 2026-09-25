// A cell's `version` + `onMigrate` and its per-cell `onRestore`, on the
// runtime that packages into an APK (and that the in-process harnesses boot).
//
// THE BUG, measured before the fix: the standalone runtime restored with a
// bare `deepMerge` against the NEW declared state and stamped no versions, so
//
//   v1 APK stored   { wallet: { cents: 1250 } }
//   v2 declares     { wallet: { amount: 0 } }, version: 1,
//                   onMigrate: (s, from) => from < 1 ? { amount: s.cents } : s
//
//   deno task dev   → onMigrate(…, 0) runs, `amount: 1250`.
//   the same app.ts
//   as an APK       → onMigrate NEVER runs; `cents` is dropped by the merge,
//                     `amount: 0`, and the first write puts that on disk —
//                     the user's balance gone, nothing said.
//
// And a cell's `onRestore` (the per-cell boot repair) never ran at all.
// Both hooks are the server's (aio-boot step 4b / 5); ONE implementation
// (src/state/cell-migrate.ts) now serves both runtimes.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { _reset, aio, cell } from "../src/standalone-air.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  configurable: true,
  writable: true,
});

type App = { getState(): unknown; close(): Promise<void> };

/** One boot of a standalone app, torn down completely. */
async function withApp<T>(
  appId: string,
  cells: unknown[],
  fn: (app: App) => Promise<T> | T,
): Promise<T> {
  _reset();
  try {
    // deno-lint-ignore no-explicit-any
    const app = await aio.run({ appId, cells: cells as any });
    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  } finally {
    _resetAioRuntime();
    _reset();
  }
}

/** Silence the runtime's console for one call, collecting what it said. */
async function quiet<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const said: string[] = [];
  const keep = { i: console.info, w: console.warn, e: console.error };
  const grab = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  console.info = grab;
  console.warn = grab;
  console.error = grab;
  try {
    return [await fn(), said.join("\n")];
  } finally {
    console.info = keep.i;
    console.warn = keep.w;
    console.error = keep.e;
  }
}

Deno.test("standalone restore: onMigrate runs on an older stored shape", async () => {
  storage.clear();
  storage.set("aio:smr1", JSON.stringify({ smrwallet: { cents: 1250 } }));
  const calls: number[] = [];
  // A factory: one cell def binds to exactly one app, and this boots twice.
  const wallet = () =>
    cell("smrwallet", {
      state: { amount: 0 },
      version: 1,
      onMigrate: (s, from) => {
        calls.push(from);
        const old = s as unknown as { cents?: number; amount: number };
        return from < 1 ? { amount: old.cents ?? 0 } : s;
      },
      methods: { noop(_s: { amount: number }) {} },
    });
  const [amount] = await quiet(() =>
    withApp("smr1", [wallet()], (app) => {
      return (app.getState() as { smrwallet: { amount: number } }).smrwallet
        .amount;
    })
  );
  assertEquals(calls, [0], "onMigrate did not run once, from v0");
  assertEquals(amount, 1250, "the stored value was not migrated");
  // …and what reaches the store is the migrated shape, stamped v1, so the
  // NEXT boot does not migrate it again.
  const written = JSON.parse(storage.get("aio:smr1") ?? "{}");
  assertEquals(written.smrwallet, { amount: 1250 });
  calls.length = 0;
  const [again] = await quiet(() =>
    withApp("smr1", [wallet()], (app) => {
      return (app.getState() as { smrwallet: { amount: number } }).smrwallet
        .amount;
    })
  );
  assertEquals(calls, [], "onMigrate ran a second time over migrated data");
  assertEquals(again, 1250);
});

Deno.test("standalone restore: a fresh install never runs onMigrate", async () => {
  storage.clear();
  let ran = 0;
  const c = cell("smrfresh", {
    state: { n: 7 },
    version: 3,
    onMigrate: (s) => {
      ran++;
      return { n: -1 } as typeof s;
    },
    methods: { noop(_s: { n: number }) {} },
  });
  const [n] = await quiet(() =>
    withApp("smr2", [c], (app) => {
      return (app.getState() as { smrfresh: { n: number } }).smrfresh.n;
    })
  );
  assertEquals(ran, 0);
  assertEquals(n, 7);
});

Deno.test("standalone restore: a throwing onMigrate refuses to boot and writes nothing", async () => {
  storage.clear();
  const stored = JSON.stringify({ smrboom: { old: "KEEP-ME" } });
  storage.set("aio:smr3", stored);
  const c = cell("smrboom", {
    state: { fresh: "" },
    version: 2,
    onMigrate: () => {
      throw new Error("hook bug");
    },
    methods: { noop(_s: { fresh: string }) {} },
  });
  await quiet(() =>
    assertRejects(
      () => withApp("smr3", [c], () => {}),
      Error,
      "onMigrate",
    )
  );
  assertEquals(storage.get("aio:smr3"), stored, "the stored data was touched");
});

Deno.test("standalone restore: a cell's onRestore repairs its restored slice", async () => {
  storage.clear();
  storage.set(
    "aio:smr4",
    JSON.stringify({ smrconn: { status: "connected", host: "h" } }),
  );
  let freshRan = 0;
  const c = () =>
    cell("smrconn", {
      state: { status: "idle", host: "" },
      onRestore: (s) => {
        freshRan++;
        return { ...s, status: "idle" };
      },
      methods: { noop(_s: { status: string; host: string }) {} },
    });
  const [slice] = await quiet(() =>
    withApp("smr4", [c()], (app) => {
      return (app.getState() as { smrconn: unknown }).smrconn;
    })
  );
  assertEquals(freshRan, 1);
  assertEquals(slice, { status: "idle", host: "h" });
  // Only when something was restored — a fresh install is not repaired.
  storage.clear();
  freshRan = 0;
  await quiet(() => withApp("smr4", [c()], () => {}));
  assertEquals(freshRan, 0);
});

Deno.test("standalone restore: a downgrade keeps the newer build's fields", async () => {
  storage.clear();
  storage.set(
    "aio:smr5",
    JSON.stringify({
      smrdown: { a: 1, added: "BY-V3" },
      __versions: { smrdown: 3 },
    }),
  );
  const c = cell("smrdown", {
    state: { a: 0 },
    version: 2,
    onMigrate: (s) => s,
    methods: {
      bump(s: { a: number }) {
        s.a += 1;
      },
    },
  });
  const [, said] = await quiet(() =>
    withApp("smr5", [c], async () => {
      await (c as unknown as { bump(): Promise<void> }).bump();
    })
  );
  assert(/NEWER/.test(said), `the downgrade was not said: ${said}`);
  const written = JSON.parse(storage.get("aio:smr5") ?? "{}");
  assertEquals(written.smrdown, { a: 2, added: "BY-V3" });
  // The stamp never regresses.
  assertEquals(written.__versions.smrdown, 3);
});

Deno.test("standalone restore: an app onRestore that mutates and returns nothing keeps the state", async () => {
  storage.clear();
  storage.set("aio:smr6", JSON.stringify({ smrnet: { online: true, n: 4 } }));
  const c = cell("smrnet", {
    state: { online: false, n: 0 },
    methods: { noop(_s: { online: boolean; n: number }) {} },
  });
  _reset();
  let app: App | undefined;
  try {
    const [, said] = await quiet(async () => {
      app = await aio.run({
        appId: "smr6",
        cells: [c] as never,
        onRestore: (s: Record<string, unknown>) => {
          (s.smrnet as { online: boolean }).online = false;
          return undefined as unknown as Record<string, unknown>;
        },
      });
    });
    const s = app!.getState() as { smrnet?: { online: boolean; n: number } };
    assertEquals(s.smrnet, { online: false, n: 4 }, said);
  } finally {
    await quiet(async () => await app?.close());
    _resetAioRuntime();
    _reset();
  }
});

Deno.test("standalone restore: a stored cell this build does not declare is preserved", async () => {
  // A rename (or a cell dropped from a build) — the server carries the slice
  // into every write untouched (aio-boot 5b); the APK must not delete it.
  storage.clear();
  storage.set(
    "aio:smr7",
    JSON.stringify({ smroldname: { score: 99 }, smrkeep: { n: 1 } }),
  );
  const c = cell("smrkeep", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const [state] = await quiet(() =>
    withApp("smr7", [c], async (app) => {
      await (c as unknown as { bump(): Promise<void> }).bump();
      return app.getState() as Record<string, unknown>;
    })
  );
  assert(!("smroldname" in state), "an undeclared slice entered runtime state");
  const written = JSON.parse(storage.get("aio:smr7") ?? "{}");
  assertEquals(written.smrkeep, { n: 2 });
  assertEquals(
    written.smroldname,
    { score: 99 },
    "the undeclared cell's data was deleted from the store",
  );
});

Deno.test("standalone restore: onRestore sees what a shaping onPersist stored", async () => {
  // The documented pair (docs/basics/every-option.md): `onPersist` stores a
  // shape the cell does not declare, `onRestore` reads it back. The restore
  // merge prunes undeclared keys, so the hook must be handed the stored shape
  // — as the server's boot hands it (`runCellRestore`'s `shaped`).
  storage.clear();
  const seen: unknown[] = [];
  const thumb = () =>
    cell("smrthumb", {
      state: { thumbKey: "", thumb: "" },
      onPersist: (s) => ({ key: s.thumbKey }) as never,
      onRestore: (s) => {
        const k = (s as unknown as { key?: string }).key;
        seen.push(k);
        s.thumbKey = k ?? "";
        s.thumb = `loaded:${k}`;
      },
      methods: {
        pick(s: { thumbKey: string; thumb: string }, k: string) {
          s.thumbKey = k;
          s.thumb = "BIG-BYTES";
        },
      },
    });
  const first = thumb();
  await quiet(() =>
    withApp("smr8", [first], async () => {
      await (first as unknown as { pick(k: string): Promise<void> }).pick("K1");
    })
  );
  assertEquals(JSON.parse(storage.get("aio:smr8") ?? "{}").smrthumb, {
    key: "K1",
  });
  const [slice] = await quiet(() =>
    withApp("smr8", [thumb()], (app) => {
      return (app.getState() as { smrthumb: unknown }).smrthumb;
    })
  );
  assertEquals(seen, ["K1"], "onRestore was not handed the stored `key`");
  assertEquals(slice, { thumbKey: "K1", thumb: "loaded:K1" });
});

Deno.test("standalone restore: a renamed field with no version bump is said, not dropped in silence", async () => {
  storage.clear();
  storage.set("aio:smr9", JSON.stringify({ smrdrift: { oldName: "V" } }));
  const c = cell("smrdrift", {
    state: { newName: "" },
    methods: { noop(_s: { newName: string }) {} },
  });
  const [, said] = await quiet(() => withApp("smr9", [c], () => {}));
  assert(
    /shape drift/.test(said) && said.includes("smrdrift.oldName"),
    `the dropped stored field was not named: ${said}`,
  );
});

Deno.test("standalone restore: a store from before version stamps, already in the declared shape, is not migrated from v0", async () => {
  // Every APK store written before `__versions` existed is unstamped — but
  // the build that wrote it may well have declared `version: 2` already.
  // Its slice is then in the CURRENT shape, and `onMigrate(s, 0)` over it is
  // the cookbook's `migratePrefs` reading `old.dark` (gone) — a user's dark
  // theme reset to "light" by an aio update that touched no app code.
  storage.clear();
  storage.set("aio:smr10", JSON.stringify({ smrprefs: { theme: "dark" } }));
  const calls: number[] = [];
  const prefs = () =>
    cell("smrprefs", {
      state: { theme: "light" },
      version: 2,
      onMigrate: (s, from) => {
        calls.push(from);
        const old = s as unknown as { dark?: boolean };
        return from < 2 ? { theme: old.dark ? "dark" : "light" } : s;
      },
      methods: { noop(_s: { theme: string }) {} },
    });
  const [theme] = await quiet(() =>
    withApp("smr10", [prefs()], (app) => {
      return (app.getState() as { smrprefs: { theme: string } }).smrprefs
        .theme;
    })
  );
  assertEquals(calls, [], "onMigrate ran over a slice already in this shape");
  assertEquals(theme, "dark", "the stored value was overwritten");
});

Deno.test("standalone restore: a stamped store with no versioned cell still migrates a cell's first version", async () => {
  // The unstamped-store rule above must not catch a store THIS runtime
  // wrote: an app with no `version` yet, then a build adding `version: 1` +
  // a value-only `onMigrate` — the stored slice was written at v0.
  storage.clear();
  const c0 = cell("smrunit", {
    state: { price: 0 },
    methods: {
      set(s: { price: number }, p: number) {
        s.price = p;
      },
    },
  });
  await quiet(() =>
    withApp("smr11", [c0], async () => {
      await (c0 as unknown as { set(p: number): Promise<void> }).set(12);
    })
  );
  const calls: number[] = [];
  const c1 = cell("smrunit", {
    state: { price: 0 },
    version: 1,
    onMigrate: (s, from) => {
      calls.push(from);
      return from < 1 ? { price: s.price * 100 } : s;
    },
    methods: { noop(_s: { price: number }) {} },
  });
  const [price] = await quiet(() =>
    withApp("smr11", [c1], (app) => {
      return (app.getState() as { smrunit: { price: number } }).smrunit.price;
    })
  );
  assertEquals(calls, [0]);
  assertEquals(price, 1200);
});
