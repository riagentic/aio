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

/** Lines where `closeWindow()` is called but its promise is dropped.
 *
 *  The third shape, and the one that got past this gate: `closeWindow` is
 *  `async`, so a bare `closeWindow(win)` in a synchronous `finally` returns a
 *  promise nobody waits for and happy-dom's settle timer is still armed when
 *  the test ends. It reads exactly like the correct call, the file passes the
 *  "closes something" check above, and the leak only appears when the file
 *  shares a process with others — so it is green in a single-file run and red
 *  in the sharded suite, blamed on whichever test ran next. Measured here:
 *  `tests/air-ssr-attr-name.test.ts` did this and cost a shard.
 *
 *  `await`, `return` and `=>` (the `cleanup: () => closeWindow(win)` shape,
 *  whose caller awaits it) all pass. Nothing else does. */
/** Every name in this file that holds `closeWindow` — the function itself and
 *  anything a local helper hands back under another name.
 *
 *  The alias is why this exists. A file whose `createDOM()` returns
 *  `{ cleanup: () => closeWindow(win) }` calls `cleanup()`, so a check that
 *  only looks for the literal `closeWindow(` sees a clean file. That is not a
 *  hypothetical: `tests/on-unmount.test.ts` shipped one un-awaited `cleanup()`
 *  among four awaited ones, and it passed alone and leaked a timer in a shard
 *  — the same failure shape, and the same hour lost, as the two literal ones
 *  this gate already caught. */
function closerNames(text: string): string[] {
  const names = new Set(["closeWindow"]);
  // `cleanup: () => closeWindow(win)` / `const cleanup = () => closeWindow(w)`
  // / `{ cleanup }` destructured from a helper that returns one.
  for (
    const m of text.matchAll(
      /([$\w]+)\s*[:=]\s*(?:\(\s*\)\s*=>|async\s*\(\s*\)\s*=>)\s*closeWindow\s*\(/g,
    )
  ) names.add(m[1]!);
  for (
    const m of text.matchAll(/([$\w]+)\s*[:=]\s*closeWindow\b(?!\s*\()/g)
  ) names.add(m[1]!);
  return [...names];
}

function unawaitedCloses(text: string): number[] {
  const bad: number[] = [];
  const names = closerNames(text);
  const alt = names.join("|");
  // A CALL of one of those names. `[\w$.]*` lets the call be reached through
  // an object (`await b.cleanup()`), which is how most of these helpers are
  // used, and the lookbehind-free shape keeps it readable.
  const call = new RegExp(`\\b(?:${alt})\\s*\\(`);
  // Awaited, returned, handed to .then, or the body of an arrow — reached
  // through a member chain or not.
  const ok = new RegExp(
    `(?:await|return|=>|\\.then\\()\\s*[\\w$.]*\\b(?:${alt})\\s*\\(`,
  );
  // `cleanup() { … }` is a method DEFINITION, not a call of the closer. Two
  // test files define an unrelated `cleanup()` on an action's return value,
  // and an earlier version of this gate reported all eight of them — a gate
  // that fires on correct code gets muted, which costs more than it saves.
  const methodDef = new RegExp(
    `^(?:async\\s+)?(?:${alt})\\s*\\([^)]*\\)\\s*\\{`,
  );
  text.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*")) return;
    if (!call.test(code)) return;
    if (/\b(?:import|export)\b/.test(code)) return;
    if (methodDef.test(code)) return;
    // The line that DEFINES the alias is not a call of it.
    if (/[$\w]+\s*[:=][^=]*closeWindow\s*\(/.test(code)) return;
    if (ok.test(code)) return;
    bad.push(i + 1);
  });
  return bad;
}

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
      } else {
        const bare = unawaitedCloses(text);
        if (bare.length) {
          out.push({
            file: rel,
            why: `closeWindow() called but not awaited (line ${
              bare.join(", ")
            })`,
          });
        }
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

  // …and the third shape, the one that actually got through: closed, but the
  // promise dropped.
  assertEquals(unawaitedCloses("  closeWindow(win);"), [1]);
  assertEquals(unawaitedCloses("  await closeWindow(win);"), []);
  assertEquals(unawaitedCloses("  return closeWindow(win);"), []);
  assertEquals(unawaitedCloses("  cleanup: () => closeWindow(win),"), []);
  assertEquals(unawaitedCloses("  // closeWindow(win) is the spelling"), []);

  // …and the FOURTH shape, which the literal-only version of this gate could
  // not see at all: the closer reached through an alias a helper returned.
  // `tests/on-unmount.test.ts` had exactly this — four awaited `cleanup()`
  // calls and one bare one, green alone, a leaked timer in a shard.
  const aliased = [
    "const { cleanup } = createDOM();",
    "cleanup: () => closeWindow(win),",
    "  cleanup();",
  ].join("\n");
  assertEquals(unawaitedCloses(aliased), [3], "an aliased closer must count");
  assertEquals(
    unawaitedCloses(aliased.replace("  cleanup();", "  await cleanup();")),
    [],
  );
  // Reached through an object, which is how most of these helpers are used.
  assertEquals(
    unawaitedCloses("cleanup: () => closeWindow(w),\nawait b.cleanup();"),
    [],
  );
  // A METHOD named `cleanup` is not a call of the closer. Two test files
  // define one on an action's return value; reporting those would have made
  // this gate noise.
  assertEquals(
    unawaitedCloses("cleanup: () => closeWindow(w),\ncleanup() {"),
    [],
  );

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
