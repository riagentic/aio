// alpha52 config breaks (todo.md "the effect channel" package):
//   • reserved state keys — `$`-prefix and RESERVED_KEYS throw at cell();
//     dead "A"/"E" are no longer reserved
//   • listensTo: array form deprecated (works + one-time hint); object form
//     accepts ARRAYS of sources
//   • selector deps form takes a TUPLE (`fn: (s, [deps], ...args)`) so
//     parameterized + deps compose; the old spread form works with a hint
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { log } from "../src/diagnostics/logger.ts";
import { RESERVED_KEYS } from "../src/state/cell-types.ts";
import { _resetListensToHints } from "../src/state/cell-methods-factory.ts";
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

Deno.test("listensTo ARRAY form: still works, hints ONCE per cell", async () => {
  _resetListensToHints();
  const warns = await captureWarnings(async () => {
    cell("lt_array", {
      state: { n: 0 },
      listensTo: ["ltsrc:bump"],
      methods: {},
    });
    await Promise.resolve();
  });
  const hints = warns.filter((w) =>
    w.includes("listensTo array form is deprecated")
  );
  assertEquals(hints.length, 1, "one hint, at definition");
  assertStringIncludes(hints[0]!, "lt_array");
});

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

Deno.test("selector deps OLD spread form: still works, hints once, names the tuple", async () => {
  _resetSelectorHints();
  // The selector hint uses console.warn (browser-graph module — no logger).
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  await (async () => {
    const other = cell("sel_other", {
      state: { factor: 3 },
      methods: {},
    });
    const legacy = cell("sel_legacy", {
      state: { n: 7 },
      methods: {},
      selectors: {
        // The pre-alpha52 spelling: dep slices SPREAD after s.
        scaled: {
          deps: ["sel_other"],
          fn: (s: Any, otherSlice: Any) => s.n * (otherSlice?.factor ?? 1),
        },
      },
    });
    const h = await bootCells([other, legacy]);
    try {
      assertEquals(
        (legacy as Any).scaled(),
        21,
        "old spread form still computes",
      );
    } finally {
      h.dispose();
    }
  })().finally(() => {
    console.warn = origWarn;
  });
  const hints = warns.filter((w) => w.includes("deps now arrive as a tuple"));
  assertEquals(hints.length, 1, "one hint per selector");
  assertStringIncludes(hints[0]!, "scaled");
  assertStringIncludes(hints[0]!, "aiol --safe-fix");
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
