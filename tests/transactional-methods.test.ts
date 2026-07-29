// risoto #2 — transactional cell methods (opt-in `transaction: true`). Reads see
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
  const c = cell("txn_commit", {
    transaction: true,
    state: { step: 0 },
    methods: {
      async run(s: { step: number }) {
        s.step = 1;
        (s as unknown as { $commit: () => void }).$commit(); // publish mid-method
        await Promise.resolve();
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
    // The mid-method $commit is visible before the method returns.
    assertEquals((c as Any).step, 1, "$commit published step=1 mid-flight");
    await p;
    await h.settle();
    assertEquals((c as Any).step, 11, "post-commit read saw 1, then +10");
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
  // risoto 2026-07-28 #1, verbatim: refresh() fetches for a while; a send calls
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
    // no transaction — today's behavior
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

  // …unless this method already published it — then it is our own change.
  rmw.flushed.add(watchKey(["a"]));
  assertEquals(conflictPath(origin, live, rmw, false), null);

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
