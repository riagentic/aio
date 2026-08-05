// Changing `persistMode` must never look like a fresh install.
//
// `persistMode` decides the LAYOUT of the stored document — one JSON blob
// ("single") vs one row per cell ("multi"). The restore read ONLY the layout
// the current mode uses and treated "nothing there" as a first run, so
// switching (which docs/persistence/auto-persist.md actively recommends)
// booted EMPTY over a full store in one direction and resurrected the stale
// pre-switch blob in the other — both silently, both proven.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

const notes = cell("mode-switch-notes", {
  state: { items: [] as string[] },
  methods: {
    add(s: { items: string[] }, v: string) {
      s.items.push(v);
    },
  },
});

function kvKeys(dir: string): string[] {
  const db = new DatabaseSync(join(dir, "data", "state.db"));
  const rows = db.prepare("SELECT k FROM aio_kv ORDER BY k").all() as Array<
    { k: string }
  >;
  db.close();
  return rows.map((r) => r.k);
}

Deno.test({
  name:
    "persist: switching persistMode migrates the stored document instead of booting empty",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-mode-switch-" });
    const appId = `mode-${crypto.randomUUID().slice(0, 8)}`;
    const boot = (persistMode: "single" | "multi") =>
      aio.run({
        cells: [notes],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
        persistMode,
        persistDebounceMs: 10,
      });
    const items = () =>
      (notes as unknown as { items: string[] }).items as string[];

    try {
      // Written in "single".
      const a = await boot("single");
      await notes.add("one");
      await new Promise((r) => setTimeout(r, 120));
      await a.close();
      assert(kvKeys(dir).includes("state"), kvKeys(dir).join(","));

      // single → multi: the data comes with it…
      const b = await boot("multi");
      try {
        assertEquals(items(), ["one"], "single → multi must not boot empty");
        await notes.add("two");
        await new Promise((r) => setTimeout(r, 120));
      } finally {
        await b.close();
      }
      const afterMulti = kvKeys(dir);
      assert(
        afterMulti.some((k) => k.startsWith("state\u001f")),
        `multi rows written: ${afterMulti.join(",")}`,
      );
      assert(
        !afterMulti.includes("state"),
        `the single-layout copy is retired, not left as a resurrection trap: ${
          afterMulti.join(",")
        }`,
      );

      // …and back again: multi → single keeps BOTH writes (the old bug
      // resurrected the pre-switch "one"-only blob).
      const c = await boot("single");
      try {
        assertEquals(
          items(),
          ["one", "two"],
          "multi → single must not resurrect stale pre-switch state",
        );
        await notes.add("three");
        await new Promise((r) => setTimeout(r, 120));
      } finally {
        await c.close();
      }
      const afterSingle = kvKeys(dir);
      assert(afterSingle.includes("state"), afterSingle.join(","));
      assert(
        !afterSingle.some((k) => k.startsWith("state\u001f")),
        `the multi-layout copy is retired: ${afterSingle.join(",")}`,
      );

      // One more round-trip: nothing accumulated, nothing was lost.
      const d = await boot("single");
      try {
        assertEquals(items(), ["one", "two", "three"]);
      } finally {
        await d.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
