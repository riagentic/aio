// Prod parity: a worker cell crosses the same boundary in a test as in prod.
//
// The gap this closes was stated out loud in the framework's own boot log —
// "worker cells run in-isolate … Behavior is identical; isolation is not" — and
// the first half of that sentence was not true.
//
// A real worker cell is reached by `postMessage`, so every argument and every
// return value is structured-cloned. In-isolate they were passed by reference.
// Anything that cannot be cloned — a function, a class instance, a live cell
// proxy, an object holding one — therefore worked perfectly in every test and
// threw the moment it ran for real. That is the harness-versus-production gap
// this project calls disqualifying, and it is the one named as the source of
// several multi-day field bugs.
//
// The rule the tests must hold: the harness is the STRICTEST environment, never
// the most permissive.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell.ts";

/** Something a structured clone cannot carry. A function is the smallest
 *  honest example; a class instance with methods is the shape people actually
 *  hit (a Date survives, a `new Foo()` with behaviour does not). */
function makeUncloneable() {
  return { onDone: () => "hi" };
}

Deno.test("worker boundary: an uncloneable ARGUMENT fails in the test, not in prod", async () => {
  const w = cell("wbArg", {
    worker: true,
    state: { got: "" },
    methods: {
      take(s: { got: string }, payload: unknown) {
        s.got = typeof payload;
      },
    },
  });
  await using srv = await testServer({ cells: [w] });
  void srv;

  let threw: Error | null = null;
  try {
    await w.take(makeUncloneable());
  } catch (e) {
    threw = e as Error;
  }
  assert(
    threw,
    "a value that cannot cross a worker boundary was accepted — this test " +
      "would pass while production threw",
  );
  // The message has to name the cell and say why, or it is just a clone error
  // from somewhere in the framework.
  assert(/wbArg/.test(threw.message), threw.message);
  assert(
    /worker boundary|postMessage/.test(threw.message),
    `the failure must explain the boundary: ${threw.message}`,
  );
});

Deno.test("worker boundary: an uncloneable RETURN fails too", async () => {
  const w = cell("wbRet", {
    worker: true,
    state: { n: 0 },
    methods: {
      // Returning a function is the same mistake in the other direction, and
      // the return path is the one people forget: the value looks fine at the
      // call site because it never left this isolate.
      handle(s: { n: number }) {
        s.n++;
        return makeUncloneable();
      },
    },
  });
  await using srv = await testServer({ cells: [w] });
  void srv;

  let threw: Error | null = null;
  try {
    await w.handle();
  } catch (e) {
    threw = e as Error;
  }
  assert(threw, "an uncloneable return value crossed a worker boundary");
  assert(/wbRet/.test(threw.message), threw.message);
  assert(/return value/.test(threw.message), threw.message);
});

Deno.test("worker boundary: ordinary data is unaffected", async () => {
  // The guard must not cost correctness. Everything a worker CAN carry has to
  // behave exactly as before — including the shapes structured clone handles
  // that JSON does not (Date, Map, Set, nested aliasing).
  const w = cell("wbOk", {
    worker: true,
    state: { seen: null as unknown },
    methods: {
      take(s: { seen: unknown }, payload: unknown) {
        s.seen = payload;
      },
      roundTrip(_s: unknown, payload: unknown) {
        return payload;
      },
    },
  });
  await using srv = await testServer({ cells: [w] });
  void srv;

  const when = new Date("2020-01-02T03:04:05Z");
  const payload = {
    n: 1,
    s: "x",
    when,
    list: [1, 2, 3],
    map: new Map([["k", "v"]]),
    set: new Set([1, 2]),
    nested: { deep: { ok: true } },
  };
  const back = await w.roundTrip(payload) as typeof payload;
  assertEquals(back.n, 1);
  assertEquals(back.s, "x");
  assertEquals(back.when.getTime(), when.getTime(), "Date survives a clone");
  assertEquals(back.map.get("k"), "v", "Map survives a clone");
  assertEquals([...back.set], [1, 2], "Set survives a clone");
  assertEquals(back.nested.deep.ok, true);
});

Deno.test("worker boundary: a NON-worker cell is untouched", async () => {
  // The clone is scoped to cells that would have been hosted. An ordinary cell
  // pays nothing and keeps accepting whatever it always accepted — widening
  // this to every dispatch would be a real cost on the hot path for no gain.
  const plain = cell("wbPlain", {
    state: { kind: "" },
    methods: {
      take(s: { kind: string }, payload: { onDone: () => string }) {
        s.kind = typeof payload.onDone;
      },
    },
  });
  await using srv = await testServer({ cells: [plain] });
  void srv;

  await plain.take(makeUncloneable());
  assertEquals(
    plain.kind,
    "function",
    "a non-worker cell must still take a function by reference",
  );
});
