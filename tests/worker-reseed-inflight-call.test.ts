// A worker cell's call that is IN FLIGHT when the main isolate swaps state
// wholesale (`app.loadSnapshot`, a time-travel jump) must not leave the
// authoritative replica on main and the worker's copy disagreeing — and the
// call's own promise must still settle.
//
// The worker processes messages FIFO: a call posted before the re-seed runs
// first, against the OLD slice, and streams its patches home; then the `init`
// re-seed replaces the worker's slice with the snapshot. On main the snapshot
// was applied synchronously BEFORE those patches arrived, so they used to be
// applied ON TOP of the restored state: main held snapshot + the call's write,
// the worker held the snapshot only, and every later read the worker served
// (a return value, the base of its next patch) disagreed with what clients and
// persistence saw.
//
// Decided semantics (cell-worker.ts, the `gen` on `init`/`patches`): a batch
// committed against a slice the owner has since replaced is dropped on main,
// exactly as the worker's re-seed drops it there — the call ran BEFORE the
// load, so the load discards it, as it discards any earlier write. The call's
// promise RESOLVES with the value the method returned; a write committed
// after the re-seed (a streaming method's later iterations) lands on both.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wdiff } from "./fixtures/worker-differential-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-differential-app.ts");
const W = wdiff as unknown as {
  setKey(k: string, v: unknown): Promise<unknown>;
  push(x: number): Promise<unknown>;
  inc(k: number): Promise<number>;
  asyncInc(k: number): Promise<number>;
  stream(count: number): Promise<number>;
  retObj(): Promise<unknown>;
  retList(): Promise<unknown>;
};
type Slice = { n: number; list: number[]; obj: Record<string, unknown> };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

/** Settle `p` or fail naming it — a hung call is the bug, not a slow test. */
async function settles<T>(p: Promise<T>, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(
          () => rej(new Error(`${what}: the call never settled`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

async function boot() {
  const srv = await testServer({
    cells: [wdiff],
    workers: "real",
    workerEntry: ENTRY,
  });
  const app = srv.app as unknown as {
    snapshot(): string;
    loadSnapshot(s: string): void;
  };
  const main = () => (srv.state() as { wdiff: Slice }).wdiff;
  /** The WORKER's own copy, read through methods that write nothing. */
  const worker = async () => ({
    n: await W.inc(0),
    list: await W.retList(),
    obj: await W.retObj(),
  });
  const agree = async (why: string) => {
    await tick(50);
    const m = main();
    assertEquals(
      plain(await worker()),
      plain({ n: m.n, list: m.list, obj: m.obj }),
      `main replica and worker copy diverged: ${why}`,
    );
  };
  return { srv, app, main, agree };
}

Deno.test("worker cell: a sync call in flight across loadSnapshot leaves main and worker agreeing", async () => {
  const { srv, app, main, agree } = await boot();
  await using _srv = srv;
  await W.setKey("base", 1);
  const snap = app.snapshot();
  // Posted to the worker, NOT awaited: the load happens while it travels.
  const inflight = W.setKey("late", 2);
  app.loadSnapshot(snap);
  await settles(inflight, "setKey");
  await agree("a sync write raced the re-seed");
  // …and the snapshot won on both sides: the call ran before the load.
  assertEquals(plain(main().obj), { a: 1, base: 1 });
  // A later write builds on the SAME base on both sides.
  assertEquals(await W.push(7), main().list.length);
  await agree("the write after the re-seed");
});

Deno.test("worker cell: an async call in flight across loadSnapshot settles with its value, and both sides agree", async () => {
  const { srv, app, agree } = await boot();
  await using _srv = srv;
  await W.inc(3);
  const snap = app.snapshot();
  const inflight = W.asyncInc(10);
  app.loadSnapshot(snap);
  // It ran against the slice it was handed, and says so; the load then
  // replaced that slice everywhere.
  assertEquals(await settles(inflight, "asyncInc"), 13);
  await agree("an async write raced the re-seed");
});

Deno.test("worker cell: a streaming call spanning the re-seed lands its LATER writes on both sides", async () => {
  const { srv, app, main, agree } = await boot();
  await using _srv = srv;
  const snap = app.snapshot();
  // 30 commits, 1ms apart: the re-seed lands in the middle of them.
  const inflight = W.stream(30);
  await tick(10);
  app.loadSnapshot(snap);
  const len = await settles(inflight, "stream");
  await agree("a streaming method crossed the re-seed");
  // The worker's answer describes the state everyone now holds.
  assertEquals(len, main().list.length);
});

Deno.test("worker cell: repeated re-seeds racing calls never diverge", async () => {
  const { srv, app, agree } = await boot();
  await using _srv = srv;
  const snap = app.snapshot();
  for (let i = 0; i < 10; i++) {
    const a = W.push(i);
    const b = W.setKey(`k${i}`, i);
    if (i % 2 === 0) app.loadSnapshot(snap);
    const c = W.asyncInc(1);
    const [len, , n] = await settles(Promise.all([a, b, c]), `round ${i}`);
    // Every call settled WITH its value — none was swallowed by the drop.
    assertEquals([typeof len, typeof n], ["number", "number"]);
  }
  await agree("ten rounds of calls racing re-seeds");
});
