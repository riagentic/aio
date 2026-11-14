// The standalone runtime (APK, in-process harnesses) shares the server's
// migration pass — and so shared its bug: a cell NEW to an existing install
// had its `onMigrate(defaults, 0)` run, because the hook was gated on the
// merged state (the declared defaults) rather than on a stored slice. An
// upgrade adding `limits` (version 2, `from < 2 → capCents *= 100`) booted
// with 50000 for the declared 500 and stamped v2 — permanent. A cell the
// store holds nothing for is stamped current; its hook is not run.
import { assertEquals, assertStringIncludes } from "@std/assert";
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

async function withApp<T>(
  appId: string,
  cells: unknown[],
  fn: (app: App) => T,
): Promise<[T, string]> {
  const said: string[] = [];
  const keep = { i: console.info, w: console.warn, e: console.error };
  const grab = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  console.info = grab;
  console.warn = grab;
  console.error = grab;
  _reset();
  try {
    // deno-lint-ignore no-explicit-any
    const app = await aio.run({ appId, cells: cells as any });
    try {
      return [fn(app), said.join("\n")];
    } finally {
      await app.close();
    }
  } finally {
    console.info = keep.i;
    console.warn = keep.w;
    console.error = keep.e;
    _resetAioRuntime();
    _reset();
  }
}

Deno.test("standalone restore: a cell new to an existing install is stamped, its onMigrate is not run over the defaults", async () => {
  storage.clear();
  const calls: number[] = [];
  const counter = () =>
    cell("smnccounter", {
      state: { n: 0 },
      methods: { noop(_s: { n: number }) {} },
    });
  const limits = () =>
    cell("smnclimits", {
      version: 2,
      state: { capCents: 500 },
      onMigrate: (s, from) => {
        calls.push(from);
        if (from < 2) s.capCents *= 100; // v1 stored whole units
        return s;
      },
      methods: { noop(_s: { capCents: number }) {} },
    });
  // v1 of the app, already installed: its store holds `smnccounter` only.
  storage.set(
    "aio:smnc",
    JSON.stringify({ smnccounter: { n: 3 }, __versions: {} }),
  );
  const cap = (app: App) =>
    (app.getState() as { smnclimits: { capCents: number } }).smnclimits
      .capCents;
  const [first, said] = await withApp("smnc", [counter(), limits()], cap);
  assertEquals(calls, [], "onMigrate ran over declared defaults");
  assertEquals(first, 500);
  assertStringIncludes(said, "no slice for it");
  // Stamped v2 — the next boot has nothing to migrate either.
  const [again] = await withApp("smnc", [counter(), limits()], cap);
  assertEquals(calls, []);
  assertEquals(again, 500);
});
