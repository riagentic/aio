// `visible: { exclude: "secret" }` — the list that is not a list.
//
// `CellFieldFilter` types `include`/`exclude` as arrays, so a bare string
// arrives from JS, from a `cellDefaults` built at runtime, or from JSON
// config. Nothing refused it, and MEASURED it did the worst possible thing:
//
//   • `normalizeUiFilter` keeps only an ARRAY, so the filter was dropped on
//     the floor and the cell resolved to `visible: "all"` — every field the
//     declaration named was broadcast to every client, with no warning
//     anywhere and a startup report that said `visible=all`;
//   • the same spelling under `persist:` writes the whole slice to disk.
//
// A declaration that cannot be applied must never resolve to "apply nothing":
// that is the one outcome the declaration exists to prevent. Refused at both
// layers that can set it — `cell()` and `aio.run({ cellDefaults })` — exactly
// as `include` AND `exclude` together, and a `persist` object that names
// neither, already are.
//
// A list holding a NON-STRING entry (`exclude: [42]`) already stopped the boot
// — with a `key.includes is not a function` from inside the walker. Loud, but
// it names neither the cell nor the fix, so it goes through the same refusal.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { configConflicts } from "../src/server/config.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

// deno-lint-ignore no-explicit-any
type D = any;

Deno.test("cell(): a visible.exclude that is a string, not a list, is refused", () => {
  _resetAioRuntime();
  const e = assertThrows(
    () =>
      cell("vault", {
        state: { unlocked: false, secret: "" },
        visible: { exclude: "secret" },
        methods: {},
      } as D),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "[cell:vault]");
  assertStringIncludes(e.message, "exclude");
  // The consequence, said plainly — this is a leak, not a typo.
  assertStringIncludes(e.message, "client");
  // …and the fix, in the spelling the app must write.
  assertStringIncludes(e.message, `["secret"]`);
});

Deno.test("cell(): the same shape under persist, with the right consequence", () => {
  _resetAioRuntime();
  const e = assertThrows(
    () =>
      cell("store", {
        state: { a: 1 },
        persist: { include: "a" },
        methods: {},
      } as D),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "[cell:store]");
  assertStringIncludes(e.message, "include");
  assertStringIncludes(e.message, "database");
});

Deno.test("cell(): a list holding a non-string is refused by name, not by TypeError", () => {
  _resetAioRuntime();
  const e = assertThrows(
    () =>
      cell("nums", {
        state: { a: 1, b: 2 },
        visible: { exclude: ["a", 42] },
        methods: {},
      } as D),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "[cell:nums]");
  assertStringIncludes(e.message, "42");
});

Deno.test("cell(): a well-formed filter still passes, and still IS the filter", () => {
  // Not "it did not throw": the declaration has to arrive on the cell intact,
  // because the shape this refusal exists for is one that was accepted and
  // then dropped on the floor.
  const ui = (def: unknown) => (def as { __aio: { ui?: unknown } }).__aio.ui;
  _resetAioRuntime();
  assertEquals(
    ui(cell("ok", {
      state: { a: 1, b: { c: 2 } },
      visible: { exclude: ["a", "b.c"] },
      methods: {},
    } as D)),
    { exclude: ["a", "b.c"] },
  );
  _resetAioRuntime();
  assertEquals(
    ui(cell("ok2", {
      state: { a: 1 },
      visible: { include: ["a"] },
      methods: {},
    } as D)),
    { include: ["a"] },
  );
  _resetAioRuntime();
  assertEquals(
    ui(cell("ok3", { state: { a: 1 }, visible: "none", methods: {} } as D)),
    "none",
  );
  _resetAioRuntime();
  // An empty list is a filter that names nothing, which is a real answer
  // ("show nothing") — not a shape error.
  assertEquals(
    ui(cell("ok4", {
      state: { a: 1 },
      visible: { include: [] },
      methods: {},
    } as D)),
    { include: [] },
  );
});

Deno.test("aio.run({ cellDefaults }): the same shape is a config error there too", () => {
  const errs = configConflicts({
    appId: "x",
    cellDefaults: { visible: { exclude: "secret" } },
  } as D).filter((c: { level: string }) => c.level === "error");
  const hit = errs.find((c: { keys: string[] }) =>
    c.keys.some((k) => k.includes("visible"))
  );
  if (!hit) {
    throw new Error(
      `cellDefaults.visible.exclude: "secret" must be a config error — got ${
        JSON.stringify(errs)
      }`,
    );
  }
  assertStringIncludes(JSON.stringify(hit), "client");
});
