// An aborted transaction discards its write-set — and, now, its effects.
//
// docs/state/transactional-methods.md §4: "If the method throws or is
// cancelled, W is discarded — no partial commit." `s.$do(...)` in a
// `transaction: true` method dispatched its effect the moment it was called,
// so the abort discarded the writes and kept the side effects. Measured before
// the fix, one receipt per withdrawal that did NOT happen:
//
//   TX_CONFLICT  → balance unchanged, receipts 1
//   throw        → balance unchanged, receipts 2
//   cancel(self) → only the winner's write landed, receipts +2 (one per call)
//
// The cancel path's own comment said "No effects either: scheduling follow-up
// work is the one thing a cancelled call must not do". Effects are held with
// the write-set now and published with it — at return, or at `s.$commit()`.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { schedule } from "../src/state/schedule.ts";
import { self } from "../src/state/self.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function wallet(name: string, tx: unknown = true) {
  return cell(name, {
    state: { balance: 100, receipts: 0, progress: 0 },
    transaction: tx,
    cancelOn: { withdrawSelf: "self" },
    methods: {
      adjust(s: Any, d: number) {
        s.balance += d;
      },
      sendReceipt(s: Any) {
        s.receipts += 1;
      },
      async withdraw(s: Any, amt: number) {
        const b = s.balance;
        await tick(20);
        s.balance = b - amt;
        s.$do(schedule.after(`${name}:r1`, 0, self("sendReceipt")));
      },
      async withdrawThrow(s: Any, amt: number) {
        s.balance -= amt;
        s.$do(schedule.after(`${name}:r2`, 0, self("sendReceipt")));
        await tick(5);
        throw new Error("bank said no");
      },
      async withdrawSelf(s: Any, amt: number) {
        s.balance -= amt;
        s.$do(schedule.after(`${name}:r3:${amt}`, 0, self("sendReceipt")));
        await tick(20);
        if (s.$signal.aborted) return;
      },
      async staged(s: Any) {
        s.progress = 1;
        s.$do(schedule.after(`${name}:r4`, 0, self("sendReceipt")));
        s.$commit();
        await tick(5);
        throw new Error("second half failed");
      },
    },
  } as Any) as Any;
}

Deno.test("transaction: a TX_CONFLICT abort sends none of its effects", async () => {
  const w = wallet("txfx_conflict");
  const h = await bootCells([w]);
  try {
    const p = w.withdraw(30);
    await tick(5);
    w.adjust(-50); // a concurrent sync write — withdraw's read is now stale
    const code = await p.then(() => "ok", (e: Any) => e.code);
    await h.advance(10);
    await h.settle();
    assertEquals(code, "TX_CONFLICT");
    assertEquals(w.balance, 50, "the conflicting write-set was discarded");
    assertEquals(w.receipts, 0, "…and so was the receipt it scheduled");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: a throw sends none of its effects", async () => {
  const w = wallet("txfx_throw");
  const h = await bootCells([w]);
  try {
    const msg = await w.withdrawThrow(10).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await h.advance(10);
    await h.settle();
    assertEquals(msg, "bank said no");
    assertEquals(w.balance, 100);
    assertEquals(w.receipts, 0);
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: a superseded (cancelled) call sends none of its effects", async () => {
  const w = wallet("txfx_cancel");
  const h = await bootCells([w]);
  try {
    const a = w.withdrawSelf(1);
    await tick(2);
    const b = w.withdrawSelf(2);
    await a;
    await b;
    await h.advance(10);
    await h.settle();
    assertEquals(w.balance, 98, "only the winner's write-set committed");
    assertEquals(w.receipts, 1, "only the winner's receipt went out");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: effects publish with the write-set — at return, and at $commit()", async () => {
  const w = wallet("txfx_commit");
  const h = await bootCells([w]);
  try {
    await w.withdraw(10);
    await h.advance(10);
    await h.settle();
    assertEquals([w.balance, w.receipts], [90, 1], "a committed call's effect");

    await w.staged().catch(() => {});
    await h.advance(10);
    await h.settle();
    assertEquals(w.progress, 1, "the $commit()ed half is committed");
    assertEquals(
      w.receipts,
      2,
      "…and the effect scheduled before that $commit() went out with it",
    );
  } finally {
    h.dispose();
  }
});

Deno.test("non-transactional: $do still goes out immediately, and a throw keeps it (documented)", async () => {
  const w = wallet("txfx_plain", false);
  const h = await bootCells([w]);
  try {
    await w.withdrawThrow(10).catch(() => {});
    await h.advance(10);
    await h.settle();
    // Unchanged on purpose: an async method without `transaction` commits
    // incrementally, so a throw keeps what already happened.
    assertEquals([w.balance, w.receipts], [90, 1]);
  } finally {
    h.dispose();
  }
});
