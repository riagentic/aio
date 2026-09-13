// A worker cell's RETURN value crosses the boundary in every harness, and its
// ARGUMENTS do in testCell/bootCells/testUI too — the same clone a real
// worker's postMessage makes.
//
// testServer cloned the value its dispatch promise resolved, which for an
// async method is `undefined` (the method answers through its registered
// call). Measured against a real worker:
//
//                       prod worker      testServer   bootCells / testCell
//   return new K()      plain object     instance     instance
//   return () => 1      throws           a function   a function
//   take(() => 1)       throws           throws       ran, typeof "function"
//
// (tests/prod-parity-worker-boundary.test.ts covers the sync-method half.)
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import {
  bootCells,
  testCell,
  testServer,
  testUI,
} from "../src/testing/cell-test.ts";
import { h } from "../src/air/vdom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

class K {
  x = 1;
  hello() {
    return "hi";
  }
}

const make = (name: string) =>
  cell(name, {
    worker: true,
    state: { t: "" },
    methods: {
      async take(s: Any, f: unknown) {
        await Promise.resolve();
        s.t = typeof f;
      },
      async retK(_s: Any) {
        await Promise.resolve();
        return new K();
      },
      async retFn(_s: Any) {
        await Promise.resolve();
        return () => 1;
      },
      retKSync(_s: Any) {
        return new K();
      },
      async retPlain(_s: Any, v: { n: number; when: Date }) {
        await Promise.resolve();
        return { ...v, n: v.n + 1 };
      },
    },
  } as Any) as Any;

async function boundary(
  call: (m: string, ...a: unknown[]) => Promise<unknown>,
): Promise<"crossed"> {
  const k = await call("retK") as { x: number };
  assert(!(k instanceof K), "a class instance came back an instance");
  assertEquals(k.x, 1);
  const ks = await call("retKSync") as { x: number };
  assert(!(ks instanceof K), "sync: a class instance came back an instance");
  await assertRejects(() => call("retFn"), Error, "return value cannot cross");
  await assertRejects(
    () => call("take", () => 1),
    Error,
    "action payload cannot cross",
  );
  const when = new Date(5);
  const back = await call("retPlain", { n: 1, when }) as {
    n: number;
    when: Date;
  };
  assertEquals(back.n, 2);
  assertEquals(back.when.getTime(), 5);
  return "crossed";
}

Deno.test("testServer: an async worker method's return value is cloned", async () => {
  const w = make("wbr1");
  await using _s = await testServer({ cells: [w] });
  assertEquals(await boundary((m, ...a) => w[m](...a)), "crossed");
});

Deno.test("bootCells: arguments and return values cross the boundary", async () => {
  const w = make("wbr2");
  await using _h = await bootCells([w]);
  assertEquals(await boundary((m, ...a) => w[m](...a)), "crossed");
});

Deno.test("testUI: arguments and return values cross the boundary", async () => {
  const w = make("wbr5");
  await using _ui = await testUI(() => h("div", {}, "x"), { cells: [w] });
  assertEquals(await boundary((m, ...a) => w[m](...a)), "crossed");
});

const w3 = make("wbr3");
testCell(
  w3,
  "testCell: arguments and return values cross the boundary",
  async (t: Any) => {
    assertEquals(await boundary((m, ...a) => t.send[m](...a)), "crossed");
  },
);

Deno.test("a NON-worker cell keeps references in bootCells", async () => {
  const plain = cell("wbr4", {
    state: { t: "" },
    methods: {
      async take(s: Any, f: unknown) {
        await Promise.resolve();
        s.t = typeof f;
      },
      async retK(_s: Any) {
        await Promise.resolve();
        return new K();
      },
    },
  } as Any) as Any;
  await using _h = await bootCells([plain]);
  await plain.take(() => 1);
  assertEquals(plain.t, "function");
  assert((await plain.retK()) instanceof K);
});
