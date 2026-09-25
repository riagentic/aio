// `persistKey` is a documented SERVER option (default "state"). The standalone
// / Android runtime has always stored under `aio:<appId>`. A round-3 change let
// the standalone `aio.run()` honour `cfg.persistKey` (so testUI's persist
// mounts could get their own key) — and an upgraded APK whose shared app.ts
// set `persistKey` looked up a DIFFERENT native-store entry: the user's saved
// data was silently never read. The harness now passes its key under a
// private symbol; an app's `persistKey` never changes the standalone key.
import { assertEquals } from "@std/assert";
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

Deno.test("standalone persist: an app's server `persistKey` does not move the aio:<appId> store", async () => {
  storage.clear();
  // A phone that ran the previous APK: the notes live under aio:<appId>.
  storage.set(
    "aio:spknotes",
    JSON.stringify({ spknotes: { items: ["user data"] } }),
  );
  _reset();
  const notes = cell("spknotes", {
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
    },
  });
  const app = await aio.run({
    appId: "spknotes",
    persistKey: "notes",
    // deno-lint-ignore no-explicit-any
    cells: [notes] as any,
  });
  try {
    assertEquals(
      (app.getState() as Record<string, unknown>).spknotes,
      { items: ["user data"] },
      "the saved data must be restored from aio:<appId>, whatever the " +
        "server-side persistKey says",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
    _reset();
  }
  assertEquals(storage.has("notes"), false, "nothing written under persistKey");
});
