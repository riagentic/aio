// A happy-dom Window a test constructs is a resource the test owns.
//
// This class has now cost two full suite runs in one session, in two different
// files, and each time it read as an unrelated test failing:
//
//   • `tests/router-link-browser-owned.test.ts` closed its window and still
//     leaked — happy-dom can run an `Immediate` AFTER `close()` resolves and
//     re-arm the async-task manager's settle timer, which then outlives the
//     test (that is what `src/testing/close-window.ts` exists for).
//   • `tests/sync-lazy-load.test.ts` constructed two windows and closed
//     NEITHER — `new Window({…})` with the result discarded. It leaked from
//     the day it was written and only failed when the ordering shifted, and
//     the sanitizer then reported it against the test that ran next.
//
// So the two shapes are counted, and the counts may only fall:
//
//   ABANDONED — constructs a Window and closes nothing. Always a leak.
//   RAW       — closes with `happyDOM.close()` instead of `closeWindow()`.
//               Correct today and one macrotask turn away from the flake
//               above; the debt is real but it is not a certainty.
//
// A file that appears in ABANDONED and is not on the list is RED, with the
// fix: bind the window and `await closeWindow(win)` in a `finally`.
import { assertEquals } from "@std/assert";

/** Files that construct a Window and close nothing. ONLY EVER SHORTER. */
const ABANDONED: readonly string[] = [
  "afterrender-safety.test.ts",
  "async-method-writes.test.ts",
  "auth-ui-flows.test.ts",
  "cell-selectors.test.ts",
  "form-conditional-binding.test.ts",
  "react-island.test.ts",
  "state-immutability.test.ts",
  "test-time-schedules.test.ts",
  "testui-hoisting.test.ts",
  "ui-components-extra.test.ts",
  "ui-markdown.test.ts",
];

/** Files that close, but not through the one teardown. ONLY EVER SMALLER. */
const RAW_CEILING = 80;

async function scan(): Promise<{ abandoned: string[]; raw: number }> {
  const abandoned: string[] = [];
  let raw = 0;
  const dirs = ["tests", "tests/sync"];
  for (const dir of dirs) {
    for await (const e of Deno.readDir(new URL(`../${dir}`, import.meta.url))) {
      if (!e.isFile || !/\.tsx?$/.test(e.name)) continue;
      const text = await Deno.readTextFile(
        new URL(`../${dir}/${e.name}`, import.meta.url),
      );
      if (!/new Window\s*\(/.test(text)) continue;
      const rel = dir === "tests" ? e.name : `sync/${e.name}`;
      if (/\bcloseWindow\s*\(/.test(text)) continue; // the one teardown
      if (/happyDOM\??\.close\s*\(/.test(text)) {
        raw++;
        continue;
      }
      abandoned.push(rel);
    }
  }
  return { abandoned: abandoned.sort(), raw };
}

Deno.test("no test abandons a happy-dom window", async () => {
  const { abandoned } = await scan();
  const added = abandoned.filter((f) => !ABANDONED.includes(f));
  assertEquals(
    added,
    [],
    `these construct a happy-dom Window and never close it — bind it and ` +
      `\`await closeWindow(win)\` in a finally (src/testing/close-window.ts)`,
  );
  const fixed = ABANDONED.filter((f) => !abandoned.includes(f));
  assertEquals(
    fixed,
    [],
    `fixed — delete them from ABANDONED in this file, so the ledger keeps ` +
      `saying what is true`,
  );
});

Deno.test("the raw-close ledger only shrinks", async () => {
  const { raw } = await scan();
  assertEquals(
    raw <= RAW_CEILING,
    true,
    `${raw} files close a window with happyDOM.close() (ceiling ` +
      `${RAW_CEILING}) — use closeWindow(), which also yields the macrotask ` +
      `turn happy-dom needs after close()`,
  );
  assertEquals(
    raw === RAW_CEILING,
    true,
    `${raw} < ${RAW_CEILING}: lower RAW_CEILING to ${raw} to keep the win`,
  );
});
