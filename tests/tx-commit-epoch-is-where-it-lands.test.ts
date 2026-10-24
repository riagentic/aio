// A transaction's `s.$commit()` starts a new epoch at the state its write-set
// LANDS on — never later.
//
// The epoch (what reads see, and what the commit-time conflict check compares
// against) was guessed from identity: "has the state object moved since the
// flush?". Two ways it adopted a FOREIGN commit as its own, so a value read
// before that commit and written back after it passed the conflict check — a
// lost update, the exact thing `transaction:` exists to refuse:
//
// - a `$commit` whose write-set changed nothing (`s.progress = s.progress`)
//   leaves the state object as it was, so the epoch stayed open until the
//   next commit — somebody else's;
// - a `$commit` queued behind a running drain (a call's first frame runs
//   inside one) re-based on the next microtask, after the loop had reduced
//   whatever was queued behind it.
//
// Found by tests/cell-concurrency-differential.test.ts.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => e.message.includes("changed by another") ? "conflict" : e,
  );
let queuedOutcome: Promise<unknown> = Promise.resolve();

const mk = (id: string) => {
  const c: Any = cell(id, {
    state: { n: 0, p: 0 },
    transaction: true,
    methods: {
      inc(s: { n: number }, k: number) {
        s.n += k;
      },
      // A no-op `$commit`, then a read-modify-write with a foreign commit in
      // between.
      async noop(s: Any) {
        await null;
        s.p = 0;
        s.$commit();
        s.n += 5;
        c.inc(8);
      },
      // First frame (inside the drain): `$commit`, read; the queued `inc`
      // lands before the next microtask; write back after the await.
      async queued(s: Any) {
        s.p = 1;
        s.$commit();
        const x = s.n;
        await null;
        s.n = x + 5;
      },
      both() {
        queuedOutcome = outcome(c.queued());
        c.inc(13);
      },
    },
  });
  return c;
};

// The read-modify-write is refused (TX_CONFLICT), and the foreign `+k`
// survives.
async function check(cells: Any[]) {
  const noop = await outcome(cells[0].noop());
  await sleep(30);
  assertEquals({ noop, n: cells[0].n }, { noop: "conflict", n: 8 });
  await cells[1].both();
  await sleep(30);
  assertEquals(
    { queued: await queuedOutcome, n: cells[1].n },
    { queued: "conflict", n: 13 },
  );
}

Deno.test({ // aio-ok: the assertions are in check()
  name: "$commit epoch is the state it lands on — server",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const cells = [mk("ep_srv_a"), mk("ep_srv_b")];
    const srv = await testServer({ cells });
    try {
      await check(cells);
    } finally {
      await srv.close();
    }
  },
});

Deno.test("$commit epoch is the state it lands on — bootCells", async () => { // aio-ok: the assertions are in check()
  const cells = [mk("ep_boot_a"), mk("ep_boot_b")];
  const h = await bootCells(cells);
  try {
    await check(cells);
  } finally {
    h.dispose();
  }
});
