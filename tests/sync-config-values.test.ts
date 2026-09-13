// `sync:` must check the VALUES too, not only the key names.
//
// `normalizeSyncConfig` refuses an unknown KEY, and its own comment gives the
// reason: "a key nothing reads is a feature that silently does not exist, and
// here the cost is the highest in the framework — `sync: { mrege: { count:
// "counter" } }` resolves every conflict last-write-wins instead of the
// strategy the app declared, and the symptom is lost data, later, on someone
// else's machine."
//
// The VALUE decides the merge, and it was not checked at all. Measured:
// `merge: { count: "countre" }` was accepted verbatim; `mergeField`'s switch
// has no default so it returned `undefined`; the engine's catch reported a raw
// `TypeError: Cannot read properties of undefined (reading 'value')`; and the
// field resolved last-write-wins. Exactly the failure the key check exists to
// prevent, applied to the half that decides the answer. aio apps are
// transpiled, not type-checked, at runtime, so a typo'd strategy ships.
import { assertEquals, assertThrows } from "@std/assert";
import { normalizeSyncConfig } from "../src/sync/types.ts";

Deno.test("sync: a merge strategy aio does not implement is refused", () => {
  assertThrows(
    () => normalizeSyncConfig({ merge: { count: "countre" } } as never),
    Error,
    "not a merge strategy",
  );
  // …and it lists the real ones, so the typo is one line away from fixed.
  assertThrows(
    () => normalizeSyncConfig({ merge: { count: "countre" } } as never),
    Error,
    "counter",
  );
  // A shape that is not even a string.
  assertThrows(
    () => normalizeSyncConfig({ merge: { count: 3 } } as never),
    Error,
    "not a merge strategy",
  );
});

Deno.test("sync: every real configuration still normalizes", () => {
  // The other direction — a checker that refuses everything would pass the
  // tests above and break every app.
  for (
    const strategy of [
      "lww",
      "counter",
      "text",
      "lww-per-key",
      "set-add",
      "set-remove",
    ]
  ) {
    const cfg = normalizeSyncConfig({ merge: { f: strategy } } as never);
    assertEquals(cfg.merge.f, strategy);
  }
  // identity WITH a strategy that reads it…
  const withId = normalizeSyncConfig(
    { merge: { items: "set-add" }, identity: { items: "uuid" } } as never,
  );
  assertEquals(withId.identity.items, "uuid");
  // …and identity ALONE, which `tests/local-first.test.ts` documents as a
  // supported shape. A first version of this refused it, and the full suite
  // caught that: a refusal has to be right about what the framework accepts.
  const idOnly = normalizeSyncConfig({ identity: { xs: "id" } } as never);
  assertEquals(idOnly.identity.xs, "id");
  // and the bare form.
  assertEquals(normalizeSyncConfig(true).merge, {});
});
