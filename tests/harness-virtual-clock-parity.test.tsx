// The harness has ONE clock: the one app code reads and the one schedules run on.
//
// The virtual schedule clock started at the real `Date.now()` and moved only on
// `advance`, while `Date.now()` in app code did not move at all. After
// `h.advance(10_000)` the two were ten seconds apart, so a method writing
// `schedule.at(new Date(Date.now() + 5000))` — correct code — was refused as
// "in the past" and never fired; against a real server it fires. The same gap
// meant a TTL checked against `Date.now()` never expired however far a test
// advanced.
//
// And `schedule.next` ("right after the current method returns", a true 0 ms
// timer) ran within milliseconds on a real server but never under `settle()` /
// `waitFor` — only an explicit `advance(0)` fired it, so `settle()` reported
// quiet with work queued.
import { assert, assertEquals } from "@std/assert";
import { cell, schedule, self } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";

type S = { after: number; atFired: number; next: number; firedAt: number };
const sc = cell("vclock", {
  state: { after: 0, atFired: 0, next: 0, firedAt: 0 },
  methods: {
    startAfter(s) {
      s.$do(schedule.after("vclock:a", 100, self("afterFire")));
    },
    afterFire(s: S) {
      s.after++;
      s.firedAt = Date.now();
    },
    startAt(s, iso: string) {
      s.$do(schedule.at("vclock:at", iso, self("atFire")));
    },
    atFire(s: S) {
      s.atFired++;
    },
    startNext(s) {
      s.$do(schedule.next("vclock:n", self("nextFire")));
    },
    nextFire(s: S) {
      s.next++;
    },
  },
});
const X = sc as unknown as S & {
  startAfter: () => Promise<void>;
  startAt: (iso: string) => Promise<void>;
  startNext: () => Promise<void>;
};
const RealDate = Date;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("clock parity: the real server fires an absolute `at` a moment from Date.now()", async () => {
  await using srv = await testServer({ cells: [sc] });
  await X.startAt(new Date(Date.now() + 150).toISOString());
  await sleep(300);
  assertEquals((srv.state() as { vclock: S }).vclock.atFired, 1);
});

Deno.test("clock parity: after advance(), `at(Date.now() + 5s)` is in the future, and fires", async () => {
  await using h = await bootCells([sc]);
  await X.startAfter();
  await h.advance(10_000); // an earlier step of the same test moved time on
  assertEquals(X.after, 1);
  await X.startAt(new Date(Date.now() + 5_000).toISOString());
  await h.advance(4_000);
  assertEquals(X.atFired, 0, "not yet — 5 s had not passed");
  await h.advance(2_000);
  assertEquals(X.atFired, 1, "the harness fires what the server fires");
});

Deno.test("clock parity: Date.now() / new Date() / Date() move with advance, and are real again after dispose", async () => {
  const before = RealDate.now();
  const made = new Date(); // created before the clock moves
  {
    await using h = await bootCells([sc]);
    await X.startAfter();
    await h.advance(60_000);
    assert(Date.now() - before >= 60_000, "Date.now() saw the minute pass");
    assert(new Date().getTime() - before >= 60_000, "new Date() too");
    assert(new Date(0).getTime() === 0, "an explicit time is untouched");
    assert(
      RealDate.parse(Date()) >=
        RealDate.parse(new RealDate(before + 59_000).toString()),
      "Date() as a function too",
    );
    // A schedule and the method it fires read the same clock.
    assert(X.firedAt - before >= 100, `fired at +${X.firedAt - before}ms`);
    assert(made instanceof Date, "an earlier Date is still a Date");
    assert(new Date() instanceof RealDate, "a new one is a real Date");
    assertEquals(Date.UTC(2026, 0, 1), RealDate.UTC(2026, 0, 1));
  }
  assert(globalThis.Date === RealDate, "the real Date is back after dispose");
  assert(Date.now() - before < 60_000, "and it tells the real time");
});

Deno.test("clock parity: the real server runs schedule.next right after the method", async () => {
  await using srv = await testServer({ cells: [sc] });
  await X.startNext();
  await sleep(30);
  assertEquals((srv.state() as { vclock: S }).vclock.next, 1);
});

Deno.test("clock parity: bootCells settle() runs a due schedule.next", async () => {
  await using h = await bootCells([sc]);
  await X.startNext();
  await h.settle();
  assertEquals(X.next, 1);
});

Deno.test("clock parity: testUI settle()/waitFor run a due schedule.next — later timers still wait", async () => {
  await using ui = await testUI(() => h("div", null, "x"), { cells: [sc] });
  await X.startNext();
  await X.startAfter(); // 100 ms: NOT due — settle must not run it
  await ui.waitFor(() => X.next === 1, { timeoutMs: 500 });
  await ui.settle();
  assertEquals(X.after, 0, "only what is due now fires; advance() drives time");
  await ui.advance(100);
  assertEquals(X.after, 1);
});
