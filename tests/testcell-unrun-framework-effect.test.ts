// A framework effect (`schedule.*`, `own()`) has no clock in `testCell`. The
// root executor refuses it by name — but ONLY when something executes it, and
// a test that asserts on state and never calls `settle()` executes nothing.
// `s.$do(schedule.after(…))` therefore passed GREEN having armed no timer:
// the harness more permissive than production, the direction this project
// forbids. Measured before the fix: the no-settle test below passed.
import { assert, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "aio/testing";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { schedule } from "../src/state/schedule.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

/** Run one throwaway test file in a child `deno test` and report its outcome. */
async function runChildTest(
  body: string,
): Promise<{ ok: boolean; text: string }> {
  const dir = await tempDir("testcell-unrun-effect-");
  try {
    const file = `${dir}/child.test.ts`;
    await Deno.writeTextFile(file, body.replaceAll("__ROOT__", ROOT));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["test", "-A", "--no-check", file],
      env: { ...Deno.env.toObject(), DENO_COVERAGE_DIR: _childCovDir },
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: out.success,
      text: new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr),
    };
  } finally {
    await dropTempDir(dir);
  }
}

const CHILD = (tail: string) =>
  `import { cell } from "__ROOT__src/state/cell.ts";\n` +
  `import { testCell } from "__ROOT__src/testing/cell-test.ts";\n` +
  `import { schedule } from "__ROOT__src/state/schedule.ts";\n` +
  `const c = cell("unrunfx", {\n` +
  `  state: { n: 0 },\n` +
  `  methods: {\n` +
  `    go(s) { s.n++; s.$do(schedule.after("a", 50, { type: "unrunfx.tick" })); },\n` +
  `    tick(s) { s.n += 100; },\n` +
  `  },\n` +
  `});\n` + tail;

Deno.test("a schedule effect nobody ran fails the test even without settle()", async () => {
  const { ok, text } = await runChildTest(
    CHILD(
      `testCell(c, "arms a timer that never was", async (t) => {\n` +
        `  await t.send.go();\n` +
        `  if (t.state.n !== 1) throw new Error("precondition");\n` +
        `});\n`,
    ),
  );
  assert(!ok, `the child test PASSED having armed no timer:\n${text}`);
  assertStringIncludes(text, "reached the root cell executor");
  assertStringIncludes(text, "bootCells");
});

Deno.test("reading the effects is asserting on them — no refusal", async () => {
  const { ok, text } = await runChildTest(
    CHILD(
      `testCell(c, "asserts on the effect it emitted", async (t) => {\n` +
        `  await t.send.go();\n` +
        `  const e = t.getEffects().find((x) => x.type === "__schedule");\n` +
        `  if (!e) throw new Error("no schedule effect emitted");\n` +
        `  if (e.ms !== 50) throw new Error("wrong ms: " + e.ms);\n` +
        `});\n`,
    ),
  );
  assert(ok, `a test that READ its effects was refused anyway:\n${text}`);
});

// The refusal must not fire for an ordinary app effect the test left un-run —
// only a framework effect has a runtime that cannot serve it here.
const plain = cell("unrunapp", {
  state: { n: 0 },
  methods: {
    go(s: { n: number }) {
      s.n++;
    },
  },
});

testCell(plain, "a cell with no framework effect is untouched", async (t) => {
  await t.send.go();
});

const everyCell = cell("unrunevery", {
  state: { n: 0 },
  methods: {
    go(s: { n: number }) {
      s.n++;
      // deno-lint-ignore no-explicit-any
      (s as any).$do(schedule.every("e", 1000, { type: "unrunevery.tick" }));
    },
    tick(s: { n: number }) {
      s.n += 1;
    },
  },
});

testCell(
  everyCell,
  "getEffects() silences the refusal for schedule.every too",
  async (t) => {
    await t.send.go();
    const effects = t.getEffects();
    assert(effects.some((e) => (e as { type?: string }).type === "__schedule"));
  },
);

