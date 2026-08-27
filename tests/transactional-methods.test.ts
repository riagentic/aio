// transactional cell methods (opt-in `transaction: true`). Reads see
// a stable snapshot captured at entry; writes commit atomically at return; a
// throw discards. Spec: docs/state/transactional-methods.md §7.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import {
  conflictPath,
  createReadWatch,
  watchKey,
} from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let gate: (() => void) | null = null;
const wait = () => new Promise<void>((r) => (gate = r));

Deno.test("transaction: a read AFTER await sees the entry snapshot, not live state", async () => {
  const c = cell("txn_snap", {
    transaction: true,
    state: { a: 0, b: -1 },
    methods: {
      async readback(s: { a: number; b: number }) {
        await wait();
        s.b = s.a; // reads a AFTER the await
      },
      bump(s: { a: number }) {
        s.a += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).readback(); // reads snapshot a=0, then awaits
    await (c as Any).bump(); // a → 1 committed while slow is suspended
    assertEquals((c as Any).a, 1);
    gate!(); // slow resumes: reads the SNAPSHOT (a was 0 at entry), not live 1
    await slow;
    await h.settle();
    assertEquals((c as Any).a, 1, "bump committed");
    assertEquals(
      (c as Any).b,
      0,
      "snapshot read: a=0 at entry, not the live 1",
    );
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: writes are NOT visible until the method returns (atomic)", async () => {
  const c = cell("txn_atomic", {
    transaction: true,
    state: { a: 0, b: 0 },
    methods: {
      async both(s: { a: number; b: number }) {
        s.a = 1; // buffered, not committed yet
        await wait();
        s.b = 2;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).both();
    await Promise.resolve();
    // Mid-flight: neither write is committed (would be a=1 live if incremental).
    assertEquals((c as Any).a, 0, "no partial commit mid-transaction");
    assertEquals((c as Any).b, 0);
    gate!();
    await p;
    await h.settle();
    assertEquals((c as Any).a, 1, "both writes land atomically at return");
    assertEquals((c as Any).b, 2);
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: a throw discards the whole write-set", async () => {
  const c = cell("txn_abort", {
    transaction: true,
    state: { a: 0 },
    methods: {
      // deno-lint-ignore require-await
      async boom(s: { a: number }) {
        s.a = 99;
        throw new Error("nope");
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await assertRejects(() => (c as Any).boom(), Error, "nope");
    await h.settle();
    assertEquals((c as Any).a, 0, "the aborted write was discarded");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: s.$commit() publishes mid-method, then reads a fresh snapshot", async () => {
  // The method waits on a gate the TEST opens, so "mid-flight" is an actual
  // suspension point rather than a guess at how many microtasks the framework
  // spends between the body returning and the caller resolving. (It was the
  // guess; a chain one `.then` shorter made the method finish first and the
  // test read the final value.)
  let open!: () => void;
  const gate = new Promise<void>((r) => open = r);
  const c = cell("txn_commit", {
    transaction: true,
    state: { step: 0 },
    methods: {
      async run(s: { step: number }) {
        s.step = 1;
        (s as unknown as { $commit: () => void }).$commit(); // publish mid-method
        await gate;
        // After $commit, a read sees the just-committed snapshot (step=1).
        s.step = s.step + 10; // 1 + 10
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).run();
    await Promise.resolve();
    await Promise.resolve();
    // The mid-method $commit is visible while the method is still suspended.
    assertEquals((c as Any).step, 1, "$commit published step=1 mid-flight");
    open();
    await p;
    await h.settle();
    assertEquals((c as Any).step, 11, "post-commit read saw 1, then +10");
  } finally {
    h.dispose();
  }
});

// ── $commit must not poison the rest of its own transaction ────────────
//
// One method, one cell, ZERO concurrency: the only writer in the process is the
// method itself. Anything the conflict detector says here is by definition a
// phantom. It used to say plenty: `origin` was pinned at entry and never moved
// with `$commit`, so every CONTAINER the commit published compared entry-value
// against the value Immer had just built — a different object, therefore
// "changed by another action" — and the remaining write-set was discarded.

Deno.test("transaction: $commit does not phantom-conflict with its own publish", async () => {
  const c = cell("txn_commit_self", {
    transaction: true,
    state: { chunks: [] as string[] },
    methods: {
      async stream(s: { chunks: string[] }) {
        s.chunks.push("a");
        (s as Any).$commit(); // publish progress mid-flight
        await Promise.resolve();
        const n = s.chunks.length; // read a container we published
        s.chunks.push("b"); // …and write it again
        return n;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const n = await (c as Any).stream();
    await h.settle();
    assertEquals(n, 1, "the post-$commit read sees the published chunk");
    assertEquals((c as Any).chunks, ["a", "b"], "the tail write-set committed");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction serialize: an ANCESTOR read after $commit is not a phantom conflict", async () => {
  // The narrower half of the same bug: `flushed` held exact mutation paths, so
  // enumerating the CONTAINER of a published leaf compared entry-origin against
  // post-commit-live and conflicted under strictReads.
  const c = cell("txn_commit_ancestor", {
    transaction: { serialize: true },
    state: { doc: {} as Record<string, number>, keys: 0 },
    methods: {
      async work(s: { doc: Record<string, number>; keys: number }) {
        s.doc.n = 1;
        (s as Any).$commit();
        await Promise.resolve();
        s.keys = Object.keys(s.doc).length; // ancestor read of a published leaf
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await (c as Any).work();
    await h.settle();
    assertEquals((c as Any).keys, 1);
    assertEquals((c as Any).doc, { n: 1 });
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: $commit re-bases the epoch — a LATER foreign write still conflicts", async () => {
  // The half that must not regress: re-basing at $commit must move the pin
  // forward, not switch conflict detection off for the rest of the method.
  const p = parkPoint();
  const c = cell("txn_commit_rebase", {
    transaction: true,
    state: { items: [] as string[] },
    methods: {
      async grow(s: { items: string[] }) {
        s.items.push("a");
        (s as Any).$commit();
        await p.park(); // a sync method replaces items here
        s.items = [...s.items, "b"]; // RMW over the re-based (stale) pin
      },
      replace(s: { items: string[] }) {
        s.items = ["foreign"];
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).grow();
    await p.parked;
    await (c as Any).replace();
    p.release();
    await assertRejects(() => slow, Error, "changed by another action");
    await h.settle();
    assertEquals((c as Any).items, ["foreign"], "the foreign write survives");
  } finally {
    h.dispose();
  }
});

// ── a cancelled transaction discards its write-set (spec §4 "Abort") ────

Deno.test("transaction: a CANCELLED method discards its write-set (no stale commit)", async () => {
  // The documented supersession pattern (docs/state/methods.md): newest call
  // wins, the superseded one checks $signal and returns. Non-transactionally
  // the loser's pre-await writes flush on a microtask and land FIRST, so the
  // winner overwrites them. Under `transaction: true` the whole write-set
  // buffers to the END — so the loser committed LAST and clobbered the winner:
  // the query stuck on the abandoned term, the spinner never clearing.
  const slowGate = parkPoint();
  const c = cell("txn_cancel_super", {
    transaction: true,
    cancelOn: { search: "self" },
    state: { query: "", busy: false, results: [] as string[] },
    methods: {
      async search(
        s: { query: string; busy: boolean; results: string[] },
        q: string,
        slow: boolean,
      ) {
        s.query = q;
        s.busy = true;
        if (slow) await slowGate.park();
        if ((s as Any).$signal.aborted) return;
        s.results = [q];
        s.busy = false;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const first = (c as Any).search("cat", true); // parks, then is superseded
    await slowGate.parked;
    await (c as Any).search("cats", false); // the winner: commits fully
    slowGate.release();
    await first;
    await h.settle();
    assertEquals((c as Any).query, "cats", "the winner's query stands");
    assertEquals((c as Any).results, ["cats"]);
    assertEquals((c as Any).busy, false, "the spinner clears");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: cancellation keeps what $commit already published", async () => {
  // Abort discards the BUFFER, not history: progress the method deliberately
  // published mid-flight is committed state and survives its cancellation.
  const p = parkPoint();
  const c = cell("txn_cancel_partial", {
    transaction: true,
    cancelOn: { run: ["txn_cancel_partial:stop"] },
    state: { published: 0, tail: 0 },
    methods: {
      async run(s: { published: number; tail: number }) {
        s.published = 1;
        (s as Any).$commit();
        await p.park();
        s.tail = 1; // buffered — discarded on abort
      },
      stop(_s: { published: number }) {},
    },
  });
  const h = await bootCells([c]);
  try {
    const running = (c as Any).run();
    await p.parked;
    await (c as Any).stop();
    p.release();
    await running;
    await h.settle();
    assertEquals((c as Any).published, 1, "the mid-flight publish survives");
    assertEquals((c as Any).tail, 0, "the buffered tail was discarded");
  } finally {
    h.dispose();
  }
});

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

Deno.test("transaction serialize: concurrent read-modify-write does NOT lose updates", async () => {
  const c = cell("txn_serial", {
    transaction: { serialize: true },
    state: { n: 0 },
    methods: {
      async incRMW(s: { n: number }) {
        const cur = s.n; // read
        await tick();
        s.n = cur + 1; // modify-write
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await Promise.all([(c as Any).incRMW(), (c as Any).incRMW()]);
    await h.settle();
    assertEquals((c as Any).n, 2, "serialized RMW: both increments land");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction WITHOUT serialize: a lost update is REFUSED, not silent", async () => {
  const c = cell("txn_noserial", {
    transaction: true, // snapshot isolation, but no mutex
    state: { n: 0 },
    methods: {
      async incRMW(s: { n: number }) {
        const cur = s.n;
        await tick();
        s.n = cur + 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    // Both read the same snapshot (0) and both want to write 1. That used to be
    // a documented lost update: n === 1, nothing said. Now the second commit
    // sees that n moved under it and refuses — the caller finds out.
    const results = await Promise.allSettled([
      (c as Any).incRMW(),
      (c as Any).incRMW(),
    ]);
    await h.settle();
    const rejected = results.filter((r) => r.status === "rejected");
    assertEquals(rejected.length, 1, "exactly one transaction is refused");
    const why = String((rejected[0] as PromiseRejectedResult).reason);
    assertStringIncludes(why, "s.n was changed by another action");
    assertStringIncludes(why, "s.$live");
    assertEquals((c as Any).n, 1, "the winner's write stands, uncorrupted");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: a blind write is last-writer-wins, never a conflict", async () => {
  // The RMW check must not fire on writes that were not derived from a read —
  // `s.loading = false` in two overlapping calls is intent, not a lost update.
  const c = cell("txn_blind", {
    transaction: true,
    state: { loading: false, hits: 0 },
    methods: {
      async load(s: { loading: boolean; hits: number }) {
        s.loading = true;
        await tick();
        s.loading = false;
      },
      touch(s: { hits: number }) {
        s.hits += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const both = Promise.all([(c as Any).load(), (c as Any).load()]);
    (c as Any).touch(); // an unrelated sync write mid-flight
    await both;
    await h.settle();
    assertEquals((c as Any).loading, false, "both blind writes committed");
    assertEquals((c as Any).hits, 1);
  } finally {
    h.dispose();
  }
});

/** A method that parks mid-flight, with a handle that resolves once it HAS
 *  parked — so a test can land a concurrent write at a known point. Serialized
 *  methods enter a microtask late, which a bare promise gate cannot express. */
function parkPoint() {
  let release!: () => void;
  let arrived!: () => void;
  const parked = new Promise<void>((r) => (arrived = r));
  const gate = new Promise<void>((r) => (release = r));
  return {
    park: () => {
      arrived();
      return gate;
    },
    parked,
    release: () => release(),
  };
}

Deno.test("transaction serialize: a guard on a field a SYNC method writes is not inert", async () => {
  // a field report #1, verbatim: refresh() fetches for a while; a send calls
  // the sync adjust() during that window; refresh's guard reads adjustedAt —
  // pinned to entry, so it can never fire, and refresh commits pre-send numbers
  // over the transfer. The read-set check is what makes the guard honest.
  const p = parkPoint();
  const c = cell("txn_guard", {
    transaction: { serialize: true },
    state: { balance: 100, adjustedAt: 0, confirmed: false },
    methods: {
      async refresh(s: { balance: number; adjustedAt: number }) {
        const entered = s.adjustedAt; // the guard's read
        await p.park();
        if (s.adjustedAt !== entered) return; // never fires: reads are pinned
        s.balance = 100;
        (s as Any).confirmed = true;
      },
      adjust(s: { balance: number; adjustedAt: number }, delta: number) {
        s.balance += delta;
        s.adjustedAt = 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).refresh();
    await p.parked; // refresh has read adjustedAt and is suspended
    await (c as Any).adjust(-40); // the user's transfer lands mid-refresh
    p.release();
    await assertRejects(
      () => slow,
      Error,
      "adjustedAt",
    );
    await h.settle();
    assertEquals((c as Any).balance, 60, "the transfer survives the refresh");
    assertEquals((c as Any).confirmed, false, "and was never stamped stale");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: s.$live reads current state and still commits atomically", async () => {
  const p = parkPoint();
  const c = cell("txn_live", {
    transaction: { serialize: true },
    state: { n: 0, seen: -1 },
    methods: {
      async peek(s: { n: number; seen: number }) {
        await p.park();
        // Deliberately out of the snapshot: reads through $live are current,
        // and are never counted as stale.
        s.seen = (s as Any).$live.n;
      },
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).peek();
    await p.parked;
    await (c as Any).bump();
    p.release();
    await slow; // no conflict — the read was explicitly live
    await h.settle();
    assertEquals((c as Any).seen, 1, "$live saw the committed bump");
  } finally {
    h.dispose();
  }
});

Deno.test('transaction: conflict "warn" commits anyway, loudly', async () => {
  const p = parkPoint();
  const c = cell("txn_warn", {
    transaction: { serialize: true, conflict: "warn" },
    state: { n: 0, out: -1 },
    methods: {
      async rmw(s: { n: number; out: number }) {
        const cur = s.n;
        await p.park();
        s.out = cur; // derived from a read that has since moved
      },
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).rmw();
    await p.parked;
    await (c as Any).bump();
    p.release();
    await slow; // resolves — "warn" reports and commits
    await h.settle();
    assertEquals((c as Any).out, 0, "stale value committed, as asked");
    assertEquals((c as Any).n, 1);
  } finally {
    h.dispose();
  }
});

Deno.test("control: WITHOUT transaction, a read after await sees LIVE state", async () => {
  const c = cell("txn_control", {
    // alpha52: transaction is the DEFAULT — this control pins the opt-OUT
    // (live reads + incremental commits), so it says so explicitly.
    transaction: false,
    state: { a: 0, b: -1 },
    methods: {
      async readback(s: { a: number; b: number }) {
        await wait();
        s.b = s.a;
      },
      bump(s: { a: number }) {
        s.a += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).readback();
    await (c as Any).bump();
    gate!();
    await slow;
    await h.settle();
    assertEquals((c as Any).b, 1, "live read: sees the committed bump (a=1)");
  } finally {
    h.dispose();
  }
});

// The conflict rule as a pure function — the integration tests above prove it
// fires in a running cell; these pin the RULE, including the cases that must
// stay quiet. Cheap to state, and the whole feature rests on them.
Deno.test("conflictPath: identity is the comparator, and only watched paths count", () => {
  const shared = { deep: 1 };
  const origin = { a: 1, b: shared, c: "x" };
  const live = { a: 2, b: shared, c: "x" }; // a moved; b is the SAME object

  const w = createReadWatch();
  // Nothing watched → nothing to invalidate.
  assertEquals(conflictPath(origin, live, w, true), null);

  // A read of an untouched path is fine even under strict reads…
  w.reads.add(watchKey(["b", "deep"]));
  assertEquals(conflictPath(origin, live, w, true), null);

  // …a read of a moved path is a conflict only when reads are validated.
  w.reads.add(watchKey(["a"]));
  assertEquals(conflictPath(origin, live, w, false), null, "not an RMW");
  assertEquals(conflictPath(origin, live, w, true), "a", "serializable");

  // A blind write to a moved path is last-writer-wins, never a conflict.
  const blind = createReadWatch();
  blind.writes.add(watchKey(["a"]));
  assertEquals(conflictPath(origin, live, blind, false), null);

  // The same write, DERIVED from a read of that path, is the lost update.
  const rmw = createReadWatch();
  rmw.reads.add(watchKey(["a"]));
  rmw.writes.add(watchKey(["a"]));
  assertEquals(conflictPath(origin, live, rmw, false), "a");

  // …unless the epoch moved with it. A `$commit()` re-bases `origin` to the
  // state IT produced (executor `rebase`), so our own publish is never a
  // conflict — while a THIRD value still is, which is the half that must not
  // regress. There is no per-path exemption to leak: the epoch is the only
  // bookkeeping, so a published path cannot be exempt for the rest of the
  // method the way a "skip flushed paths" rule made it.
  assertEquals(conflictPath(live, live, rmw, false), null, "re-based epoch");
  assertEquals(
    conflictPath(live, { ...live, a: 7 }, rmw, false),
    "a",
    "somebody else wrote a after our $commit — still a lost update",
  );

  // An identical state object short-circuits: nothing has committed at all.
  assertEquals(conflictPath(origin, origin, rmw, true), null);
});

Deno.test("conflictPath: a read overlapping a write is checked once, by path", () => {
  const origin = { user: { name: "ada", age: 1 } };
  const live = { user: { name: "ada", age: 2 } }; // parent identity changed too
  const w = createReadWatch();
  w.reads.add(watchKey(["user", "name"])); // read a sibling…
  w.writes.add(watchKey(["user", "name"])); // …and write it back
  assertEquals(
    conflictPath(origin, live, w, false),
    null,
    "the sibling we touched did not move — a parent-level identity change " +
      "must not masquerade as a conflict on the leaf",
  );
});

// ── Closed holes (alpha40 review): three tracked-read escapes that each let a
// lost update commit silently, plus the stand-down false positive. Every one
// of these reproduced against fd5c374 before the fix.

Deno.test("transaction: a path published by $commit is NOT exempt afterwards", async () => {
  const p = parkPoint();
  const c = cell("txn_flushed_rmw", {
    transaction: true,
    state: { n: 0 },
    methods: {
      async twice(s: { n: number }) {
        s.n = s.n + 1; // RMW #1 (0 → 1)
        (s as Any).$commit(); // publishes n=1
        await p.park(); // a sync bump commits n=100 here
        s.n = s.n + 1; // RMW #2 over the pinned 1 — must conflict, not win
      },
      bump(s: { n: number }) {
        s.n = 100;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).twice();
    await p.parked;
    await (c as Any).bump();
    p.release();
    await assertRejects(() => slow, Error, "changed by another action");
    await h.settle();
    assertEquals((c as Any).n, 100, "bump's write survives; ours aborted");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction serialize: a .find() guard is a validated read", async () => {
  const p = parkPoint();
  const c = cell("txn_find_guard", {
    transaction: { serialize: true },
    state: { users: [] as { name: string }[] },
    methods: {
      async addUnique(s: { users: { name: string }[] }, name: string) {
        const exists = s.users.find((u) => u.name === name);
        await p.park(); // concurrent insert of the same name
        if (!exists) s.users.push({ name });
      },
      addSync(s: { users: { name: string }[] }, name: string) {
        s.users.push({ name });
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).addUnique("ada");
    await p.parked;
    await (c as Any).addSync("ada");
    p.release();
    await assertRejects(() => slow, Error, "changed by another action");
    await h.settle();
    assertEquals(
      ((c as Any).users as unknown[]).length,
      1,
      "no phantom duplicate under serializable",
    );
  } finally {
    h.dispose();
  }
});

Deno.test("transaction serialize: a root enumeration is a validated read", async () => {
  const p = parkPoint();
  const c = cell("txn_root_enum", {
    transaction: { serialize: true },
    state: { total: 0, a: 1 } as Record<string, unknown>,
    methods: {
      async recount(s: Record<string, unknown>) {
        const keys = Object.keys(s); // reads the root shape
        await p.park(); // concurrent sync method adds a key
        s.total = keys.length;
      },
      addKey(s: Record<string, unknown>) {
        s.b = 2;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).recount();
    await p.parked;
    await (c as Any).addKey();
    p.release();
    await assertRejects(() => slow, Error, "changed by another action");
    await h.settle();
    assertEquals((c as Any).total, 0, "stale count did not commit");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction serialize: the documented $live stand-down pattern stands down cleanly", async () => {
  const p = parkPoint();
  const c = cell("txn_standdown", {
    transaction: { serialize: true },
    state: { adjustedAt: 0, balance: 100 },
    methods: {
      async refresh(s: Any) {
        const entered = s.adjustedAt; // pinned, watched read
        await p.park();
        if (s.$live.adjustedAt !== entered) return; // stand down — writes nothing
        s.balance = 999;
      },
      adjust(s: Any) {
        s.adjustedAt = 1;
        s.balance -= 40;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).refresh();
    await p.parked;
    await (c as Any).adjust();
    p.release();
    await slow; // must NOT reject: it published nothing
    await h.settle();
    assertEquals((c as Any).balance, 60, "adjust's write intact");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: s.$live.$commit() publishes (not a silent no-op)", async () => {
  const p = parkPoint();
  const c = cell("txn_live_commit", {
    transaction: true,
    state: { a: 0 },
    methods: {
      async work(s: Any) {
        s.a = 1;
        s.$live.$commit(); // same commit closure as s.$commit()
        await p.park();
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const slow = (c as Any).work();
    await p.parked;
    await h.settle();
    assertEquals((c as Any).a, 1, "published mid-method via $live.$commit()");
    p.release();
    await slow;
  } finally {
    h.dispose();
  }
});
