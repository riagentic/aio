// A `persist:` object that names neither `include` nor `exclude`.
//
// `CellFieldFilter` has no such member, so it arrives from JS, from a
// `cellDefaults` built at runtime, or from the natural mistake of writing
// `onPersist` INSIDE `persist:` instead of beside it. Nothing refused it, and
// its three readers did not agree on what it meant:
//
//   • the startup report and the trojan `fields` route said `persist=all`
//     (`renderFilter`, `fieldIncluded`),
//   • the store's own projection said `"none"` — `applyCellFieldFilter` falls
//     through to `undefined` and `buildDBStateGetter` skips the cell, so every
//     flush wrote `{}` and each restart came back at the declared defaults,
//   • journal replay read `filter.exclude` as iterable.
//
// Measured on one cell with `journal: true`: `{"c":{"count":2}}` in memory,
// `{}` in the database, and the first boot AFTER A CRASH died with an uncaught
// `TypeError: filter.exclude is not iterable` before the server started — and
// so did every boot after it. Silent total data loss, then an app that could
// not be started at all.
//
// Refused where the intent is still visible, at both layers that can set it —
// the same two-layer treatment `include` AND `exclude` on one filter gets.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { configConflicts } from "../src/server/config.ts";
import { namesNoFilterMode } from "../src/state/cell-helpers.ts";

// deno-lint-ignore no-explicit-any
type D = any;

Deno.test("cell(): a persist filter naming neither include nor exclude is refused, with the fix", () => {
  const e = assertThrows(
    () =>
      cell("c", {
        state: { count: 0 },
        // The mistake: the hook belongs BESIDE `persist:`, not inside it.
        persist: { onPersist: (s: D) => s },
        methods: {
          inc(s: D) {
            s.count += 1;
          },
        },
      } as D),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "[cell:c]");
  assertStringIncludes(e.message, "neither");
  assertStringIncludes(e.message, "onPersist");
  // Both escapes are spelled out — "store it all" and "store nothing".
  assertStringIncludes(e.message, `persist: "all"`);
  assertStringIncludes(e.message, `persist: "none"`);
});

Deno.test("cell(): an EMPTY persist object is refused too — it is the same non-filter", () => {
  assertThrows(
    () => cell("c2", { state: { a: 1 }, persist: {}, methods: {} } as D),
    Error,
    "neither",
  );
});

Deno.test("cellDefaults.persist naming neither list is a config error, not a silent empty store", () => {
  const conflicts = configConflicts({ cellDefaults: { persist: {} } });
  const hit = conflicts.find((c) => c.keys.includes("cellDefaults.persist"));
  assertEquals(hit?.level, "error", JSON.stringify(conflicts));
  assertStringIncludes(hit!.what, "neither");
  assertStringIncludes(hit!.fix, `persist: "none"`);
});

Deno.test("namesNoFilterMode: only an object with neither list — never a real filter", () => {
  for (const v of [{}, { onPersist: 1 }, { publicFields: ["a"] }]) {
    assertEquals(namesNoFilterMode(v), true, JSON.stringify(v));
  }
  for (
    const v of [
      undefined,
      null,
      "all",
      "none",
      { include: [] },
      { exclude: [] },
      { include: ["a"], exclude: ["b"] },
      [],
    ]
  ) {
    assertEquals(namesNoFilterMode(v), false, JSON.stringify(v));
  }
});
