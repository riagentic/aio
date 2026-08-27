// The second half of the hands-on DX walk: the test harness, the linter, and
// the lines an app prints about itself. Every case was REPRODUCED first — the
// comment on each test is what the walk actually saw.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell.ts";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { testCell } from "../src/testing/cell-test.ts";
import {
  assertionFailure,
  callerLocation,
  formatCellState,
} from "../src/testing/test-format.ts";
import {
  frozenWriteMessage,
  isFrozenWriteError,
} from "../src/state/immutable.ts";
import { buildContext } from "../aiol/context.ts";
import {
  checkEmptyStateCollection,
  checkSelfMethodCall,
} from "../aiol/checks.ts";
import { bootLines } from "../src/server/boot-facts.ts";
import { uiKeyVisibility } from "../src/state/state-filter.ts";

// deno-lint-ignore no-explicit-any
type AiolCheck = (ctx: any) => unknown;

async function lint(files: Record<string, string>, check: AiolCheck) {
  const dir = await Deno.makeTempDir({ prefix: "aio-dx-lint-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await check(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
// ── #6 ui.expectCell failures printed no state ──────────────────────────────
//
// REPRODUCED: `testUI: expectCell failed for cell 'notes'.` and nothing else,
// while `t.expect.state` on the same fact printed the full state JSON. Two
// assertion APIs, one of them useless on failure — and the useless one is the
// one the docs tell people to use.

Deno.test("formatCellState: THE dump both assertion APIs print", () => {
  assertEquals(
    formatCellState({ items: ["a"], n: 1 }),
    '{"items":["a"],"n":1}',
  );
  assertEquals(formatCellState(undefined), "(unavailable)");
  // A cell whose state cycles must not turn an assertion failure into a
  // formatting failure.
  const cyclic: Record<string, unknown> = { n: 1 };
  cyclic.self = cyclic;
  assertStringIncludes(formatCellState(cyclic), "[Circular]");
  // …and a big list must not bury the assertion.
  const big = formatCellState({
    xs: Array.from({ length: 5000 }, (_, i) => i),
  });
  assert(big.length < 2200, `capped, got ${big.length}`);
  assertStringIncludes(big, "truncated");
});

const dxUi = cell("dx-ui", {
  state: { items: [] as string[] },
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
  },
});

function DxApp() {
  return h("div", null, String(dxUi.items.length));
}

testUI(
  DxApp as never,
  "ui.expectCell failure dumps the cell state",
  async (ui) => {
    await dxUi.add("one");
    let msg = "";
    try {
      await ui.expectCell(
        dxUi,
        (c: { items: string[] }) => c.items.length === 5,
      );
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Before: `testUI: expectCell failed for cell 'notes'.` and nothing else.
    assertStringIncludes(msg, "expectCell failed for cell 'dx-ui'");
    assertStringIncludes(msg, '{"items":["one"]}');
  },
);

// ── #7 a failing testCell reported the FRAMEWORK file ───────────────────────
//
// REPRODUCED: `[notes] my test => ./src/testing/cell-test.ts:211` — an IDE's
// jump-to-failure lands inside aio. `Deno.TestDefinition` has no `location`
// field to redirect that header (measured against Deno 2.9), so the caller
// goes in the MESSAGE and the harness frames come off the stack.

Deno.test("assertionFailure: names the caller and drops harness frames", () => {
  const err = assertionFailure("state assertion failed: {}");
  assertStringIncludes(
    err.message,
    "tests/dev-loop-dx-harness.test.ts:",
    `the caller, not the framework: ${err.message}`,
  );
  assertStringIncludes(err.message, "state assertion failed");
  const frames = (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
  assert(frames.length > 0, "still has a stack");
  assert(
    !frames[0]!.includes("/src/testing/"),
    `top frame is the user's, got: ${frames[0]}`,
  );
});

Deno.test("callerLocation: skips the harness and reports project-relative", () => {
  const at = callerLocation(["/src/testing/"]);
  assert(at, "found a caller");
  assert(
    at.startsWith("tests/dev-loop-dx-harness.test.ts:"),
    `project-relative, got ${at}`,
  );
});

// ── #8 `t.state` did not exist ──────────────────────────────────────────────
//
// REPRODUCED: `t.state` produced a six-line `Omit<TestContext<…>>` type error
// naming nothing available; the right call (`t.getState()`) had to be found by
// reading framework source.

const dxCounter = cell("dx-counter", {
  state: { n: 0, items: [] as string[] },
  methods: {
    bump(s) {
      s.n += 1;
    },
    add(s, t: string) {
      s.items.push(t);
    },
  },
});

testCell(dxCounter, "t.state is a live alias for t.getState()", (t) => {
  assertEquals(t.state.n, 0);
  t.send.bump();
  assertEquals(t.state.n, 1, "a getter, not a boot-time snapshot");
  assertEquals(t.state, t.getState());
});

testCell(dxCounter, "a failed expect names the caller AND the state", (t) => {
  t.send.add("only-one");
  let msg = "";
  try {
    t.expect.state((s) => (s.items as string[]).length === 2);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(msg, "dev-loop-dx-harness.test.ts:");
  assertStringIncludes(msg, '{"n":0,"items":["only-one"]}');
});

// ── #9 a frozen-state mutation threw a raw V8 message ───────────────────────
//
// REPRODUCED: `TypeError: Cannot add property 1, object is not extensible` —
// naming neither the cell, nor the rule, nor the fix.

Deno.test("isFrozenWriteError: every engine spelling of the same mistake", () => {
  for (
    const raw of [
      "Cannot add property 1, object is not extensible",
      "Cannot assign to read only property 'n' of object",
      "Cannot delete property '0' of [object Array]",
    ]
  ) assert(isFrozenWriteError(raw), raw);
  assert(!isFrozenWriteError("undefined is not a function"));
});

Deno.test("frozenWriteMessage: names the cell and the fix", () => {
  const m = frozenWriteMessage(
    "Cannot add property 1, object is not extensible",
    "notes",
  );
  assertStringIncludes(m, "Cannot add property 1"); // keeps the engine's fact
  assertStringIncludes(m, "cell 'notes'");
  assertStringIncludes(m, "inside a METHOD");
  assertStringIncludes(m, "notes.add(…)");
});

const dxFrozen = cell("dx-frozen", {
  state: { items: [] as string[] },
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
  },
});

testCell(
  dxFrozen,
  "testCell rewrites a frozen write into an explanation",
  (t) => {
    t.send.add("a");
    let msg = "";
    try {
      (t.state.items as string[]).push("boom");
    } catch (e) {
      // The harness rewrites this on the way OUT of the test body, so re-run the
      // rewrite here to assert on the same transformation.
      const raw = e instanceof Error ? e.message : String(e);
      assert(isFrozenWriteError(raw), raw);
      msg = frozenWriteMessage(raw, "dx-frozen");
    }
    assertStringIncludes(msg, "cell 'dx-frozen'");
    assertStringIncludes(msg, "not a snapshot");
  },
);

// ── #10 a nested same-cell call silently did half the work ──────────────────
//
// REPRODUCED: `addTwice() { notes.add(); notes.add() }` returns `{"ok":true}`
// and adds ONE item (zero, in the test harness), with no diagnostics at all.
// The existing rule only fired when the caller had already written to its own
// draft — and the method that queues two calls usually takes no draft at all.

Deno.test("aiol: TWO self-calls in one method are flagged, naming the queue", async () => {
  const found = await lint({
    "src/notes.ts": `import { cell } from "aio";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  methods: {
    add(s: { items: string[] }, t = "x") { s.items.push(t); },
    addTwice() { notes.add("a"); notes.add("b"); },
  },
});
`,
  }, checkSelfMethodCall);
  assertEquals(found.length, 2, "both calls in the pair are named");
  for (const f of found) {
    assertStringIncludes(f.message, "queued");
    assertStringIncludes(f.message, "COMMITTED state");
    assertStringIncludes(f.message, "a fraction of what it reads like");
  }
});

Deno.test("aiol: ONE self-call with no draft write is still not flagged", async () => {
  // The supersession case (`examples/disk`) must stay clean — extending the
  // rule must not make it noise.
  const found = await lint({
    "src/disk.ts": `import { cell } from "aio";
export const disk = cell("disk", {
  state: { path: "/" },
  methods: {
    async open(s: { path: string }, p: string) { s.path = p; },
    async up(s: { path: string }) {
      const parent = s.path.replace(/\\/[^/]+$/, "") || "/";
      if (parent !== s.path) await disk.open(parent);
    },
  },
});
`,
  }, checkSelfMethodCall);
  assertEquals(found, []);
});

// ── #5 the first-cell mistake produced errors that named nothing ────────────
//
// REPRODUCED on a fresh project: `state: { items: [] }` → two to five
// `Property 'x' does not exist on type 'never'` errors, every one of them
// pointing at a METHOD and none at the declaration that caused them.

Deno.test("aiol: an unannotated empty array in cell state is flagged", async () => {
  const found = await lint({
    "src/notes.ts": `import { cell } from "aio";
export const notes = cell("notes", {
  state: { items: [], count: 0 },
  methods: {
    add(s: { items: unknown[]; count: number }) { s.count++; },
  },
});
`,
  }, checkEmptyStateCollection);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.line, 3);
  assertStringIncludes(found[0]!.message, "never[]");
  assertStringIncludes(found[0]!.message, "items: [] as Item[]");
  assertStringIncludes(found[0]!.message, "point at the");
});

Deno.test("aiol: an ANNOTATED empty array is exactly the fix, so it is silent", async () => {
  const found = await lint({
    "src/notes2.ts": `import { cell } from "aio";
type Note = { id: number };
export const notes2 = cell("notes2", {
  state: { items: [] as Note[], seen: new Set() as Set<string> },
  methods: { add(s: { items: Note[] }) { s.items.push({ id: 1 }); } },
});
`,
  }, checkEmptyStateCollection);
  assertEquals(found, []);
});

Deno.test("aiol: a nested empty array is not flagged (conservative on purpose)", async () => {
  const found = await lint({
    "src/notes3.ts": `import { cell } from "aio";
export const notes3 = cell("notes3", {
  state: { filters: { tags: [] } },
  methods: { noop(s: { filters: { tags: unknown[] } }) { s.filters.tags; } },
});
`,
  }, checkEmptyStateCollection);
  assertEquals(found, []);
});

// ── #11 the cheap ones ──────────────────────────────────────────────────────

Deno.test("visibility errors name `visible:`, the key that exists", () => {
  // REPRODUCED: the best message in the framework told people to look for
  // `ui.exclude` — renamed to `visible:` in alpha52, so grepping their own
  // code for it finds nothing.
  const hidden = uiKeyVisibility({ exclude: ["apiKey"] }, "apiKey");
  assertEquals(hidden.hidden, true);
  assertStringIncludes(hidden.reason!, "visible.exclude");
  assert(!/\bui\.exclude\b/.test(hidden.reason!));
  const notIncluded = uiKeyVisibility({ include: ["a"] }, "apiKey");
  assertStringIncludes(notIncluded.reason!, "visible.include");
  assertStringIncludes(uiKeyVisibility("none", "a").reason!, 'visible: "none"');
});

Deno.test("boot report: a compiled binary does not present a build path as a file", () => {
  // REPRODUCED: `entry  /tmp/deno-compile-hello/j2/hello/src/app.ts (default)`
  // — a path that exists on the BUILD machine's layout inside the binary's
  // embedded filesystem, and nowhere on the machine reading the report.
  const compiled = bootLines(
    {
      build: "compiled",
      target: "binary",
      artifact: "/opt/hello",
      platform: "linux/x86_64",
      runtime: "deno 2.9.1",
    },
    {
      entry: { value: "/tmp/deno-compile-hello/x/src/app.ts", from: "default" },
    },
  );
  const entryLine = compiled.find(([k]) => k === "entry")!;
  assertStringIncludes(entryLine[1], "embedded in the binary");
  assert(!entryLine[1].includes("(default)"));

  const fromSource = bootLines(
    {
      build: "source",
      target: "source",
      artifact: "/usr/bin/deno",
      platform: "linux/x86_64",
      runtime: "deno 2.9.1",
    },
    { entry: { value: "/home/me/app/src/app.ts", from: "default" } },
  );
  assertEquals(
    fromSource.find(([k]) => k === "entry")![1],
    "/home/me/app/src/app.ts (default)",
    "running from source, the path IS a file here — unchanged",
  );
});
