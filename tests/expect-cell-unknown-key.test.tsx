// `expectCell`'s predicate could assert nothing, and pass.
//
// Field report (quant, a 24/7 trading desk): "the object the predicate receives
// is the cell DEFINITION, whose reactive getters fall back to their declared
// initial values when nothing has been set. So a null-check like
// `c.view !== null` passes against `undefined` and asserts nothing — a green
// test for a screen that never rendered. It cost me a debugging session for a
// test that was passing for the wrong reason."
//
// Their rule, and the right one: "a test kit's failure mode should never be
// 'silently true'."
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const core = cell("ec-core", {
  state: { page: "desk", count: 0 },
  methods: {
    go(s: { page: string }, p: string) {
      s.page = p;
    },
  },
});

/** A DECLARED optional field — `null` is its real initial value. */
const opt = cell("ec-opt", {
  state: { view: null as string | null },
  methods: {
    set(s: { view: string | null }, v: string) {
      s.view = v;
    },
  },
});

const App = () => (
  <div>
    <span t="page">{core.page}</span>
    <span t="view">{String(opt.view)}</span>
  </div>
);

testUI(
  App,
  "expectCell: a key the cell does not have is REFUSED",
  async (ui) => {
    // The exact shape from the report: `view` is not declared, so the old
    // behaviour read `undefined`, and `undefined !== null` passed.
    const err = await assertRejects(
      () => ui.expectCell(core, (c) => c.view !== null),
      Error,
      "has no 'view'",
    );
    // It must say WHY a passing assertion would have been wrong, not just that
    // the key is missing.
    assert(
      /passes without testing anything/.test(err.message),
      err.message,
    );
    // …and what the cell does have, so the fix is in the message.
    assert(/count, page/.test(err.message), err.message);
  },
);

testUI(
  App,
  "expectCell: declared keys, methods and selectors still read",
  async (ui) => {
    // The guard must not narrow what a real predicate can do.
    await ui.expectCell(core, (c) => c.page === "desk");
    await ui.expectCell(core, (c) => c.count === 0);
    await ui.expectCell(core, (c) => typeof c.go === "function");
    await ui.expectCell(core, (c) => c.__aio.id === "ec-core");
  },
);

testUI(
  App,
  "expectCell: a declared key that is null still compares honestly",
  async (ui) => {
    // The point is not "never undefined" — it is "never a key that isn't
    // there". A DECLARED optional field reads through, so `!== null` means
    // what it says: false while unset…
    await assertRejects(
      () => ui.expectCell(opt, (c) => c.view !== null),
      Error,
      "expectCell failed",
    );
    // …and true once something sets it. This is the assertion the reporter
    // THOUGHT they were writing, and it works.
    await opt.set("desk");
    await ui.expectCell(opt, (c) => c.view !== null);
  },
);
