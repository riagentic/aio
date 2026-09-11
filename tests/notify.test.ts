// notify() — the third framework effect, end to end without a window.
//
// The effect is built where the state changes (a method), routed by the one
// router the other two framework effects use, crosses the wire as a declared
// S→C kind, and is readable in testCell without ever arming anything.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell, notify } from "../mod.ts";
import { isNotifyEffect, notifyPayload } from "../src/state/notify.ts";
import { routeEffect } from "../src/state/route-effect.ts";
import { dec, enc, FRAME_KINDS } from "../src/protocol/envelope.ts";
import { testCell } from "../src/cell-test.ts";

Deno.test("notify(): the effect shape, and an empty title is refused where it is written", () => {
  const e = notify({ title: "Done", body: "3 files", route: "/exports" });
  assertEquals(e, {
    type: "__notify",
    title: "Done",
    body: "3 files",
    route: "/exports",
  });
  assert(isNotifyEffect(e));
  assertEquals(notifyPayload(e), {
    title: "Done",
    body: "3 files",
    route: "/exports",
  });
  assertThrows(() => notify({ title: "  " }), Error, "non-empty");
});

Deno.test("routeEffect: a notify effect reaches the notify handler and nothing else", () => {
  const seen: string[] = [];
  routeEffect(notify({ title: "x" }), {
    schedule: () => seen.push("schedule"),
    own: () => seen.push("own"),
    notify: () => seen.push("notify"),
    app: () => seen.push("app"),
  });
  assertEquals(seen, ["notify"]);
});

Deno.test("wire: notify is a declared S→C kind that survives the envelope", () => {
  assert(FRAME_KINDS.includes("notify"));
  const f = dec(enc("notify", { title: "t", body: "b" }));
  assertEquals(f?.t, "notify");
  assertEquals(f?.d, { title: "t", body: "b" });
});

type S = { n: number };
const notifier = cell("notifier", {
  state: { n: 0 } as S,
  methods: {
    done(s) {
      s.n++;
      s.$do(notify({ title: "Done", tag: "job" }));
    },
    plain(s) {
      s.n++;
    },
  },
});

testCell(notifier, "a method's notify effect is recorded and readable", (t) => {
  t.send.done();
  t.expect.state((s) => s.n === 1);
  t.expect.effects(["__notify"]);
});

testCell(
  notifier,
  "an UNREAD notify effect does not fail the test — it arms nothing and owes nothing",
  (t) => {
    t.send.done();
    t.send.plain();
    t.expect.state((s) => s.n === 2);
  },
);
