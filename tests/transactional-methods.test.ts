// risoto #2 — transactional cell methods (opt-in `transaction: true`). Reads see
// a stable snapshot captured at entry; writes commit atomically at return; a
// throw discards. Spec: docs/state/transactional-methods.md §7.
import { assertEquals, assertRejects } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

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

Deno.test("transaction WITHOUT serialize: concurrent RMW loses an update (documented)", async () => {
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
    await Promise.all([(c as Any).incRMW(), (c as Any).incRMW()]);
    await h.settle();
    // Both read the same snapshot (0) → both write 1: the classic lost update
    // the spec documents, with `serialize: true` as the fix (test above).
    assertEquals((c as Any).n, 1, "lost update without serialize");
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
