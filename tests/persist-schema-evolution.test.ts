// a field report wishlist #4 / a field report: "Adding fields works; renaming, removing
// or retyping a persisted field has no defined behaviour… I have users with rows
// written by 0.1.0. I would like to write that migration down rather than
// discover it from a broken install."
//
// The behaviour IS defined — in `deepMerge`, which restore runs — it was simply
// never written down. These tests pin each rule so the documentation cannot
// drift from the code, and so an app author can reason about an upgrade without
// reading the framework's source.
import { assertEquals } from "@std/assert";
import { deepMerge } from "../src/state/deep-merge.ts";

Deno.test("evolution: a NEW field gets its declared default", () => {
  // v1 persisted { a }, v2 declares { a, gpuBps } — the case that already worked.
  assertEquals(
    deepMerge({ a: 1, gpuBps: 0 }, { a: 5 }),
    { a: 5, gpuBps: 0 },
    "persisted values win for known keys; new keys arrive at their default",
  );
});

Deno.test("evolution: a REMOVED field is dropped, not carried forever", () => {
  // v1 persisted { a, old }, v2 declares { a }. The stale key does not leak into
  // state — otherwise every deleted field would haunt the app forever.
  assertEquals(
    deepMerge({ a: 1 }, { a: 5, old: "gone" }),
    { a: 5 },
    "a key the schema no longer declares is discarded on restore",
  );
});

Deno.test("evolution: a RETYPED field keeps the schema's default", () => {
  // The persisted value is from the old shape and cannot be trusted into the new
  // one, so the DECLARATION wins. Silent coercion would be the alternative, and
  // it would put a string where the app's types promise a number.
  assertEquals(
    deepMerge({ port: 8000 }, { port: "8000" }),
    { port: 8000 },
    "type mismatch → the declared value, never a coerced one",
  );
  assertEquals(
    deepMerge({ items: [] as unknown[] }, { items: { a: 1 } }),
    { items: [] },
    "an object cannot become an array",
  );
  assertEquals(
    deepMerge({ cfg: { on: true } }, { cfg: null }),
    { cfg: { on: true } },
    "a persisted null cannot wipe a schema object",
  );
});

Deno.test("evolution: a RENAME is a remove + an add (use onMigrate to carry it)", () => {
  // Renaming `ramBps` → `memBps` without a migration loses the value: the old key
  // is dropped, the new one starts at its default. That is the rule to know —
  // and `version` + `onMigrate(state, from)` is where the value is carried over.
  const restored = deepMerge({ memBps: 0 }, { ramBps: 4242 });
  assertEquals(
    restored,
    { memBps: 0 },
    "no automatic rename — data is not guessed",
  );

  // What onMigrate does, in the shape a cell would write:
  const migrated =
    ((s: Record<string, unknown>, persisted: Record<string, unknown>) => {
      if (typeof persisted.ramBps === "number") s.memBps = persisted.ramBps;
      return s;
    })({ ...restored }, { ramBps: 4242 });
  assertEquals(
    migrated,
    { memBps: 4242 },
    "the hook is where a rename is carried",
  );
});

Deno.test("evolution: nested objects merge field by field", () => {
  assertEquals(
    deepMerge(
      { ui: { tab: "home", theme: "dark", added: 1 } },
      { ui: { tab: "settings", removed: true } },
    ),
    { ui: { tab: "settings", theme: "dark", added: 1 } },
    "the same rules apply at every level, not just the top",
  );
});

Deno.test("evolution: an empty-object schema is a dictionary and keeps every key", () => {
  // `state: { byId: {} }` means "arbitrary keys", so restore must not drop them.
  assertEquals(
    deepMerge({}, { anything: 1, nested: { deep: true } }),
    { anything: 1, nested: { deep: true } },
  );
});
