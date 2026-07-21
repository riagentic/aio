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
