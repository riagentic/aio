// The in-process harness must be the STRICTEST environment, never the most
// permissive — the project's own doctrine, which an audit found inverted.
//
// Every case here is a bug that was REPRODUCED first: an app that boots green
// under `testUI`/`bootCells` and is refused by dev AND prod; a mount that
// throws and leaves its globals behind for the next test to adopt; a harness
// whose teardown left process-global runtime state so a later `settle()`
// silently gave up; two harnesses that disagreed about the same app code; and
// framework effects dropped on the floor.
//
// Each test names the harness, so a regression says which one drifted.
import {
  assert,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells, testCell, testUI } from "../src/testing/cell-test.ts";
import { getRegisteredCells } from "../src/state/cell-reactive.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { _pendingCallPromises } from "../src/state/method-cancel.ts";
import { schedule } from "../src/state/schedule.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { h } from "../src/air/vdom.ts";

/** Build a cell, use it, and take it back OUT of the process-wide registry.
 *
 *  `cell()` self-registers, and `testUI(App)` with no explicit `cells` boots
 *  EVERY registered cell — so a deliberately-illegal fixture left in the
 *  registry would refuse every other file's mounts in the same process. The
 *  fixtures here are illegal on purpose; they must not outlive their test. */
async function withTempCell<T>(
  def: CellDef,
  body: (def: CellDef) => T | Promise<T>,
): Promise<T> {
  try {
    return await body(def);
  } finally {
    (getRegisteredCells() as Map<string, CellDef>).delete(def.__aio.id);
  }
}

const leakyCell = () =>
  cell("hspLeaky", {
    state: { apiKey: "sk-live-EXAMPLE-NOT-REAL", n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  }) as any as CellDef;

// ── 1. Boot refusals: the harness refuses exactly what production refuses ──

Deno.test("credential-bearing cell: production refuses it at compose", async () => {
  await withTempCell(leakyCell(), (def) => {
    // `composeCellsWiring` IS `aio.run()`'s boot path (src/server/aio.ts).
    const e = assertThrows(() => composeCellsWiring({ cellEntries: [def] }));
    assertStringIncludes(
      (e as Error).message,
      "SECURITY — refusing to start",
    );
    assertStringIncludes((e as Error).message, '"apiKey"');
  });
});

Deno.test("credential-bearing cell: bootCells refuses it identically", async () => {
  await withTempCell(leakyCell(), async (def) => {
    const e = await assertRejects(() => bootCells([def]));
    assertStringIncludes(
      (e as Error).message,
      "SECURITY — refusing to start",
    );
    assertStringIncludes((e as Error).message, "[hspLeaky]");
    assertStringIncludes((e as Error).message, '"apiKey"');
  });
});

Deno.test("credential-bearing cell: testUI refuses it identically", async () => {
  await withTempCell(leakyCell(), async (def) => {
    const App = () => h("div", null, "hi");
    const e = await assertRejects(() =>
      // deno-lint-ignore no-explicit-any
      testUI(App as any, { cells: [def] as any })
    );
    assertStringIncludes(
      (e as Error).message,
      "SECURITY — refusing to start",
    );
    assertStringIncludes((e as Error).message, '"apiKey"');
  });
});

Deno.test("a sync cell that hides state is refused by bootCells too", async () => {
  const def = cell("hspSyncFiltered", {
    state: { secretNote: "x", n: 0 },
    sync: true,
    visible: { exclude: ["secretNote"] },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  }) as any as CellDef;
  await withTempCell(def, async (d) => {
    const e = await assertRejects(() => bootCells([d]));
    assertStringIncludes((e as Error).message, "SECURITY — refusing to start");
    assertStringIncludes((e as Error).message, "hspSyncFiltered");
  });
});

// ── 2. A throw during setup must not leak globals into the next test ──

const fineUi = cell("hspFine", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
    },
  },
});

Deno.test("testUI: a throw during mount leaves no globals behind", async () => {
  const Boom = () => {
    throw new Error("hsp: render exploded");
  };
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => testUI(Boom as any, { cells: [] }),
    Error,
    "hsp: render exploded",
  );
  for (const key of ["document", "window", "location", "history"]) {
    assert(
      !(globalThis as Record<string, unknown>)[key],
      `testUI leaked globalThis.${key} after a failed mount — the next mount ` +
        `adopts the dead test's document and nothing can ever clean it`,
    );
  }
});

