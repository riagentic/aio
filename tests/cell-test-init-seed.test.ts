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
