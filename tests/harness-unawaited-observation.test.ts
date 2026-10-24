// A new developer's mistakes with the test harnesses, and what they are told.
//
// - `ui.expectCell(…)` / `t.expect.rejects(…)` without `await` used to PASS,
//   then fail seconds later as an uncaught error that named no test and
//   cancelled every later test in the file. Now the harness awaits it at
//   teardown and fails THAT test, naming the missing `await`. Proven in a
//   child run (tests/fixtures/unawaited-observations-app.tsx), because the
//   claim is about which test of a FILE fails.
// - a plain read right after a queued `ui.X.click()` says the click had not
//   run yet; a `t.expect.state` that fails while a call runs names the call;
//   `ui.expectCell` on a key the cell does
//   not have fails at once, not after its 2 s retry budget.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { cell } from "../src/state/cell.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";
import { jsx } from "../src/jsx-runtime.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("an un-awaited observation fails its OWN test, and the next test still runs", async () => {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "tests/fixtures/unawaited-observations-app.tsx"],
    env: { ...Deno.env.toObject(), DENO_COVERAGE_DIR: childCoverageDir() },
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr)).replace(/\x1b\[[0-9;]*m/g, "");
  const verdict = (name: string) =>
    text.match(new RegExp(`${name} \\.\\.\\. (ok|FAILED|cancelled)`))?.[1];
  assert(!out.success, text);
  for (
    const [name, want] of [
      ["ui-unawaited-expect", "FAILED"],
      ["ui-next-is-clean", "ok"],
      ["ui-read-before-queue", "FAILED"],
      ["cell-unawaited-rejects", "FAILED"],
      ["cell-next-is-clean", "ok"],
    ]
  ) assert(verdict(name!) === want, `${name}: ${verdict(name!)}\n${text}`);
  assertStringIncludes(text, "`ui.expectCell(…)` was never awaited");
  assertStringIncludes(text, "`t.expect.rejects(…)` was never awaited");
  assertStringIncludes(text, "1 queued action(s) had not run yet");
  assert(!text.includes("uncaught error"), text);
});

// The test ends the call itself, so no timer outlives it.
let release = () => {};
const loader = cell("unawaitedloader", {
  state: { data: "", n: 0 },
  methods: {
    async load(s) {
      await new Promise<void>((r) => release = r);
      s.data = "loaded";
    },
  },
});

// `testCell` registers a Deno.test; these call its body through a stand-in
// so the failure is an assertion here, not a red test.
async function runTestCell(
  name: string,
  // deno-lint-ignore no-explicit-any
  fn: (t: any) => void | Promise<void>,
): Promise<void> {
  const real = Deno.test;
  let body: (() => Promise<void>) | undefined;
  (Deno as { test: unknown }).test = (_n: string, f: () => Promise<void>) => {
    body = f;
  };
  try {
    testCell(loader, name, fn);
  } finally {
    (Deno as { test: unknown }).test = real;
  }
  await body!();
}

Deno.test("t.expect.state failing while a call runs names the call", async () => {
  await assertRejects(
    () =>
      runTestCell("forgot await", (t) => {
        t.send.load();
        t.expect.state((s: { data: string }) => s.data === "loaded");
      }),
    Error,
    "still running: unawaitedloader:load",
  );
  release(); // the abandoned call finishes inside this test
  await new Promise((r) => setTimeout(r, 10));
});

Deno.test("ui.expectCell on a key the cell lacks fails at once", async () => {
  await using ui = await testUI(() => jsx("p", { children: "x" }), {
    cells: [loader],
  });
  const t0 = performance.now();
  await assertRejects(
    () => ui.expectCell(loader, (s) => s.dta === ""),
    Error,
    "has no 'dta'",
  );
  const ms = performance.now() - t0;
  assert(ms < 1000, `took ${ms.toFixed(0)}ms — retried a broken predicate`);
});
