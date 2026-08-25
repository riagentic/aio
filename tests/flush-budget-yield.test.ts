// Regression (AIO-408): when a flush exceeds its time budget MID-BATCH, the
// unprocessed components must survive. The scheduler snapshots
// `pendingComponents` and clears the live set; before the fix, yielding mid-batch
// simply `return`ed, stranding every not-yet-rendered instance — its
// `pendingRender` stayed true, so it was neither in the queue nor re-addable
// (_scheduleComponentRender early-returns on pendingRender), permanently
// freezing it AND silently dropping all its future signal updates.
//
// The strand only fires when the yield fires, and the yield needs the pending
// queue to be non-empty — i.e. a component scheduled MID-BATCH while earlier
// siblings are still unprocessed. That is the airdrop shape: a re-render mirrors
// a value into a derived cell that another component reads, scheduling it. Fast
// test flushes never overran the budget, which is why this hid in production
// only. `_setFlushBudget(0)` forces a yield after every component so the
// mid-batch path is exercised deterministically.

import { assert, assertEquals } from "jsr:@std/assert";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _setFlushBudget } from "../src/air/renderer-flush.ts";
import { Window } from "happy-dom";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("mid-batch scheduling under budget overrun strands no component", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  _setFlushBudget(0); // force a yield after every component render
  try {
    const N = 8;
    const cells = Array.from({ length: N }, (_, i) => signal(i));
    const mirror = signal(-1); // derived cell an extra component reads

    // Row 0 mirrors its cell into `mirror` during render — the FIRST component in
    // the batch schedules `Mirror` mid-batch, so the buggy yield fires while
    // rows 1..N-1 are still unprocessed. Guarded by an equality check → no cycle.
    const Row = (p: { i: number }) => {
      const v = cells[p.i]!.value;
      if (p.i === 0 && mirror.peek() !== v) mirror.set(v);
      return h("div", { id: "r" + p.i }, `v=${v}`);
    };
    const Mirror = () => h("div", { id: "mirror" }, `m=${mirror.value}`);

    const App = () =>
      h(
        "div",
        null,
        h("div", { key: "mir" }, h(Mirror as never, null)),
        cells.map((_, i) => h("div", { key: i }, h(Row as never, { i }))),
      );

    const handle = mount(root, App);
    for (let i = 0; i < N; i++) {
      assertEquals(
        root.querySelector("#r" + i)?.textContent,
        `v=${i}`,
        `init ${i}`,
      );
    }

    // The burst: every row cell changes at once → all Rows scheduled; Row 0's
    // re-render then schedules Mirror mid-batch.
    for (let i = 0; i < N; i++) cells[i]!.set(100 + i);
    for (let t = 0; t < N + 6; t++) await tick();

    for (let i = 0; i < N; i++) {
      assertEquals(
        root.querySelector("#r" + i)?.textContent,
        `v=${100 + i}`,
        `row ${i} must update after a mid-batch budget overrun`,
      );
    }
    assertEquals(
      root.querySelector("#mirror")?.textContent,
      `m=${100}`,
      "mirror",
    );

    // And every row must still be reactive afterwards (not left pendingRender).
    for (let i = 0; i < N; i++) cells[i]!.set(200 + i);
    for (let t = 0; t < N + 6; t++) await tick();
    for (let i = 0; i < N; i++) {
      assertEquals(
        root.querySelector("#r" + i)?.textContent,
        `v=${200 + i}`,
        `row ${i} must still be reactive after an earlier overrun`,
      );
    }
    assert(true);

    _unmount(handle);
  } finally {
    _setFlushBudget(); // restore production default
    await cleanup();
  }
});

// ── The other question about the same counter (audit M3) ──────────────────────
//
// The cycle detector counts renders PER COMPONENT PER FLUSH, and that count
// deliberately persists across yield boundaries (AIO-209) while the limit (25)
// is compared against the cumulative total. An audit asked whether a component
// that legitimately re-renders many times across several mid-flush yields could
// accumulate past 25 and be force-killed as a "cycle" — frozen for the rest of
// the flush, which would be a silent wrong outcome under exactly the heavy
// bursts the yield path exists for.
//
// Measured before changing a safety limit, which is the whole reason it was not
// changed on the description alone: instrumenting the counter and running the
// entire UI corpus (every tests/*.tsx, plus the conformance and differential
// renderer suites) produced 285 samples and a maximum of **1**. Nothing in the
// project renders a component twice in one flush, let alone twelve times.
//
// This pins the shape the audit described — many components, repeated writes,
// a yield after EVERY component (budget 0, the maximum possible number of yield
// boundaries) — and asserts the breaker never fires. If a future change starts
// producing multi-render flushes, this is where it shows up.
Deno.test("cycle detector: a heavy burst across many yields is not a cycle", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  _setFlushBudget(0); // yield after every single component render
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    const N = 12;
    const cells = Array.from({ length: N }, (_, i) => signal(i));
    const Row = (p: { i: number }) =>
      h("div", { id: "r" + p.i }, `v=${cells[p.i]!.value}`);
    const App = () =>
      h(
        "div",
        null,
        cells.map((_, i) => h("div", { key: i }, h(Row as never, { i }))),
      );
    const handle = mount(root, App);
    // 30 write rounds — more than the limit, so a counter that accumulated
    // across flushes (rather than resetting per flush) would trip too.
    for (let round = 0; round < 30; round++) {
      for (const c of cells) c.set(c.peek() + 1);
      handle._flush();
      await tick();
    }
    await tick();
    assertEquals(
      errors.filter((e) => e.includes("re-rendered")),
      [],
      "a legitimate burst must never be force-killed as a cycle",
    );
    assert(
      (root.innerHTML as string).includes("v=41"),
      `every row kept rendering to the end: ${root.innerHTML}`,
    );
    _unmount(handle);
  } finally {
    console.error = realError;
    _setFlushBudget();
    cleanup();
  }
});

// …and the breaker must still FIRE on a real cycle, or the headroom above is
// just a disabled safety net.
Deno.test("cycle detector: a signal written during render is still caught", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    const a = signal(0), b = signal(0);
    // Two components writing each other's signal during render — the ping-pong
    // that cannot converge, and the shape the in-flush breaker exists for.
    const A = () => {
      const v = a.value;
      b.set(v + 1);
      return h("div", { id: "a" }, `a=${v}`);
    };
    const B = () => {
      const v = b.value;
      a.set(v + 1);
      return h("div", { id: "b" }, `b=${v}`);
    };
    const App = () => h("div", null, h(A as never, null), h(B as never, null));
    const handle = mount(root, App);
    a.set(1);
    handle._flush();
    await tick();
    handle._flush();
    await tick();
    assert(
      errors.some((e) => e.includes("re-rendered")),
      `the breaker must fire on a real cycle: ${JSON.stringify(errors)}`,
    );
    _unmount(handle);
  } finally {
    console.error = realError;
    cleanup();
  }
});
