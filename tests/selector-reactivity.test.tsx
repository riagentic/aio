// the worst footgun in the framework, per a full-app field report:
// `models.items` (property) subscribes; `models.current()` (selector) returns a
// correct, fresh value and subscribes to NOTHING. A component whose only read is
// a selector renders once and then goes silently stale — right data, frozen
// screen, no warning. Two spellings that look identical at the call site, and the
// punishment is delayed.
//
// This file is the executable statement of the fix: a selector read inside a
// render scope subscribes exactly like a property read.
import { assert, assertEquals } from "@std/assert";
import { bindCell, cell } from "../mod.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _applyFullState } from "../src/state/state-signals.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { items: string[]; currentId: string };

const models = cell("models-sel", {
  state: { items: ["a"], currentId: "a" } as S,
  selectors: {
    current: (s: S) => s.items.find((i) => i === s.currentId) ?? "none",
    label: (s: S, prefix: string) => `${prefix}:${s.currentId}`,
  },
  methods: {
    add(s: S, id: string) {
      s.items.push(id);
    },
    pick(s: S, id: string) {
      s.currentId = id;
    },
  },
});

const sel = models as unknown as {
  current(): string;
  label(p: string): string;
};

function App() {
  return (
    <div>
      <div class="via-selector">{sel.current()}</div>
      <div class="via-property">{models.currentId}</div>
      <div class="via-param">{sel.label("m")}</div>
    </div>
  );
}

Deno.test("selector read in a component is reactive, like a property read", async () => {
  await using ui = await testUI(App);
  assert(ui.html().includes(">a</div>"), ui.html());

  models.add("b");
  models.pick("b");
  await ui.settle();

  const pick = (cls: string) =>
    ui.html().match(new RegExp(`class="${cls}"[^>]*>([^<]*)<`))?.[1];
  assertEquals(
    pick("via-property"),
    "b",
    "property read updates (it always did)",
  );
  assertEquals(
    pick("via-selector"),
    "b",
    "SELECTOR read must update too — a stale screen with correct data in the " +
      "store is the failure this test exists to prevent",
  );
  assertEquals(
    pick("via-param"),
    "m:b",
    "a parameterized selector subscribes too",
  );
});

// The path the field report actually hit: standalone / Electron binds a cell
// TWICE — `bindCell` (dispatch + selectors over app.getState()) and then
// `bindCellReactive` (signal-backed getters). The reactive pass skipped any name
// that was already a function, which by then is EVERY selector — so the
// non-tracking version won and a selector-only component froze. testUI binds
// reactively only, which is why a test could never see it.
Deno.test("selector: the standalone/Electron double-bind stays signal-backed", () => {
  const c = cell("models-dbl", {
    state: { n: 1 } as { n: number },
    selectors: { double: (s: { n: number }) => s.n * 2 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });

  // `getState()` is deliberately frozen at the initial value. The catalog
  // binding reads THAT; the reactive binding reads the cell SIGNAL. So after the
  // double bind, whichever value comes back tells us which one is installed —
  // and only the signal-backed one re-renders a component.
  const frozen: Record<string, unknown> = { "models-dbl": { n: 1 } };
  bindCell(c, () => Promise.resolve(undefined), () => frozen);
  bindCellReactive(c);

  _applyFullState({ "models-dbl": { n: 21 } });

  assertEquals(
    (c as unknown as { double(): number }).double(),
    42,
    "the reactive (signal-backed) selector must win over the catalog one — " +
      "otherwise a selector-only component in standalone/Electron renders once " +
      "and freezes, which is exactly what the field report hit",
  );
});