Deno.test("testUI: the mount after a failed one starts from a clean body", async () => {
  const Boom = () => {
    throw new Error("hsp: render exploded again");
  };
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => testUI(Boom as any, { cells: [] }));
  const App = () => h("div", { class: "button" }, "Hi");
  // deno-lint-ignore no-explicit-any
  await using ui = await testUI(App as any, { cells: [fineUi] as any });
  const body = (globalThis as unknown as {
    document: { body: { children: { length: number } } };
  }).document.body;
  assert(
    body.children.length === 1,
    `body has ${body.children.length} roots — a failed mount's document was ` +
      `adopted by this one`,
  );
  assertStringIncludes(ui.html(), "Hi");
});

// ── 3. Teardown must clear the PROCESS-GLOBAL runtime, or settle() lies ──

const hungCell = cell("hspHung", {
  state: { n: 0 },
  methods: {
    async forever(s: { n: number }) {
      await new Promise(() => {}); // deliberately never settles
      s.n = 1;
    },
  },
});

Deno.test("bootCells: a hung call does not survive dispose()", async () => {
  const h1 = await bootCells([hungCell]);
  hungCell.forever();
  await new Promise((r) => setTimeout(r, 5));
  h1.dispose();
  assert(
    _pendingCallPromises().length === 0,
    `dispose() left ${_pendingCallPromises().length} call(s) in the global ` +
      `pending registry — every later settle() burns its whole budget on ` +
      `them and then returns as if the app had quiesced`,
  );
});

// ── 4. Both harnesses agree about an un-awaited failure, and so does prod ──

const boomCell = (name: string) =>
  cell(name, {
    state: { n: 0 },
    methods: {
      // deno-lint-ignore require-await
      async go(_s: { n: number }) {
        throw new Error("hsp: kaboom");
      },
    },
  });

const boomForTestCell = boomCell("hspBoomA");
const boomForBootCells = boomCell("hspBoomB");
const boomAwaited = boomCell("hspBoomC");

testCell(
  boomForTestCell,
  "testCell surfaces an un-awaited failure",
  async (t) => {
    t.send.go();
    await assertRejects(() => t.settle(), Error, "hsp: kaboom");
  },
);

Deno.test("bootCells surfaces the same un-awaited failure", async () => {
  const h1 = await bootCells([boomForBootCells]);
  try {
    // The ordinary `onClick={() => cell.go()}` shape — nobody awaits it.
    boomForBootCells.go();
    const e = await assertRejects(() => h1.settle());
    assertStringIncludes((e as Error).message, "hsp: kaboom");
    assertStringIncludes((e as Error).message, "nothing awaited it");
  } finally {
    try {
      h1.dispose();
    } catch {
      // aio-ok: the ledger was already raised above; a second raise at dispose
      // is the same failure, and this test has asserted on it.
    }
  }
});

Deno.test("an AWAITED failure is not reported twice", async () => {
  using h1 = await bootCells([boomAwaited]);
  await assertRejects(() => boomAwaited.go(), Error, "hsp: kaboom");
  await h1.settle(); // observed at the call site — must not raise again
});

// ── 5. settle() must never confuse "quiesced" with "gave up" ──

const slowCell = cell("hspSlow", {
  state: { n: 0 },
  methods: {
    async crawl(s: { n: number }) {
      await new Promise((r) => setTimeout(r, 5000));
      s.n = 1;
    },
  },
});

Deno.test("bootCells: settle() that gives up SAYS so, and names the method", async () => {
  // settle() cannot tell "parked by the test, about to be released" from "hung
  // forever" — they are the same state, and the parked shape is the one every
  // incremental-commit test uses. So it returns rather than throwing; what it
  // must never do is stay SILENT, because then "quiesced" and "gave up" are
  // the same answer and the assertions after it only look guarded.
  const said: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  const h1 = await bootCells([slowCell]);
  try {
    slowCell.crawl();
    await h1.settle();
    const line = said.find((m) => m.includes("still in flight")) ?? "";
    assertStringIncludes(line, "hspSlow:crawl");
    assertStringIncludes(line, "await the call itself");
  } finally {
    console.warn = w;
    h1.dispose();
  }
});

// ── 6. Framework effects are never silently dropped ──

const schedCell = cell("hspSched", {
  state: { n: 0 },
  methods: {
    arm(s: { n: number }) {
      (s as unknown as { $do: (e: unknown) => void }).$do(
        schedule.after("hsp", 10, { type: "hspSched:bump" }),
      );
    },
    bump(s: { n: number }) {
      s.n++;
    },
  },
});

testCell(schedCell, "a schedule effect is refused, not dropped", async (t) => {
  t.send.arm();
  const e = await assertRejects(() => t.settle());
  assertStringIncludes((e as Error).message, "no clock");
  assertStringIncludes((e as Error).message, "bootCells");
});

Deno.test("bootCells DOES run the schedule the same cell emits", async () => {
  using h1 = await bootCells([schedCell]);
  await schedCell.arm();
  await h1.advance(20);
  assert(schedCell.n === 1, `schedule did not fire: n=${schedCell.n}`);
});

