// alpha52 — `transaction: true` is the DEFAULT for async methods. An
// undeclared cell gets snapshot reads + atomic commit + conflict detection;
// `transaction: false` opts back into live reads / incremental commits. The
// spinner idiom under the default is `s.busy = true; s.$commit()`; deliberate
// live reads are `s.$live` (`until(() => s.$live.flag)`).
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { until } from "../src/state/async-helpers.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("default: an async method's writes are INVISIBLE until it returns (atomic)", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_atomic", {
    // No `transaction` key — the default is the thing under test.
    state: { a: 0, b: 0 },
    methods: {
      async both(s: { a: number; b: number }) {
        s.a = 1;
        await gate;
        s.b = 2;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).both();
    await h.settle();
    assertEquals(
      [(c as Any).a, (c as Any).b],
      [0, 0],
      "nothing committed mid-flight",
    );
    release!();
    await p;
    await h.settle();
    assertEquals(
      [(c as Any).a, (c as Any).b],
      [1, 2],
      "one atomic commit at return",
    );
  } finally {
    h.dispose();
  }
});

Deno.test("default: the spinner idiom — s.busy = true; s.$commit() publishes mid-method", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_spinner", {
    state: { busy: false, result: "" },
    methods: {
      async work(
        s: { busy: boolean; result: string } & Partial<MethodDraftMeta>,
      ) {
        s.busy = true;
        s.$commit!(); // the alpha52 spinner idiom
        await gate;
        s.result = "done";
        s.busy = false;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).work();
    await h.settle();
    assertEquals((c as Any).busy, true, "the spinner is visible mid-flight");
    release!();
    await p;
    await h.settle();
    assertEquals([(c as Any).busy, (c as Any).result], [false, "done"]);
  } finally {
    h.dispose();
  }
});

Deno.test("default: until(() => s.$live.flag) sees foreign commits (pinned s does not)", async () => {
  const c = cell("txd_live", {
    state: { flag: false, out: "" },
    methods: {
      raise(s: { flag: boolean }) {
        s.flag = true;
      },
      async wait(s: { flag: boolean; out: string } & Partial<MethodDraftMeta>) {
        await until(() => (s.$live as Any).flag, {
          timeoutMs: 2000,
          intervalMs: 5,
        });
        s.out = "flagged";
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).wait();
    await h.settle();
    await (c as Any).raise();
    await p;
    await h.settle();
    assertEquals((c as Any).out, "flagged", "s.$live saw the foreign commit");
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: false — the opt-out restores live reads + incremental commits", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_optout", {
    transaction: false,
    state: { a: 0, b: -1 },
    methods: {
      async readback(s: { a: number; b: number }) {
        s.a = 5; // commits incrementally (next microtask)
        await gate;
        s.b = s.a; // live read
      },
      bump(s: { a: number }) {
        s.a += 1;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).readback();
    await h.settle();
    assertEquals((c as Any).a, 5, "pre-await write committed incrementally");
    await (c as Any).bump(); // a → 6 while readback is suspended
    release!();
    await p;
    await h.settle();
    assertEquals((c as Any).b, 6, "live read saw the foreign bump");
  } finally {
    h.dispose();
  }
});

Deno.test("alpha52 hint: an async cell with NO transaction key hints ONCE at cell(); deciders and adopters stay silent", async () => {
  const { _resetTransactionHints } = await import(
    "../src/state/cell-methods-factory.ts"
  );
  const { log } = await import("../src/diagnostics/logger.ts");
  _resetTransactionHints();
  const warns: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).warn;
  // deno-lint-ignore no-explicit-any
  (log as any).warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    // Undeclared async cell → one hint, exactly once (second def same name).
    cell("txd_hint", {
      state: { n: 0 },
      methods: {
        async go(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    });
    cell("txd_hint", {
      state: { n: 0 },
      methods: {
        async go(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    });
    // Explicit opt-out → silent.
    cell("txd_hint_optout", {
      transaction: false,
      state: { n: 0 },
      methods: {
        async go(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    });
    // Explicit opt-in → silent.
    cell("txd_hint_optin", {
      transaction: true,
      state: { n: 0 },
      methods: {
        async go(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    });
    // Adopted the new world ($commit in a body) → silent.
    cell("txd_hint_adopted", {
      state: { n: 0 },
      methods: {
        async go(s: { n: number } & Partial<MethodDraftMeta>) {
          s.n++;
          s.$commit!();
          await Promise.resolve();
        },
      },
    });
    // Sync-only cell → silent (nothing flips for it).
    cell("txd_hint_sync", {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n++;
        },
      },
    });
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).warn = orig;
  }
  const hints = warns.filter((w) => w.includes("no `transaction` key"));
  assertEquals(hints.length, 1, "exactly one hint, for the undecided cell");
  const h = hints[0]!;
  assertEquals(h.includes("txd_hint"), true, "names the cell");
  assertEquals(h.includes("transaction: false"), true, "names the opt-out");
  assertEquals(h.includes("$commit"), true, "names the spinner idiom");
});
