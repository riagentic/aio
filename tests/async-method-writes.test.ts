// async-method writes across awaits — a field report on a
// trading app hit "writes after the 2nd await silently vanish." That's the
// scariest failure mode: silent state loss. The live-proxy batcher + read-
// your-writes overlay makes every write land regardless of await interleaving;
// these lock that so it can never silently regress.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// deno-lint-ignore no-explicit-any
const doc = () => new Window().document as any;

Deno.test("async: writes before/between/after multiple awaits all commit", async () => {
  const c = cell("aw1", {
    state: { snap: 0, unit: 0, alerting: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      async operate(s: any) {
        s.snap = 1;
        await sleep(3);
        s.unit = 2;
        await sleep(3);
        s.alerting = 3; // the reportedly-dropped write after the 2nd await
      },
    },
  });
  const App = () => h("div", null, `${c.snap}${c.unit}${c.alerting}`);
  const ui = await testUI(App, { document: doc() });
  // deno-lint-ignore no-explicit-any
  await (c as any).operate();
  await ui.settle();
  await sleep(20);
  assertEquals([c.snap, c.unit, c.alerting], [1, 2, 3]);
  await ui.dispose();
});

Deno.test("async: writes ONLY after the 2nd await still commit", async () => {
  const c = cell("aw2", {
    state: { a: 0, b: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      async operate(s: any) {
        await sleep(3);
        await sleep(3); // two awaits, no write yet
        s.a = 5;
        s.b = 6; // both after the last await
      },
    },
  });
  const App = () => h("div", null, `${c.a}${c.b}`);
  const ui = await testUI(App, { document: doc() });
  // deno-lint-ignore no-explicit-any
  await (c as any).operate();
  await ui.settle();
  await sleep(20);
  assertEquals([c.a, c.b], [5, 6]);
  await ui.dispose();
});

Deno.test("async: nested + read-your-writes across awaits", async () => {
  const c = cell("aw3", {
    state: { obj: { a: 0, b: 0 }, log: [] as string[], n: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      async operate(s: any) {
        s.obj.a = 1;
        await sleep(3);
        const cur = s.obj.a; // read-your-writes: sees 1
        s.log.push("read:" + cur);
        await sleep(3);
        s.obj.b = cur + 1; // nested write after 2nd await
        s.n = s.log.length;
      },
    },
  });
  const App = () => h("div", null, JSON.stringify({ o: c.obj, n: c.n }));
  const ui = await testUI(App, { document: doc() });
  // deno-lint-ignore no-explicit-any
  await (c as any).operate();
  await ui.settle();
  await sleep(20);
  assertEquals(c.obj, { a: 1, b: 2 });
  assertEquals(c.log, ["read:1"]);
  assertEquals(c.n, 1);
  await ui.dispose();
});

Deno.test("async: concurrent methods don't drop each other's writes", async () => {
  const c = cell("aw4", {
    state: { a: 0, b: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      async setA(s: any, v: number) {
        await sleep(3);
        s.a = v;
        await sleep(3);
        s.a = v * 10;
      },
      // deno-lint-ignore no-explicit-any
      async setB(s: any, v: number) {
        await sleep(3);
        s.b = v;
        await sleep(3);
        s.b = v * 10;
      },
    },
  });
  const App = () => h("div", null, `${c.a}/${c.b}`);
  const ui = await testUI(App, { document: doc() });
  // deno-lint-ignore no-explicit-any
  await Promise.all([(c as any).setA(1), (c as any).setB(2)]);
  await ui.settle();
  await sleep(30);
  assertEquals([c.a, c.b], [10, 20]);
  await ui.dispose();
});

// Audit 2026-07-24 (HIGH, silent wrong reads): the read-your-writes overlay was
// memoized on (committed identity, pending COUNT). A no-op write (assigning the
// value a field already has) makes Immer commit the SAME slice identity, and
// flush() then starts a fresh batch — so the next single write reproduced the
// exact key of the previous batch and the stale overlay was served. The method
// read back its own write as the pre-write value and committed a wrong result.
Deno.test("async: read-your-writes survives a no-op write + flush (stale overlay)", async () => {
  const c = cell("aw-overlay", {
    state: { loading: false, count: 5 },
    methods: {
      // deno-lint-ignore no-explicit-any
      async tick(s: any) {
        s.loading = false; // no-op write: same value → committed identity unchanged
        if (s.loading) s.count = -1; // read populates the overlay memo
        await sleep(5); // flush happens here: fresh pending array
        s.count = 6; // pending length is 1 again → same (base, count) key
        s.count = s.count + 1; // must read 6, not the stale 5
      },
    },
  });
  const App = () => h("div", null, `${c.count}`);
  const ui = await testUI(App, { document: doc() });
  // deno-lint-ignore no-explicit-any
  await (c as any).tick();
  await ui.settle();
  await sleep(20);
  assertEquals(c.count, 7, "s.count + 1 must see the write from this batch");
  await ui.dispose();
});

// ── throw semantics: the ONE place sync and async methods differ ──────────
//
// A field report (dm #4) worked this out the hard way: it wrote the reason for
// a refusal into state and threw, and the reason never persisted. A SYNC method
// is one Immer recipe — a throw discards the whole draft, so a guard cannot
// both record why it refused and reject. An ASYNC method commits incrementally,
// so everything it wrote is already state when it throws.
//
// Both behaviours are correct for their model and neither can change without
// breaking the other, so the contract is DOCUMENTED (docs/state/methods.md
// "Error handling") — and pinned here, because a doc claim with no gate is how
// it silently drifts.
Deno.test("throw: a SYNC method's writes are rolled back, an ASYNC method's are kept", async () => {
  const c = cell("thr-sem", {
    state: { syncNote: "", syncN: 0, asyncNote: "", asyncPost: "" },
    methods: {
      // deno-lint-ignore no-explicit-any
      refuseSync(s: any) {
        s.syncNote = "refused: too large";
        s.syncN = 1;
        throw new Error("sync refusal");
      },
      // deno-lint-ignore no-explicit-any
      async refuseAsync(s: any) {
        s.asyncNote = "refused: too large";
        await sleep(2);
        s.asyncPost = "written after the await";
        throw new Error("async refusal");
      },
    },
  });
  const App = () => h("div", null, `${c.syncNote}${c.asyncNote}`);
  const ui = await testUI(App, { document: doc() });

  // deno-lint-ignore no-explicit-any
  await (c as any).refuseSync().catch(() => {});
  await ui.settle();
  assertEquals(
    [c.syncNote, c.syncN],
    ["", 0],
    "a sync method that throws must commit NOTHING — the draft is discarded",
  );

  // deno-lint-ignore no-explicit-any
  await (c as any).refuseAsync().catch(() => {});
  await ui.settle();
  await sleep(20);
  assertEquals(
    [c.asyncNote, c.asyncPost],
    ["refused: too large", "written after the await"],
    "an async method commits incrementally — its writes survive its throw",
  );
  await ui.dispose();
});
