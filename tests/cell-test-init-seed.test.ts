// `t.init(seed)` — start a test at the state under test.
//
// Without it, every state-dependent test has to drive the cell there through
// real methods. For a cell whose methods shell out or hit the disk that is the
// expensive part, and one field report moved logic OUT of its cell into plain
// functions purely to get a known starting state. Good practice anyway — but
// it should not be the only route.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { testCell } from "aio/testing";

const scan = cell("seedable", {
  state: { scanning: false, found: 0, label: "" },
  methods: {
    stop(s) {
      s.scanning = false;
      s.label = `stopped after ${s.found}`;
    },
  },
});

testCell(scan, "a seed lands on the declared state", (t) => {
  t.init({ scanning: true, found: 42 });
  assertEquals(t.getState().scanning, true);
  assertEquals(t.getState().found, 42);
  assertEquals(t.getState().label, "", "unseeded fields keep their default");
});

testCell(scan, "the seeded state is what methods then see", async (t) => {
  t.init({ scanning: true, found: 7 });
  await t.send.stop!();
  assertEquals(t.getState().label, "stopped after 7");
  assertEquals(t.getState().scanning, false);
});

testCell(scan, "a bare init() still resets to the declared initial", (t) => {
  t.init({ found: 99 });
  t.init();
  assertEquals(t.getState().found, 0);
});

testCell(scan, "an unknown key throws and lists the real ones", (t) => {
  // A silently-ignored seed looks like a pinned fixture while pinning nothing
  // — worse than not having the feature.
  let msg = "";
  try {
    t.init({ scannning: true } as never);
  } catch (e) {
    msg = String(e);
  }
  assert(msg.includes('"scannning"'), `names the bad key: ${msg}`);
  assert(msg.includes("scanning"), `lists the real keys: ${msg}`);
});

// Committed state is frozen in dev AND prod — including the declared initial
// (deep-frozen at compose) and `testUI`'s `seed`. `t.init(seed)` built a fresh
// UNFROZEN slice, so a selector sorting its state in place (`s.items.sort()`)
// passed here and threw in the running app.
const sortable = cell("seedFrozen", {
  state: { items: [3, 1, 2] as number[], cfg: { a: 1 } },
  methods: {
    add(s, n: number) {
      s.items.push(n);
    },
  },
  selectors: { sorted: (s) => s.items.sort() },
});

testCell(
  sortable,
  "a seeded state is frozen like every committed state",
  (t) => {
    t.init({ items: [9, 8, 7] });
    assert(Object.isFrozen(t.state), "the seeded slice is frozen");
    assert(Object.isFrozen(t.state.items), "a seeded array is frozen");
    let threw = false;
    try {
      (sortable as unknown as { sorted: () => number[] }).sorted();
    } catch {
      threw = true;
    }
    assert(threw, "an in-place sort of seeded state throws, as in prod");
    assertEquals(t.state.items, [9, 8, 7], "the seed was not mutated");
    t.destroy();
    assert(Object.isFrozen(t.state), "destroy() leaves a frozen slice too");
  },
);
