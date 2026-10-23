// Four ways a harness reported a PASS the app does not deserve — or a FAIL it
// does not deserve. Each block failed on main before its fix:
//
//  1. An `async` predicate returns a Promise, which is truthy: `waitFor`,
//     `expectCell`, `t.expect.state` and `t.expect.invariant` passed on the
//     first look without the condition ever being asked.
//  2. `testComponent` (the public component harness beside testCell/testUI)
//     contained a throwing event handler and a throwing RE-render exactly as
//     production does — console line, keep the last output — and never told
//     the test, so it passed on stale content. `testUI` has failed on both
//     since it learned to; this harness now does at `html()` / `unmount()`.
//  3. A re-render throw that an `<ErrorBoundary>` CAUGHT failed `testUI` with
//     "showing STALE content" while the UI showed the author's fallback — and
//     the fallback itself was missing from the surface (the walk read the
//     boundary's unmounted children instead of what is on screen), so a Retry
//     button in it was unaddressable from `testUI` and `am trigger` alike.
//  4. `ui.X.click(); await ui.advance(ms)` moved the clock BEFORE the queued
//     click ran, so the schedule it armed never came due.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "../src/state/cell.ts";
import { schedule } from "../src/state/schedule.ts";
import { signal } from "../src/state/signal.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { testComponent } from "../src/testing/test-component.ts";
import { closeWindow } from "../src/testing/close-window.ts";

const tally = cell("honestTally", {
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n++;
    },
  },
});

function Tally() {
  return <span t="n">{String(tally.n)}</span>;
}

// ── 1. async predicates ──────────────────────────────────────────────

Deno.test("waitFor refuses an async predicate instead of passing", async () => {
  await using ui = await testUI(Tally);
  await assertRejects(
    // deno-lint-ignore require-await
    () => ui.waitFor((async () => tally.n === 99) as unknown as () => boolean),
    Error,
    "returned a Promise",
  );
});

Deno.test("expectCell refuses an async predicate instead of passing", async () => {
  await using ui = await testUI(Tally);
  await assertRejects(
    () =>
      ui.expectCell(
        tally,
        // deno-lint-ignore require-await
        (async (s: { n: number }) => s.n === 99) as unknown as () => boolean,
      ),
    Error,
    "returned a Promise",
  );
});

testCell(tally, "t.expect.state / invariant refuse an async predicate", (t) => {
  // deno-lint-ignore require-await
  const p = (async () => false) as unknown as () => boolean;
  assertThrows(() => t.expect.state(p), Error, "returned a Promise");
  assertThrows(() => t.expect.invariant(p), Error, "returned a Promise");
});

// ── 2. testComponent surfaces contained throws ───────────────────────

Deno.test("testComponent: a throwing onClick fails at html()", async () => {
  const win = new Window();
  const realError = console.error;
  console.error = () => {};
  try {
    const t = testComponent(() => (
      <button
        type="button"
        onClick={() => {
          throw new Error("handler boom");
        }}
      >
        Go
      </button>
    ), { document: win.document });
    t.root.querySelector("button").click();
    assertThrows(() => t.html(), Error, "handler boom");
    t.unmount(); // reported once, not again
  } finally {
    console.error = realError;
  }
  await closeWindow(win);
});

Deno.test("testComponent: a throwing re-render fails at unmount()", async () => {
  const win = new Window();
  const boom = signal(false);
  const C = () => {
    if (boom.value) throw new Error("render boom");
    return <em>ok</em>;
  };
  const realError = console.error;
  console.error = () => {};
  try {
    const t = testComponent(C, { document: win.document });
    boom.set(true);
    await new Promise((r) => setTimeout(r, 10));
    assertThrows(() => t.unmount(), Error, "STALE content: render boom");
  } finally {
    console.error = realError;
  }
  await closeWindow(win);
});

// ── 3. a boundary-caught throw is the fallback, and it is on the surface ──

Deno.test("testUI: a boundary-caught re-render throw shows an addressable fallback", async () => {
  const boom = signal(false);
  const Volatile = () => {
    if (boom.value) throw new Error("boom-local");
    return <em t="ok">ok</em>;
  };
  const App = () => (
    <div>
      {h(ErrorBoundary, {
        fallback: (e: Error) => (
          <button
            type="button"
            onClick={() => boom.set(false)}
          >
            Retry {e.message}
          </button>
        ),
      }, <Volatile />)}
      <button type="button" onClick={() => boom.set(true)}>Break</button>
    </div>
  );
  const realError = console.error;
  console.error = () => {};
  try {
    await using ui = await testUI(App);
    ui.BreakButton.click();
    await ui.settle(); // the fallback is the app's answer — not a failure
    assert(ui.absent("ok"));
    ui.RetryBoomLocalButton.click(); // the fallback's Retry, addressable
    await ui.waitFor(() => ui.present("ok"));
  } finally {
    console.error = realError;
  }
});

Deno.test("testUI: a mount-time throw's fallback is on the surface", async () => {
  const V = () => {
    throw new Error("boom-mount");
  };
  // `<ErrorBoundary>` is a symbol tag, which TSX cannot type — h() it.
  const App = () =>
    h(ErrorBoundary, {
      fallback: (e: Error) => <i t="fb">{e.message}</i>,
    }, <V />);
  const realError = console.error;
  console.error = () => {};
  try {
    await using ui = await testUI(App);
    await ui.settle();
    assertEquals(ui.fb.text, "boom-mount");
  } finally {
    console.error = realError;
  }
});

// ── 4. advance() runs the queued actions before time passes ──────────

const poller = cell("honestPoller", {
  state: { ticks: 0 },
  methods: {
    start(s) {
      s.$do(schedule.every("honest-p", 1000, poller.tick.action()));
    },
    tick(s) {
      s.ticks++;
    },
  },
});

Deno.test("advance: a queued click lands BEFORE the clock moves", async () => {
  const App = () => (
    <button type="button" onClick={() => poller.start()}>Start</button>
  );
  await using ui = await testUI(App);
  ui.StartButton.click(); // queued, not awaited — the documented shape
  await ui.advance(5000);
  assertEquals(poller.ticks, 5);
});
