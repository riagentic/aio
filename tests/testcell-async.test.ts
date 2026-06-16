// AIO-379: testCell async-aware send + deterministic settle()
//
// t.send.<asyncMethod>() returns a lazy completion promise: dispatch stays
// synchronous (legacy fire-and-forget tests unchanged), but awaiting it runs
// the method and resolves when all its writes are applied. settle() tracks
// async method triggers to real completion instead of guessing microtasks.

import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/cell.ts";
import { testCell } from "../src/cell-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sideEffectRuns = 0;

const loader = cell("loader379", {
  state: {
    data: null as string | null,
    count: 0,
    error: null as string | null,
  },
  methods: {
    bump(s) {
      s.count += 1;
    },
    async load(s) {
      // Slow async work — longer than any microtask drain can cover.
      await sleep(30);
      sideEffectRuns += 1;
      s.data = "loaded";
    },
    async boom(s) {
      s.data = "exploding";
      await sleep(5);
      throw new Error("kaboom");
    },
  },
});

const gated = cell("gated379", {
  state: { ran: false },
  machine: {
    initial: "locked",
    states: {
      locked: { unlock: "open" },
      open: { run: "open", unlock: "open" },
    },
  },
  methods: {
    unlock(_s) {},
    async run(s) {
      await sleep(5);
      s.ran = true;
    },
  },
});

testCell(
  loader,
  "await send: async method fully applied on resolve",
  async (t) => {
    t.init();
    await t.send.load!();
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(loader, "sync sends return an awaitable promise too", async (t) => {
  t.init();
  await t.send.bump!();
  t.expect.state((s) => s.count === 1);
});

testCell(loader, "unawaited send stays fire-and-forget (no execution)", (t) => {
  t.init();
  const before = sideEffectRuns;
  t.send.load!(); // never awaited, never settled — method must not run
  t.expect.state((s) => s.data === null);
  assertEquals(sideEffectRuns, before);
});

testCell(
  loader,
  "settle() waits for real async completion (no ms guessing)",
  async (t) => {
    t.init();
    t.send.load!();
    await t.settle(); // 30ms of real work — old microtask drain would miss this
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(
  loader,
  "await send then settle(): method executes exactly once",
  async (t) => {
    t.init();
    const before = sideEffectRuns;
    await t.send.load!();
    await t.settle();
    await t.settle();
    assertEquals(sideEffectRuns, before + 1);
  },
);

testCell(
  loader,
  "settle() then await send: no double execution either",
  async (t) => {
    t.init();
    const before = sideEffectRuns;
    const done = t.send.load!();
    await t.settle();
    await done; // resolves immediately — settle already ran and awaited it
    assertEquals(sideEffectRuns, before + 1);
    t.expect.state((s) => s.data === "loaded");
  },
);

testCell(loader, "await send rejects when the method throws", async (t) => {
  t.init();
  await assertRejects(() => t.send.boom!(), Error, "kaboom");
  // Writes before the throw were applied — same semantics as production.
  t.expect.state((s) => s.data === "exploding");
});

testCell(
  loader,
  "settle() swallows method errors (wait-until-quiet, not assert)",
  async (t) => {
    t.init();
    t.send.boom!();
    await t.settle(); // must not reject
    t.expect.state((s) => s.data === "exploding");
  },
);

testCell(
  gated,
  "awaiting a machine-blocked async send resolves immediately",
  async (t) => {
    t.init();
    await t.send.run!(); // blocked in 'locked' — resolves, runs nothing
    t.expect.status("locked");
    t.expect.state((s) => s.ran === false);

    t.send.unlock!();
    await t.send.run!();
    t.expect.status("open");
    t.expect.state((s) => s.ran === true);
  },
);