// Observation is per EFFECT, not per test: a test that read the effects of an
// EARLIER dispatch has not looked at this one. A single boolean flag would
// pass this silently.
Deno.test("an early getEffects() does not silence a later dropped effect", async () => {
  const { ok, text } = await runChildTest(
    `import { cell } from "__ROOT__src/state/cell.ts";\n` +
      `import { testCell } from "__ROOT__src/testing/cell-test.ts";\n` +
      `import { schedule } from "__ROOT__src/state/schedule.ts";\n` +
      `const c = cell("unrunlate", {\n` +
      `  state: { n: 0 },\n` +
      `  methods: {\n` +
      `    quiet(s) { s.n++; },\n` +
      `    go(s) { s.n++; s.$do(schedule.after("a", 50, { type: "unrunlate.tick" })); },\n` +
      `    tick(s) { s.n += 100; },\n` +
      `  },\n` +
      `});\n` +
      `testCell(c, "reads early, schedules late", async (t) => {\n` +
      `  await t.send.quiet();\n` +
      `  t.getEffects();\n` +
      `  await t.send.go();\n` +
      `});\n`,
  );
  assert(!ok, `an early read silenced a LATER dropped effect:\n${text}`);
  assertStringIncludes(text, "reached the root cell executor");
});

// `docs/testing/cell-testing.md` teaches `t.expect.effects([...])` as THE way
// to see a schedule effect without running it. It reads `lastEffects` by a
// different door than `getEffects()`, so a refusal that only knew about one of
// them would fail the pattern the docs recommend.
const documented = cell("unrundoc", {
  state: { n: 0 },
  methods: {
    start(s: { n: number }) {
      s.n++;
      // deno-lint-ignore no-explicit-any
      (s as any).$do(schedule.after("a", 30_000, { type: "unrundoc.tick" }));
    },
    tick(s: { n: number }) {
      s.n += 1;
    },
  },
});

testCell(
  documented,
  "expect.effects sees a schedule effect without running it",
  async (t) => {
    await t.send.start();
    t.expect.effects(["__schedule"]);
  },
);

testCell(
  documented,
  "expect.effectCount counts it without running it",
  async (t) => {
    await t.send.start();
    t.expect.effectCount(1);
  },
);

// `own()` is the other half of the same rule and shares the refusal — and it
// leaks more than a missed timer: `own.set` parks its factory (and the whole
// closure) in a module map that only warns after MAX_PENDING of them pile up.
Deno.test("an own() effect nobody ran fails the test too", async () => {
  const { ok, text } = await runChildTest(
    `import { cell } from "__ROOT__src/state/cell.ts";\n` +
      `import { testCell } from "__ROOT__src/testing/cell-test.ts";\n` +
      `import { own } from "__ROOT__src/state/own.ts";\n` +
      `const c = cell("unrunres", {\n` +
      `  state: { n: 0 },\n` +
      `  methods: {\n` +
      `    open(s) { s.n++; s.$do(own.set("h", () => ({ dispose() {} }))); },\n` +
      `  },\n` +
      `});\n` +
      `testCell(c, "opens a handle nothing holds", async (t) => {\n` +
      `  await t.send.open();\n` +
      `});\n`,
  );
  assert(!ok, `the child test PASSED having leaked the factory:\n${text}`);
  assertStringIncludes(text, "an own() effect");
  assertStringIncludes(text, "no resource table");
});

