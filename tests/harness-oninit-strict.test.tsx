// The harnesses and `onInit`.
//
// An `onInit` that throws is reported by the runtime as INIT_ERROR, and the
// boot carries on — right for a running app, wrong for a test: under
// `bootCells` and `testUI` the throw was a log line beside a PASSING test
// (testUI printed it only as post-test output), while the docs said it
// "throws, as aio.run does". Now the harness fails the test with it at the
// next `settle()` / `dispose()`, the way it fails an unobserved failing call.
//
// `testCell` never boots the cell, so `onInit` never ran there — silently, an
// `onInit` that throws passed green. What it runs is unchanged; it now SAYS,
// once per cell, that onInit does not run and where to go instead.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { n: number };
// deno-lint-ignore no-explicit-any
type Any = any;

/** A cell whose onInit calls one of its methods directly — refused during
 *  boot (methods are bound after every `__init`), so the onInit throws. */
const mk = (id: string) => {
  const c: Any = cell(id, {
    state: { n: 0 },
    methods: {
      warm(s: S) {
        s.n += 1;
      },
    },
    onInit() {
      c.warm();
    },
  });
  return c;
};

/** Silence the runtime's own INIT_ERROR line for `fn` — this file asserts on
 *  what the harness does with it. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
  }
}

Deno.test("bootCells: an onInit that throws fails the test at settle(), naming the cell and the way out", async () => {
  const c = mk("init_boot_settle");
  const h = await quiet(() => bootCells([c]));
  try {
    const e = await assertRejects(() => h.settle(), Error);
    assert(e.message.includes("init_boot_settle onInit threw"), e.message);
    assert(e.message.includes("still booting"), "the cause is carried");
    assert(e.message.includes("app.dispatch("), "names the way out");
    // The refusal itself (cell-catalog.ts) names the dispatch door first,
    // with this cell's own action type.
    const cause = (e.cause as Error | undefined)?.message ?? "";
    assert(
      cause.includes(
        'app.dispatch({ type: "init_boot_settle:warm", payload: { args: [] } })',
      ),
      cause,
    );
  } finally {
    h.dispose();
  }
});

Deno.test("bootCells: an onInit that throws fails the test at dispose() when nothing settled", async () => {
  const c = mk("init_boot_dispose");
  const h = await quiet(() => bootCells([c]));
  assertThrows(() => h.dispose(), Error, "init_boot_dispose onInit threw");
});

Deno.test("testUI: an onInit that throws fails the test — at the mount's own settle", async () => {
  const c = mk("init_ui_settle");
  const App = () => <div>{String(c.n)}</div>;
  // testUI settles the first render before handing the handle back, so the
  // failure surfaces from the mount itself.
  await quiet(() =>
    assertRejects(
      () => testUI(App as never, { cells: [c] }),
      Error,
      "init_ui_settle onInit threw",
    )
  );
});

Deno.test("bootCells: an onInit that does NOT throw is not reported", async () => {
  const c: Any = cell("init_boot_fine", {
    state: { n: 0 },
    methods: {
      warm(s: S) {
        s.n += 1;
      },
    },
    onInit(app) {
      app.dispatch({ type: "init_boot_fine:warm", payload: { args: [] } });
    },
  });
  await using h = await bootCells([c]);
  await h.settle();
  assertEquals(c.n, 1, "the dispatched warm-up ran");
});

// testCell: said once per cell, never a failure. `testCell` registers its own
// `Deno.test`, so the registrations are captured here and run inside this one
// test — self-contained, so it runs (and fails) alone under `--filter`.
Deno.test("testCell: a cell with onInit is told, once, that onInit does not run there", async () => {
  const tc = mk("init_testcell");
  const registered: (() => unknown)[] = [];
  const realTest = Deno.test;
  (Deno as Any).test = (_name: string, fn: () => unknown) =>
    void registered.push(fn);
  try {
    testCell(tc, "runs methods without onInit (1)", (t: Any) => {
      t.send.warm();
      t.expect.state((s: S) => s.n === 1);
    });
    testCell(tc, "runs methods without onInit (2)", (t: Any) => {
      t.expect.state((s: S) => s.n === 0);
    });
  } finally {
    (Deno as Any).test = realTest;
  }
  assertEquals(registered.length, 2);
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    for (const fn of registered) await fn(); // both pass: a notice, not a failure
  } finally {
    console.warn = realWarn;
  }
  const said = warned.filter((w) => w.includes('"init_testcell"'));
  assertEquals(said.length, 1, `said once: ${JSON.stringify(warned)}`);
  assert(said[0]!.includes("onInit does not run under testCell"), said[0]);
  assert(said[0]!.includes("bootCells"), "names where it does run");
});

Deno.test("INIT_ERROR tip names app.dispatch and onStart, not a generic guess", () => {
  const tip = generateTip(
    createAioError("INIT_ERROR", new Error("x"), { cellName: "projects" }),
  ) ?? "";
  assert(tip.includes("app.dispatch("), tip);
  assert(tip.includes("onStart"), tip);
  assert(!tip.includes("missing dependencies"), tip);
});
