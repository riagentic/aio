// A corrupt saved state is set aside ONCE, not once per launch.
//
// The restore sets a corrupt `<key>` aside as `<key>.corrupt-<ms>` (see
// standalone-restore-never-overwrites.test.ts) — and then left the corrupt
// blob under `<key>` until the app's first change. A launch that ended before
// a change (killed, closed at once, a crash in the first render) therefore
// set aside ANOTHER full-size copy on every launch, until the store's quota
// was full and every save was refused. Once the copy is proven, `<key>` now
// holds the starting state at once, so the next launch reads valid data.
import { assertEquals } from "@std/assert";
import { _reset, initStandalone } from "../src/standalone-air.ts";

type S = { count: number };
const KEY = "aio:q";
const CORRUPT = '{"count":40'; // a torn blob

Deno.test("restore: a corrupt value is set aside once — launches that never change anything do not pile up copies", async () => {
  const files = new Map<string, string>([[KEY, CORRUPT]]);
  const prev = Object.getOwnPropertyDescriptor(globalThis, "AioNativeStore");
  Object.defineProperty(globalThis, "AioNativeStore", {
    configurable: true,
    writable: true,
    value: {
      get: (k: string) => files.get(k) ?? null,
      has: (k: string) => files.has(k),
      set: (k: string, v: string) => {
        files.set(k, v);
        return true;
      },
      describe: () => "/data/user/0/app.aio.x/files/aio-store",
    },
  });
  const realError = console.error;
  const realInfo = console.info;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  console.info = () => {};
  try {
    for (let launch = 0; launch < 5; launch++) {
      _reset();
      initStandalone<S, { type: string }, never>({ count: 0 }, {
        reduce: (s) => ({ state: s, effects: [] }),
        execute: () => {},
        persistKey: KEY,
        persistDebounceMs: 1,
      });
      // Killed here: no dispatch, no close().
      await new Promise((r) => setTimeout(r, 3));
    }
  } finally {
    console.error = realError;
    console.info = realInfo;
    _reset();
    if (prev) Object.defineProperty(globalThis, "AioNativeStore", prev);
    else delete (globalThis as Record<string, unknown>).AioNativeStore;
  }
  const aside = [...files.keys()].filter((k) =>
    k.startsWith(`${KEY}.corrupt-`)
  );
  assertEquals(aside.length, 1, `one copy per launch: ${[...files.keys()]}`);
  assertEquals(files.get(aside[0]!), CORRUPT, "the copy is byte-exact");
  assertEquals(
    JSON.parse(files.get(KEY)!),
    { count: 0 },
    "the key holds the starting state, readable by the next launch",
  );
  assertEquals(
    errors.filter((e) => e.includes("could not be restored")).length,
    1,
    "said once, at the one launch that found it",
  );
});
