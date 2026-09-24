// `concurrency: "queue"` (and `transaction: { serialize: true }`) with NOTHING
// ahead of the call must start it NOW, in call order — like every other mode.
//
// field report (a desktop map app) §2: the queue chained each call on the method's tail,
// and an empty tail was `Promise.resolve()` — still a microtask of deferral. So
//
//     const p = c.read(); await c.set("b"); await p;
//
// ran the sync `set` FIRST and the queued `read` saw "b", while "newest",
// "first" and no policy all saw "a". The serialize mutex had the same shape.
// The queue still serializes when a call IS in flight (last test).
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type S = { v: string; seen: string; log: string[] };

const mk = (id: string, extra: Record<string, unknown>) =>
  cell(id, {
    state: { v: "a", seen: "", log: [] as string[] },
    ...extra,
    methods: {
      set(s: S, v: string) {
        s.v = v;
      },
      // Reads, never writes: a serialized TRANSACTION that wrote after the
      // set would (rightly) be refused as a conflict — this is about order.
      async read(s: S) {
        const seen = s.v;
        await Promise.resolve();
        return seen;
      },
    },
  } as Any) as Any;

for (
  const [mode, extra] of [
    ["queue", { concurrency: { read: "queue" } }],
    ["newest", { concurrency: { read: "newest" } }],
    ["first", { concurrency: { read: "first" } }],
    ["none", {}],
    ["serialize", { transaction: { serialize: true } }],
  ] as const
) {
  Deno.test(`call order: a ${mode} call with nothing ahead starts before a call made after it`, async () => {
    const c = mk(`ordr_${mode}`, extra);
    await using _h = await bootCells([c]);
    const p = c.read();
    await c.set("b");
    assertEquals(await p, "a", `${mode}: the later set ran first`);
    // Again, right after the previous call was awaited: its slot is free the
    // moment its caller heard, not when its trailing cleanup settles.
    const q = c.read();
    await c.set("c");
    assertEquals(
      await q,
      "b",
      `${mode}: a drained queue deferred the next call`,
    );
  });
}

Deno.test("call order: queue still runs one at a time while a call is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const c: Any = cell("ordr_q_busy", {
    state: { log: [] as string[], v: "a" },
    concurrency: { step: "queue", peek: "queue" },
    methods: {
      set(s: { v: string }, v: string) {
        s.v = v;
      },
      async peek(s: { v: string }) {
        const seen = s.v;
        await Promise.resolve();
        return seen;
      },
      async step(s: { log: string[] }, n: string) {
        s.log = [...s.log, `start ${n}`];
        if (n === "1") await gate;
        s.log = [...s.log, `end ${n}`];
      },
    },
  } as Any);
  await using h = await bootCells([c]);
  const one = c.step("1");
  const two = c.step("2");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assertEquals(c.log, ["start 1"], "the second call waited for the first");
  release();
  await Promise.all([one, two]);
  await h.settle();
  assertEquals(c.log, ["start 1", "end 1", "start 2", "end 2"]);
  // …and once a method's queue has drained, its next call starts at once
  // again — a settled tail left behind deferred it just like an empty one.
  const p = c.peek();
  await p; // peek's own queue: one call, done
  const q = c.peek();
  await c.set("b");
  assertEquals(await q, "a", "a drained queue still deferred the next call");
});