// ── 7. testUI agrees with bootCells and testCell, on the same two rules ──

const boomUi = boomCell("hspBoomUi");
const slowUi = cell("hspSlowUi", {
  state: { n: 0 },
  methods: {
    async crawl(s: { n: number }) {
      await new Promise((r) => setTimeout(r, 5000));
      s.n = 1;
    },
  },
});

Deno.test("testUI: an un-awaited failing method fails the test", async () => {
  const App = () => h("div", { class: "button" }, "Go");
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App as any, { cells: [boomUi] as any });
  try {
    boomUi.go(); // the onClick shape — nobody awaits it
    const e = await assertRejects(() => ui.settle());
    assertStringIncludes((e as Error).message, "hsp: kaboom");
    assertStringIncludes((e as Error).message, "nothing awaited it");
  } finally {
    await ui.dispose().catch(() => {
      // aio-ok: the ledger was raised and asserted on above; dispose drains it
      // again and this test has already made its claim.
    });
  }
});

Deno.test("testUI: settle() that gives up names what is still running", async () => {
  const App = () => h("div", { class: "button" }, "Go");
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App as any, { cells: [slowUi] as any });
  try {
    slowUi.crawl();
    const e = await assertRejects(() => ui.settle());
    assertStringIncludes((e as Error).message, "gave up");
    assertStringIncludes((e as Error).message, "hspSlowUi:crawl");
    assertStringIncludes((e as Error).message, "NOT quiesced");
  } finally {
    await ui.dispose().catch(() => {
      // aio-ok: teardown of a deliberately-wedged app; the assertion above is
      // the test's claim.
    });
  }
});

// ── 8. The harness must not drag the SERVER into a browser bundle ──
//
// `aio/renderer` (src/browser-air.ts) re-exports `testComponent`, which imports
// `src/testing/test-strict.ts` — so anything statically reachable from the
// harness's shared strictness module rides in EVERY app's browser bundle. The
// first version of the boot-refusal fix put `import { refuseUnsafeComposition }
// from "../server/aio-composition.ts"` there, and every browser build began
// refusing with "server-only module(s) statically imported".
//
// `deno task check:boundaries` cannot catch it: `browser-air.ts` is a ROOT
// file, and root files' folder reach is deliberately unrestricted. The real
// build catches it (tests/e2e-bundle-smoke.test.ts) but only after an esbuild
// run. This is the cheap, immediate version of the same rule.

const BROWSER_ENTRIES = [
  "browser-air.ts", // /__aio/ui.js — and `aio/renderer`
  "standalone-air.ts", // the Android/standalone bundle entry
  "air.ts",
  "jsx-runtime.ts",
  "air/aio-renderer.ts",
];

/** Relative module specifiers in VALUE position — `import type` is erased at
 *  build time and cannot pull a module into a bundle. */
const VALUE_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^"'\n]*?from\s*["'](\.\.?\/[^"']+?\.tsx?)["']|(?:^|\n)\s*import\s*["'](\.\.?\/[^"']+?\.tsx?)["']|import\s*\(\s*["'](\.\.?\/[^"']+?\.tsx?)["']\s*\)/g;

Deno.test("no browser entry statically reaches src/server/", async () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const problems: string[] = [];
  for (const entry of BROWSER_ENTRIES) {
    const importer = new Map<string, string>();
    const queue = [src + entry];
    importer.set(queue[0]!, "(entry)");
    while (queue.length > 0) {
      const file = queue.pop()!;
      let text: string;
      try {
        text = await Deno.readTextFile(file);
      } catch {
        // aio-ok: a specifier that names no file is the type-checker's problem,
        // not this gate's — it only decides what a REAL module drags in.
        continue;
      }
      text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of text.matchAll(VALUE_IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        const target = new URL(spec, `file://${file}`).pathname;
        if (importer.has(target)) continue;
        importer.set(target, file);
        if (target.includes("/src/server/")) {
          const chain = [target];
          let at = target;
          while (importer.get(at) && importer.get(at) !== "(entry)") {
            at = importer.get(at)!;
            chain.push(at);
          }
          problems.push(
            chain.reverse().map((p) => p.split("/src/")[1]).join(" → "),
          );
          continue;
        }
        queue.push(target);
      }
    }
  }
  assert(
    problems.length === 0,
    `a browser entry statically reaches src/server/ — every app's browser ` +
      `bundle will be REFUSED ("server-only module(s) statically imported"):\n` +
      problems.map((p) => `  ${p}`).join("\n") +
      `\n  fix: move the server-touching code into a module only the ` +
      `server-side harnesses import (see src/testing/boot-refusals.ts), or ` +
      `reach it through a dynamic import at the call site.`,
  );
});