// `lastEffects` holds only the LAST dispatch, so a method that schedules
// followed by one that does not dropped the effect out of view before the
// end-of-test check could see it — and that is the ordinary multi-dispatch
// test, so it was most of them. MEASURED on a scaffolded counter app whose
// increment() armed a `schedule.after` idle-reset: the starter test
// (`increment(); increment(5); reset();`) passed green with no timer armed.
Deno.test("a schedule effect from an EARLIER dispatch is not forgotten", async () => {
  const { ok, text } = await runChildTest(
    `import { cell } from "__ROOT__src/state/cell.ts";\n` +
      `import { testCell } from "__ROOT__src/testing/cell-test.ts";\n` +
      `import { schedule } from "__ROOT__src/state/schedule.ts";\n` +
      `const c = cell("unrunfirst", {\n` +
      `  state: { n: 0 },\n` +
      `  methods: {\n` +
      `    inc(s) { s.n++; s.$do(schedule.after("idle", 5000, { type: "unrunfirst.reset" })); },\n` +
      `    reset(s) { s.n = 0; },\n` +
      `  },\n` +
      `});\n` +
      `testCell(c, "the scaffold's own starter shape", (t) => {\n` +
      `  t.send.inc();\n` +
      `  t.send.reset();\n` +
      `  t.expect.state((s) => s.n === 0);\n` +
      `});\n`,
  );
  assert(!ok, `an earlier dispatch's dropped effect went unseen:\n${text}`);
  assertStringIncludes(text, "reached the root cell executor");
});

// …and `t.init()` / `t.destroy()` mean start over: an effect emitted before
// the state was reset is not the new run's business.
testCell(documented, "init() clears the ledger with the state", async (t) => {
  await t.send.start();
  t.init();
});

testCell(
  documented,
  "destroy() clears the ledger with the state",
  async (t) => {
    await t.send.start();
    t.destroy();
  },
);

// ── The refusal names WHAT and WHO, and the in-testCell fix ─────────────────
//
// The message said "a schedule effect (schedule.after / every / at / cron)
// reached the root cell executor" — no kind, no id, no method, `cancel` not
// even in the list, and the only fix offered was `bootCells`. The fix that
// keeps the test in `testCell` — READ the effect, which is asserting on it —
// was not mentioned, and cost a field report two red runs (h3 F6).
Deno.test("the refusal names the method, the effect kind + id, and BOTH fixes", async () => {
  const { ok, text } = await runChildTest(
    `import { cell } from "__ROOT__src/state/cell.ts";\n` +
      `import { testCell } from "__ROOT__src/testing/cell-test.ts";\n` +
      `import { schedule } from "__ROOT__src/state/schedule.ts";\n` +
      `import { self } from "__ROOT__src/state/self.ts";\n` +
      `const timer = cell("timer", {\n` +
      `  state: { n: 0 },\n` +
      `  methods: {\n` +
      `    start(s) { s.$do(schedule.every("timer:tick", 1000, self("tick"))); },\n` +
      `    pause(s) { s.$do(schedule.cancel("timer:tick")); },\n` +
      `    tick(s) { s.n++; },\n` +
      `  },\n` +
      `});\n` +
      `testCell(timer, "pause emits a cancel nobody reads", async (t) => {\n` +
      `  t.send.start();\n` +
      `  t.expect.effects(["__schedule"]);\n` +
      `  t.send.pause();\n` +
      `  await t.settle();\n` +
      `});\n`,
  );
  assert(!ok, `the child test PASSED with an unread cancel:\n${text}`);
  assertStringIncludes(
    text,
    `\`timer:pause\` emitted schedule.cancel("timer:tick") that no assertion observed`,
  );
  assertStringIncludes(text, `t.expect.effects(["__schedule"])`);
  assertStringIncludes(text, "t.getEffects()");
  assertStringIncludes(text, "bootCells");
  assertStringIncludes(text, "h.advance(ms)");
});

Deno.test("the refusal's SECOND line is the fix — before the why", async () => {
  const { frameworkEffectInWrongRuntime } = await import(
    "../src/state/cell-compose-execute.ts"
  );
  for (const kind of ["schedule", "own"] as const) {
    const lines = frameworkEffectInWrongRuntime(kind).message.split("\n");
    assertStringIncludes(lines[1]!, "fix: in testCell, READ it");
    assertStringIncludes(lines[2]!, "cause:");
  }
});
