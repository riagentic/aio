// async-method writes across awaits (quant Ugly #1) — a field report on a
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
