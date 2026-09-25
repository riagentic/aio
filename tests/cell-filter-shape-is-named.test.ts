// `visible` / `persist` take "all", "none", { include } or { exclude } (visible
// also { forUser } / { publicFields }). The types say so; a JS app, a config
// built at runtime or an `as` cast does not, and three shapes slipped past:
//
//   · `visible: true` / `visible: "some"` threw at cell() — as a bare
//     `TypeError: Cannot use 'in' operator to search for 'include' in true`,
//     naming neither the cell nor the fix;
//   · `persist: true` (docs/basics/api-reference.md tables `persist: true`, for
//     the APP option, right above the per-cell rows) was accepted by cell(),
//     then killed the boot with that same bare TypeError;
//   · `visible: { exlude: ["apiKey"] }` — a typo'd key — was accepted in
//     silence and resolved to `visible: "all"`: the field it meant to hide
//     went to every client, and the boot report said `visible=all`.
//
// The first keeps its refusal, now naming the fix. The other two worked on
// 1.0.11 in the sense of "did not stop" — so they WARN, naming the fix.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { warnFilterShape } from "../src/state/cell-helpers.ts";
// deno-lint-ignore no-explicit-any
const C = cell as any;

Deno.test("visible: a non-filter value is refused naming the cell and the four forms", () => {
  for (const v of [true, "some", 1]) {
    const e = assertThrows(() =>
      C(`fs_${String(v)}`, { state: { n: 0 }, visible: v, methods: {} })
    );
    assert(e instanceof Error);
    assertStringIncludes(e.message, `[cell:fs_${String(v)}] visible is`);
    assertStringIncludes(e.message, "{ exclude: [...] }");
  }
});

Deno.test("a typo'd visible key, or a non-filter persist, is warned — naming the fix", () => {
  const said: string[] = [];
  const warn = (m: string) => void said.push(m);
  warnFilterShape("c1", { exlude: ["apiKey"] }, undefined, warn);
  warnFilterShape("c2", undefined, true, warn);
  // Legal shapes say nothing.
  warnFilterShape("c3", { forUser: (s: unknown) => s, publicFields: [] }, {
    exclude: ["n"],
  }, warn);
  warnFilterShape("c4", "none", "all", warn);
  assertEquals(said.length, 2, said.join("\n"));
  assertStringIncludes(said[0]!, "[cell:c1] visible has `exlude`");
  assertStringIncludes(said[0]!, 'did you mean "exclude"');
  assertStringIncludes(said[0]!, 'visible: "all"');
  assertStringIncludes(said[1]!, "[cell:c2] persist is true");
  assertStringIncludes(said[1]!, 'persist: "all"');
});

Deno.test("a FALSY visible/persist is read as absent — kept (it booted on 1.0.11), and said", () => {
  // `visible: false` reads as "hide it" and sends every field to every client.
  const c = C("fs_false", { state: { n: 0 }, visible: false, methods: {} });
  assert(c, "not refused — it booted on 1.0.11");
  const said: string[] = [];
  warnFilterShape("fs_false", false, false, (m) => void said.push(m));
  assertEquals(said.length, 2, said.join("\n"));
  assertStringIncludes(
    said[0]!,
    "[cell:fs_false] visible is false, which is read as absent",
  );
  // Absent means cellDefaults fills it first — "all" is only the fallback.
  assertStringIncludes(said[0]!, "`cellDefaults.visible` if the app sets one");
  assertStringIncludes(said[1]!, "`cellDefaults.persist` if the app sets one");
  assertStringIncludes(said[0]!, 'visible: "none"');
  assertStringIncludes(said[1]!, "written to the database");
});

Deno.test("the boot refuses `persist: true` on a cell naming the cell and the fix", async () => {
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const c = C("fs_boot", { state: { n: 0 }, persist: true, methods: {} });
  let err: unknown = null;
  try {
    await using _h = await bootCells([c]);
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error, "the boot refuses it");
  assertStringIncludes(
    err.message,
    "[cell:fs_boot] persist is true — not a filter",
  );
  assertStringIncludes(err.message, "is the aio.run() option");
});

Deno.test("an ARRAY visible/persist booted on 1.0.11 — still boots, and is said", () => {
  // `"include" in ["n"]` is false, not a throw — so this is not refused.
  const c = C("fs_arr", {
    state: { n: 0 },
    visible: ["n"],
    persist: ["n"],
    methods: {},
  });
  assert(c);
  const said: string[] = [];
  warnFilterShape("fs_arr", ["n"], ["n"], (m) => void said.push(m));
  assertEquals(said.length, 2, said.join("\n"));
  assertStringIncludes(
    said[0]!,
    '[cell:fs_arr] visible is ["n"] — not a filter',
  );
});
