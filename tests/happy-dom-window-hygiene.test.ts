// A happy-dom Window a test constructs is a resource the test owns.
//
// This class has now cost THREE full suite runs in one session, in three
// different files, and every time it read as an unrelated test failing:
//
//   • `tests/router-link-browser-owned.test.ts` closed its window and still
//     leaked — happy-dom can run an `Immediate` AFTER `close()` resolves and
//     re-arm the async-task manager's settle timer, which then outlives the
//     test (that is what `src/testing/close-window.ts` exists for).
//   • `tests/sync-lazy-load.test.ts` constructed two windows and closed
//     NEITHER — `new Window({…})` with the result discarded. It leaked from
//     the day it was written and only failed when the ordering shifted, and
//     the sanitizer then reported it against the test that ran next.
//   • `tests/child-alignment-invariant.test.ts` closed with a raw
//     `happyDOM.close()` and leaked into `child-desync-diagnosis.test.ts`,
//     which asserts nothing about timers at all and took the whole blame.
//
// That third one is why this file no longer keeps ledgers. The previous
// version carried a RAW_CEILING of 80 and called that shape "correct today and
// one macrotask turn away from the flake" — a prediction, written down, that
// then came true and turned a core run red. A ceiling that permits the known
// failure mode is not a gate; it is a note. So the rule is now absolute and
// there is nothing to keep in sync:
//
//   Every file that constructs a happy-dom Window closes it with
//   `closeWindow()`. No exceptions, no allowlist, no count.
//
// Both halves matter. `closeWindow` is the only spelling that also yields the
// macrotask turn happy-dom needs after `close()` — a raw `happyDOM.close()` is
// the leak above, and never closing at all is the one before it.
import { assertEquals } from "@std/assert";

const DIRS = ["tests", "tests/sync"] as const;
const SELF = "happy-dom-window-hygiene.test.ts";

type Offence = { file: string; why: string };

async function scan(): Promise<Offence[]> {
  const out: Offence[] = [];
  for (const dir of DIRS) {
    for await (const e of Deno.readDir(new URL(`../${dir}`, import.meta.url))) {
      if (!e.isFile || !/\.tsx?$/.test(e.name) || e.name === SELF) continue;
      const text = await Deno.readTextFile(
        new URL(`../${dir}/${e.name}`, import.meta.url),
      );
      if (!/new Window\s*\(/.test(text)) continue;
      const rel = dir === "tests" ? e.name : `sync/${e.name}`;
      if (/happyDOM\??\.close\s*\(/.test(text)) {
        out.push({ file: rel, why: "raw happyDOM.close()" });
      } else if (!/\bcloseWindow\s*\(/.test(text)) {
        out.push({ file: rel, why: "constructs a Window and closes nothing" });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

Deno.test("every happy-dom window a test builds is closed through closeWindow()", async () => {
  const offences = await scan();
  assertEquals(
    offences,
    [],
    `bind the window and \`await closeWindow(win)\` in a finally ` +
      `(src/testing/close-window.ts) — a raw close leaks the settle timer ` +
      `happy-dom re-arms after close(), and the sanitizer blames whichever ` +
      `test runs next:\n` +
      offences.map((o) => `  ${o.file} — ${o.why}`).join("\n"),
  );
});

Deno.test("the gate can actually see both offences", async () => {
  // A gate over a directory scan passes vacuously the day the scan stops
  // finding files. Both shapes are re-derived here from the same predicates
  // the scan uses, so a scan that matches nothing cannot read as compliance.
  const raw = `new Window({}); await win.happyDOM.close();`;
  const abandoned = `const x = new Window({});`;
  const clean = `const w = new Window({}); await closeWindow(w);`;
  const verdict = (t: string) =>
    !/new Window\s*\(/.test(t)
      ? "n/a"
      : /happyDOM\??\.close\s*\(/.test(t)
      ? "raw"
      : /\bcloseWindow\s*\(/.test(t)
      ? "ok"
      : "abandoned";
  assertEquals(verdict(raw), "raw");
  assertEquals(verdict(abandoned), "abandoned");
  assertEquals(verdict(clean), "ok");
  assertEquals(verdict("const d = document;"), "n/a");

  // …and the scan is looking at a real, non-empty population.
  let windows = 0;
  for await (const e of Deno.readDir(new URL("../tests", import.meta.url))) {
    if (!e.isFile || !/\.tsx?$/.test(e.name)) continue;
    const t = await Deno.readTextFile(
      new URL(`../tests/${e.name}`, import.meta.url),
    );
    if (/new Window\s*\(/.test(t)) windows++;
  }
  assertEquals(
    windows > 50,
    true,
    `only ${windows} files construct a Window — the scan has stopped seeing ` +
      `the population it gates, so its silence means nothing`,
  );
});
