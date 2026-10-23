// `await c.save(); c.$pending("save")` reads 0 in a running app.
//
// The in-isolate executor answered the caller (`resolveCall`) and dropped the
// `$pending` count later, in the chain's last `.finally` — kept last so the
// call stays CANCELLABLE until its writes are in. So the caller's `await`
// resumed first and read its own finished call as still running: 1 in an app
// (`testServer`), while bootCells — and the same cell with `worker: true`,
// whose count drops before the reply crosses back — read 0. Code like
// `await todo.save(); if (!todo.$pending("save")) toast("All saved")` never
// toasted in production and did in every test.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `cell.$pending` — on the bound cell at runtime. */
const pending = (c: unknown, m?: string): number =>
  (c as { $pending(m?: string): number }).$pending(m);

const pc = cell("pendans", {
  state: { n: 0 },
  concurrency: { queued: "queue" },
  methods: {
    async plain(s) {
      await tick(5);
      s.n++;
    },
    async queued(s) {
      await tick(5);
      s.n++;
    },
    async thrower(_s) {
      await tick(5);
      throw new Error("boom");
    },
  },
});

const tx = cell("pendanstx", {
  transaction: true,
  state: { n: 0 },
  methods: {
    async save(s) {
      await tick(5);
      s.n++;
    },
  },
});

Deno.test("$pending: a settled async call is not counted when its caller resumes", async () => {
  await using _srv = await testServer({ cells: [pc, tx] });
  const seen: Record<string, number> = {};
  await pc.plain();
  seen.plain = pending(pc, "plain");
  await pc.queued();
  seen.queued = pending(pc, "queued");
  await pc.thrower().catch(() => {});
  seen.thrower = pending(pc, "thrower");
  await tx.save();
  seen.tx = pending(tx, "save");
  seen.cell = pending(pc);
  assertEquals(seen, { plain: 0, queued: 0, thrower: 0, tx: 0, cell: 0 });
});

Deno.test("$pending: overlapping calls count down one per answered caller", async () => {
  await using _srv = await testServer({ cells: [pc] });
  const a = pc.queued(), b = pc.queued();
  assertEquals(pending(pc, "queued"), 2);
  await a;
  assertEquals(pending(pc, "queued"), 1);
  await b;
  assertEquals(pending(pc, "queued"), 0);
});
