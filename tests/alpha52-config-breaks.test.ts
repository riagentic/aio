// alpha52 config breaks (todo.md "the effect channel" package):
//   • reserved state keys — `$`-prefix and RESERVED_KEYS throw at cell();
//     dead "A"/"E" are no longer reserved
//   • listensTo: array form deprecated (works + one-time hint); object form
//     accepts ARRAYS of sources
//   • selector deps form takes a TUPLE (`fn: (s, [deps], ...args)`) so
//     parameterized + deps compose; the old spread form was RETIRED in
//     alpha76 (src/state/removals.ts)
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { log } from "../src/diagnostics/logger.ts";
import { RESERVED_KEYS } from "../src/state/cell-types.ts";
import { _resetSelectorHints } from "../src/state/cell-helpers.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).warn;
  // deno-lint-ignore no-explicit-any
  (log as any).warn = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).warn = orig;
  }
  return out;
}

// ── Reserved state keys ────────────────────────────────────────────────

Deno.test("state key starting with $ throws at cell(), naming the meta-namespace", () => {
  const e = assertThrows(() =>
    cell("rk_dollar", {
      state: { $busy: false },
      methods: {},
    })
  );
  assertStringIncludes(String(e), "$busy");
  assertStringIncludes(String(e), "$signal");
  assertStringIncludes(String(e), "$do");
});

Deno.test("reserved state keys (state/fx/__aio) throw at cell()", () => {
  for (const key of ["state", "fx", "__aio"]) {
    const e = assertThrows(() =>
      cell(`rk_${key.replace(/_/g, "u")}`, {
        state: { [key]: 1 },
        methods: {},
      })
    );
    assertStringIncludes(String(e), key);
  }
});

Deno.test("dead 'A'/'E' are no longer reserved — a method named A is legal now", () => {
  assert(!RESERVED_KEYS.has("A") && !RESERVED_KEYS.has("E"));
  const c = cell("rk_ae", {
    state: { A: 1, E: 2 },
    methods: {
      bump(s: { A: number }) {
        s.A++;
      },
    },
  });
  assert(c, "cell with A/E state keys defines fine");
});

// ── listensTo forms ────────────────────────────────────────────────────

// The array form is retired in alpha70 — its refusal is pinned in
// alpha70-retirements.test.ts ("listensTo array form — dev refuses; prod logs").

Deno.test("listensTo OBJECT form accepts an ARRAY of sources — one handler, many triggers", async () => {
  const src = cell("lt_src", {
    state: { n: 0 },
    methods: {
      ping(s: { n: number }) {
        s.n++;
      },
      pong(s: { n: number }) {
        s.n++;
      },
    },
  });
  const sink = cell("lt_sink", {
    state: { seen: 0 },
    listensTo: { onAny: [src.ping, src.pong] },
    methods: {
      onAny(s: { seen: number }) {
        s.seen++;
      },
    },
  });
  const h = await bootCells([src, sink]);
  try {
    await (src as Any).ping();
    await (src as Any).pong();
    await h.settle();
    assertEquals((sink as Any).seen, 2, "both sources triggered the handler");
  } finally {
    h.dispose();
  }
});

// ── Selector deps tuple form ───────────────────────────────────────────

Deno.test("selector deps NEW tuple form: (s, [deps], ...args) — parameterized + deps compose", async () => {
  const prices = cell("sel_prices", {
    state: { byId: { a: 10, b: 20 } as Record<string, number> },
    methods: {
      set(s: { byId: Record<string, number> }, id: string, v: number) {
        s.byId[id] = v;
      },
    },
  });
  const cart = cell("sel_cart", {
    state: { qty: { a: 2, b: 1 } as Record<string, number> },
    methods: {},
    selectors: {
      // deno-lint-ignore no-explicit-any
      cost: {
        deps: ["sel_prices"],
        // Parameterized AND deps — the composition the tuple form exists for.
        fn: (s: Any, [prices]: Any[], id: string) =>
          (s.qty[id] ?? 0) * (prices?.byId?.[id] ?? 0),
      },
    },
  });
  const h = await bootCells([prices, cart]);
  try {
    assertEquals((cart as Any).cost("a"), 20);
    await (prices as Any).set("a", 100);
    assertEquals((cart as Any).cost("a"), 200, "recomputes off the dep cell");
  } finally {
    h.dispose();
  }
});

Deno.test("selector deps OLD spread form: REFUSED by name (alpha76)", () => {
  _resetSelectorHints();
  const other = cell("sel_other", { state: { factor: 3 }, methods: {} });
  const e = assertThrows(
    () =>
      cell("sel_legacy", {
        state: { n: 7 },
        methods: {},
        selectors: {
          // The pre-alpha52 spelling: dep slices SPREAD after s.
          scaled: {
            deps: ["sel_other"],
            fn: (s: Any, otherSlice: Any) => s.n * (otherSlice?.factor ?? 1),
          },
        },
      }),
    Error,
  );
  assertStringIncludes(String(e), "sel_legacy.scaled");
  assertStringIncludes(String(e), "fn: (s, [dep1, dep2], ...args)");
  assertStringIncludes(String(e), "removed in alpha76");
  assertStringIncludes(String(e), "am pin v1.0.0-alpha75");
  assertExists(other);
});

Deno.test("selector deps: zero-dep tuple form gets an empty tuple", async () => {
  const c = cell("sel_zerodep", {
    state: { n: 4 },
    methods: {},
    selectors: {
      // deno-lint-ignore no-explicit-any
      doubled: { deps: [], fn: (s: Any, deps: Any[]) => s.n * 2 + deps.length },
    },
  });
  const h = await bootCells([c]);
  try {
    assertEquals((c as Any).doubled(), 8);
  } finally {
    h.dispose();
  }
});
