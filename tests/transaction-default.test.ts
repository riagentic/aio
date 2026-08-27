// alpha57 — `transaction` is OPT-IN for async methods (it was the default from
// alpha52 to alpha56; see .katana/_aio.md for why that came back). An
// UNDECLARED cell gets live reads + incremental commits, exactly as it was
// written; `transaction: true` buys snapshot reads + atomic commit + conflict
// detection. The spinner idiom under the opt-in is `s.busy = true; s.$commit()`;
// deliberate live reads are `s.$live` (`until(() => s.$live.flag)`).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { until } from "../src/state/async-helpers.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ── The default: undeclared === pre-alpha52 semantics ──────────────────

Deno.test("DEFAULT (no transaction key): writes commit incrementally and reads are LIVE", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_default", {
    // No `transaction` key — the default is the thing under test. This is the
    // shape every app written before alpha52 has, and it must behave as it did.
    state: { a: 0, b: -1 },
    methods: {
      async readback(s: { a: number; b: number }) {
        s.a = 5; // commits incrementally (next microtask)
        await gate;
        s.b = s.a; // live read — sees the foreign bump below
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

Deno.test("DEFAULT: a mid-method write reaches clients before the method returns (the spinner)", async () => {
  // The regression the alpha52 flip caused in the field: `s.loading = true`
  // announcing a fetch never published, because the write-set buffered to the
  // end of the method that was doing the fetching.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_default_spinner", {
    state: { busy: false, result: "" },
    methods: {
      async work(s: { busy: boolean; result: string }) {
        s.busy = true; // no $commit() needed off `transaction`
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

Deno.test("DEFAULT: a stand-down guard re-read after an await is NOT inert", async () => {
  // searchWorkspace's shape: write the query, await, then compare against the
  // CURRENT query to drop a stale response. Under pinned reads the comparison
  // reads the method's own write and can never fire — silently keeping stale
  // results. This asserts the guard actually fires.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_default_guard", {
    state: { query: "", results: "" },
    methods: {
      async search(s: { query: string; results: string }, q: string) {
        s.query = q;
        await gate;
        if (s.query !== q) return; // a newer keystroke landed — stand down
        s.results = `hits:${q}`;
      },
      setQuery(s: { query: string }, q: string) {
        s.query = q;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).search("old");
    await h.settle();
    await (c as Any).setQuery("new"); // a newer keystroke while suspended
    release!();
    await p;
    await h.settle();
    assertEquals((c as Any).results, "", "the stale response stood down");
  } finally {
    h.dispose();
  }
});

Deno.test("DEFAULT: an undeclared async cell boots SILENT (no hint, nothing to migrate)", async () => {
  const { log } = await import("../src/diagnostics/logger.ts");
  const warns: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).warn;
  // deno-lint-ignore no-explicit-any
  (log as any).warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    cell("txd_silent", {
      state: { n: 0 },
      methods: {
        async go(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    });
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).warn = orig;
  }
  assertEquals(
    warns.filter((w) => w.includes("transaction")).length,
    0,
    "no transaction hint — an undeclared cell is correct as written",
  );
});

// ── The opt-in: transaction: true still buys everything it did ─────────

Deno.test("transaction: true — writes are INVISIBLE until the method returns (atomic)", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_atomic", {
    transaction: true,
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

Deno.test("transaction: true — the spinner idiom: s.busy = true; s.$commit() publishes mid-method", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_spinner", {
    transaction: true,
    state: { busy: false, result: "" },
    methods: {
      async work(
        s: { busy: boolean; result: string } & Partial<MethodDraftMeta>,
      ) {
        s.busy = true;
        s.$commit!(); // the transactional spinner idiom
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

Deno.test("transaction: true — until(() => s.$live.flag) sees foreign commits (pinned s does not)", async () => {
  const c = cell("txd_live", {
    transaction: true,
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

Deno.test("transaction: false — the explicit spelling matches the default exactly", async () => {
  // Apps that took `aiol --safe-fix` carry an explicit `transaction: false`.
  // It must stay a synonym for the default, not a third behavior.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("txd_optout", {
    transaction: false,
    state: { a: 0, b: -1 },
    methods: {
      async readback(s: { a: number; b: number }) {
        s.a = 5;
        await gate;
        s.b = s.a;
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
    await (c as Any).bump();
    release!();
    await p;
    await h.settle();
    assertEquals((c as Any).b, 6, "live read saw the foreign bump");
  } finally {
    h.dispose();
  }
});

// ── `{ serialize: false }` reads like "off" and means "ON" ───────────────
//
// The OBJECT is the opt-in, whatever is inside it, and `serialize: false` is
// already the default for an enabled transaction. So an author writing
// `transaction: { serialize: false }` to mean "no transactions" gets them —
// pinned reads that make a stand-down guard inert, buffered writes that stop a
// spinner ever reaching the client — with no error and no failing test.
Deno.test("transaction: { serialize: false } is REFUSED, naming both real spellings", () => {
  let err: Error | null = null;
  try {
    cell("txd_serialize_false", {
      state: { a: 0 },
      methods: { async noop(_s: { a: number }) {} },
      transaction: { serialize: false },
      // deno-lint-ignore no-explicit-any
    } as any);
  } catch (e) {
    err = e as Error;
  }
  if (!err) throw new Error("expected cell() to refuse { serialize: false }");
  const m = err.message;
  for (
    const part of [
      "turns transactions ON",
      "transaction: false",
      "transaction: true",
      "txd_serialize_false",
    ]
  ) {
    if (!m.includes(part)) {
      throw new Error(`refusal does not name ${part}: ${m}`);
    }
  }
});

Deno.test("transaction: the spellings that MEAN something are untouched", () => {
  // deno-lint-ignore no-explicit-any
  const C = cell as any;
  // The assertion is acceptance: each of these four spellings means something
  // real, and a refusal written to catch `{ serialize: false }` must not take
  // any of them with it. Each returned def is checked below.
  const off = C("txd_ok_off", {
    state: { a: 0 },
    methods: {},
    transaction: false,
  });
  const on = C("txd_ok_on", {
    state: { a: 0 },
    methods: {},
    transaction: true,
  });
  const ser = C("txd_ok_ser", {
    state: { a: 0 },
    methods: {},
    transaction: { serialize: true },
  });
  const conflict = C("txd_ok_conflict", {
    state: { a: 0 },
    methods: {},
    transaction: { conflict: "warn" },
  });
  for (
    const [name, def] of [["off", off], ["on", on], ["ser", ser], [
      "conflict",
      conflict,
    ]] as const
  ) {
    assert(def?.__aio?.id, `${name} was refused, but it is a real spelling`);
  }
});
