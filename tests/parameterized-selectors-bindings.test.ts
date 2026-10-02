// A plain selector NAMED like an Object.prototype member (`isPrototypeOf`,
// `valueOf`, `toString`, …) through the two bindings a UI actually reads —
// the signal-backed one (`bindCellReactive`: every browser, testUI) and the
// client view `am surface` renders through. tests/parameterized-selectors
// covers the third, the server catalog.
//
// Each asked "is this the deps form?" with `key in selectorDeps`, which is
// yes for such a name on an EMPTY object — so the selector was called as
// `(own, fullState, …args)` and its first argument arrived as the full state.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";
import { cell } from "../mod.ts";
import { bindCell } from "../src/state/cell-catalog.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _applyFullState } from "../src/state/state-signals.ts";
import { _resetSubs } from "../src/state/state-subs.ts";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Item = { id: string; n: number };
const NAMES = ["isPrototypeOf", "valueOf", "toString", "hasOwnProperty"];

Deno.test("reactive binding: a plain selector named like an Object.prototype member receives its argument", () => {
  const selectors = Object.fromEntries(NAMES.map((name) => [
    name,
    (s: { items: Item[] }, id: string) =>
      s.items.find((x) => x.id === id)?.n ?? -1,
  ]));
  const shelf = cell("shelf_proto_reactive", {
    state: { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }] as Item[] },
    methods: { noop(_s) {} },
    selectors,
  });
  bindCellReactive(shelf);
  try {
    const api = shelf as unknown as Record<string, (id: string) => number>;
    for (const name of NAMES) {
      assertEquals(api[name]!("b"), 2, name);
      assertEquals(api[name]!("z"), -1, name);
    }
    // …and it is the signal that answers, not a snapshot.
    _applyFullState({ shelf_proto_reactive: { items: [{ id: "b", n: 7 }] } });
    assertEquals(api["isPrototypeOf"]!("b"), 7);
  } finally {
    _resetSubs(); // the reactive read armed the subscription sync
  }
});

Deno.test("headless surface: a plain selector named like an Object.prototype member receives its argument", async () => {
  const repo = new URL("..", import.meta.url).pathname;
  const dir = await tempDir("selector-proto-name-");
  try {
    await Deno.writeTextFile(
      `${dir}/shelf.ts`,
      `import { cell } from "${repo}mod.ts";
type Item = { id: string; n: number };
const pick = (s: { items: Item[] }, id: string) =>
  s.items.find((x) => x.id === id)?.n ?? -1;
export const shelf = cell("shelf_proto_surface", {
  state: { items: [] as Item[] },
  selectors: { ${NAMES.map((n) => `${n}: pick`).join(", ")} },
  methods: { noop(_s) {} },
});
`,
    );
    await Deno.writeTextFile(
      `${dir}/App.ts`,
      `import { h } from "${repo}src/air/vdom.ts";
import { shelf } from "./shelf.ts";
const api = shelf as unknown as Record<string, (id: string) => number>;
export default function App() {
  return h("main", null, ${
        NAMES.map((n) => `h("p", null, "${n}=" + api.${n}("b"))`).join(", ")
      });
}
`,
    );
    const mod = await import(toFileUrl(`${dir}/shelf.ts`).href);
    const live = { shelf_proto_surface: { items: [{ id: "b", n: 2 }] } };
    // deno-lint-ignore no-explicit-any
    bindCell(mod.shelf as any, () => Promise.resolve(), () => live);
    const r = await renderHeadlessSurface(`${dir}/App.ts`);
    assert(r.ok, !r.ok ? r.error : "");
    const out = JSON.stringify(r.roots);
    for (const name of NAMES) assertStringIncludes(out, `${name}=2`);
  } finally {
    // The headless render reads EVERY registered cell as a client would —
    // the reactive one above too, and that read arms the subscription sync
    // (a 16 ms timer that only usually fires before this test ends).
    _resetSubs();
    await dropTempDir(dir);
  }
});
