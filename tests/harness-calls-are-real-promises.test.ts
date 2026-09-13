// A method call under a test harness returns a real Promise, as it does in
// production.
//
// The unobserved-call ledger (harness-unobserved-sync-and-teardown.test.ts)
// needs to know whether a test LOOKED at a call, and it learned that by
// handing back a plain `{ then, catch, finally }` object. That object is not a
// Promise: `cell.inc() instanceof Promise` was true in production and false
// under `testCell`, `bootCells` and `testUI` — first for async methods, then,
// once sync methods joined the ledger, for every method. Code that branches on
// it ran the other branch in its tests. The ledger must keep working through
// the real Promise: awaited failures are delivered, unlooked-at ones surface.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells, testCell, testUI } from "../src/testing/cell-test.ts";
import { h } from "../src/air/vdom.ts";

const mk = (name: string) =>
  cell(name, {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
        return s.n;
      },
      boom(_s: { n: number }) {
        throw new Error(`${name}: sync-kaboom`);
      },
      async ainc(s: { n: number }) {
        await Promise.resolve();
        s.n++;
        return s.n;
      },
    },
  });

// deno-lint-ignore no-explicit-any
type Any = any;

async function allReal(call: (m: string) => unknown): Promise<number> {
  let checked = 0;
  for (const m of ["inc", "boom", "ainc"]) {
    checked++;
    const p = call(m);
    assert(p instanceof Promise, `${m}() is not a Promise`);
    assertEquals(Object.prototype.toString.call(p), "[object Promise]");
    if (m === "boom") {
      await assertRejects(() => p as Promise<unknown>, Error, "sync-kaboom");
    } else {
      assertEquals(typeof await p, "number");
    }
  }
  return checked;
}

const tc = mk("hrp1");
testCell(tc, "testCell: send returns a real Promise", async (t: Any) => {
  assertEquals(await allReal((m) => t.send[m]()), 3);
});

Deno.test("bootCells: a bound method returns a real Promise", async () => {
  const c = mk("hrp2") as Any;
  await using _h = await bootCells([c]);
  assertEquals(await allReal((m) => c[m]()), 3);
});

const uc = mk("hrp3") as Any;
testUI(
  () => h("div", {}, "x"),
  "testUI: a bound method returns a real Promise",
  async () => {
    assertEquals(await allReal((m) => uc[m]()), 3);
  },
);

Deno.test("bootCells: through Promise.all and .finally the call still counts as observed", async () => {
  const c = mk("hrp4") as Any;
  await using _h = await bootCells([c]);
  await assertRejects(() => Promise.all([c.boom()]), Error, "sync-kaboom");
  let ran = false;
  await c.boom().finally(() => ran = true).catch(() => {});
  assert(ran);
});

Deno.test("bootCells: a real Promise nobody looked at still fails the test", async () => {
  const c = mk("hrp5") as Any;
  const h = await bootCells([c]);
  c.boom();
  let msg = "";
  try {
    await (h as Any)[Symbol.asyncDispose]();
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("nothing awaited it"), msg);
});
