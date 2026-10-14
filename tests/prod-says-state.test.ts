// The state layer's half of "said in dev, silent in a package".
//
// `src/state` is isomorphic, so these run on the SERVER of a packaged app as
// much as in its page — the one place nobody is watching a console. Each was
// dev-only (or dev threw while production degraded without a word):
//
//   · two modules defining a cell under one name — the earlier one is GONE;
//   · `cell.state` / `cell.selectors` / `cell.__aio.<unknown>` — dev throws,
//     production answered `undefined` and the TypeError came one property on;
//   · a refused action whose `listensTo` listener still ran;
//   · a Map/Set/… in state, which a compiled build never looked for.
//
// Production says each once per key through the logger (`log.warn`, or
// `log.error` for the lost cell), and `_resetAioRuntime` forgets it.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import {
  _wireLossSeen,
  findWireLoss,
  warnWireLoss,
} from "../src/state/wire-fidelity.ts";
import { MAX_NODES } from "../src/protocol/wire-value.ts";
import { logProblems } from "../src/build/smoke.ts";
import { _wrongPrefix } from "../src/state/dev-flag.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** Run `fn` as a production build would, returning what the logger was told. */
function inProd<T>(fn: () => T): { lines: string[]; result: T } {
  const lines: string[] = [];
  const prev = getLogger();
  const g = globalThis as Record<string, unknown>;
  const had = g.__aioDev;
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) =>
        void lines.push(`${lvl}: ${msg}`),
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  g.__aioDev = false;
  try {
    return { lines, result: fn() };
  } finally {
    g.__aioDev = had;
    setLogger(prev);
  }
}
const dev = <T>(fn: () => T): T => {
  const g = globalThis as Record<string, unknown>;
  const had = g.__aioDev;
  g.__aioDev = true;
  try {
    return fn();
  } finally {
    g.__aioDev = had;
  }
};

Deno.test("prod says (state): a second cell under the same name — once per name, a WARN as in dev", () => {
  _resetAioRuntime();
  const define = (n: number) =>
    cell("prodsays-dup", { state: { n }, methods: { inc: (s) => void s.n++ } });
  define(0);
  const { lines } = inProd(() => {
    define(1);
    define(2);
  });
  const said = lines.filter((l) => l.includes("duplicate cell name"));
  assertEquals(said.length, 1, lines.join("\n"));
  // Never the stricter of the two: dev says this at warn.
  assert(said[0]!.startsWith("warn: "), said[0]);
  assert(said[0]!.includes("'prodsays-dup'"), said[0]);
  _resetAioRuntime();
  assertEquals(
    inProd(() => define(3)).lines.filter((l) => l.includes("duplicate cell"))
      .length,
    1,
    "after the runtime reset it is said again",
  );
});

Deno.test("prod says (state): the duplicate-cell line does not fail a build's smoke run", async () => {
  // The REAL logger's line, from a process that is not a test harness — an
  // ERROR at boot is what `aio build` reads as "the artifact is broken", and
  // an app with two same-named cells built and ran on 1.0.19.
  const root = new URL("..", import.meta.url).href;
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { cell } from "${root}src/state/cell-create.ts";
       import "${root}src/diagnostics/logger.ts";
       cell("settings", { state: { a: 1 }, methods: {} });
       cell("settings", { state: { b: 2 }, methods: {} });`,
    ],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assert(out.success, text);
  assert(text.includes("duplicate cell name 'settings'"), text);
  assertEquals(logProblems(text), []);
});

Deno.test("prod says (state): cell.state / cell.selectors / __aio.<unknown> answer undefined AND say so once", () => {
  _resetAioRuntime();
  const c = cell("prodsays-reflex", {
    state: { n: 0 },
    methods: { inc: (s) => void s.n++ },
    // deno-lint-ignore no-explicit-any
  }) as any;
  // Dev (and every harness) throws — the stricter half, unchanged.
  dev(() => {
    assertThrows(() => c.state, Error, "does not exist");
    assertThrows(() => c.__aio.nope, Error, "__aio.nope does not exist");
  });
  const { lines, result } = inProd(() => [
    c.state,
    c.state,
    c.selectors,
    c.__aio.nope,
    c.__aio.nope,
  ]);
  assertEquals(result, [undefined, undefined, undefined, undefined, undefined]);
  assertEquals(
    lines.map((l) => l.replace(/ does not exist.*/, "")),
    [
      "warn: [cell:prodsays-reflex] prodsays-reflex.state",
      "warn: [cell:prodsays-reflex] prodsays-reflex.selectors",
      "warn: [cell:prodsays-reflex] __aio.nope",
    ],
  );
  assert(lines.every((l) => l.endsWith("(undefined was returned)")));
  // A read already said costs one lookup: the message (two `Object.keys` and
  // a template) is not built again — this getter can sit in a render loop.
  const keys = Object.keys;
  let calls = 0;
  Object.keys = ((o: object) => (calls++, keys(o))) as typeof Object.keys;
  try {
    inProd(() => [c.state, c.selectors, c.state]);
  } finally {
    Object.keys = keys;
  }
  assertEquals(calls, 0, "a repeated read built its message again");
});

Deno.test("prod says (state): a refused action whose listener still ran — once per action and listener", () => {
  _resetAioRuntime();
  const notes = cell("prodsays-notes", {
    state: { items: [] as string[] },
    methods: {
      add(s, t: string) {
        s.items.push(t);
      },
    },
    validate: (s) => s.items.includes("bad") ? "no bad" : true as const,
  });
  const tally = cell("prodsays-tally", {
    state: { n: 0 },
    methods: {
      onAdd(s) {
        s.n += 1;
      },
    },
    listensTo: { onAdd: "prodsays-notes:add" },
  });
  const composed = composeCells([notes, tally]);
  const { lines, result } = inProd(() => {
    let state = composed.initialState;
    for (let i = 0; i < 2; i++) {
      state = composed.reduce(
        state as never,
        { type: "prodsays-notes:add", payload: { args: ["bad"] } } as never,
      ).state;
    }
    return state as unknown as { "prodsays-tally": { n: number } };
  });
  assertEquals(result["prodsays-tally"].n, 2, "the listener ran, as in 1.0.9");
  const said = lines.filter((l) => l.includes("still ran"));
  assertEquals(said.length, 1, lines.join("\n"));
  assert(said[0]!.startsWith("warn: "), said[0]);
});

Deno.test("prod says (state): a compiled build names a Map in state — its first commits only, once per path", () => {
  _resetAioRuntime();
  _wireLossSeen.clear();
  const patch = (
    path: string,
  ) => [{ path: [path], value: new Map([["k", 1]]) }];
  const { lines } = inProd(() => {
    warnWireLoss("prodsays-wire", patch("a"), false);
    warnWireLoss("prodsays-wire", patch("a"), false);
    // The budget: commit 17 is not walked, whatever it holds.
    for (let i = 0; i < 14; i++) warnWireLoss("prodsays-wire", [], false);
    warnWireLoss("prodsays-wire", patch("late"), false);
  });
  assertEquals(lines.length, 1, lines.join("\n"));
  assert(lines[0]!.includes("state.a holds a Map"), lines[0]);
  _resetAioRuntime();
  assertEquals(
    inProd(() => warnWireLoss("prodsays-wire", patch("late"), false)).lines
      .length,
    1,
    "the budget is per test: the runtime reset hands it back",
  );
  _wireLossSeen.clear();
});

Deno.test("prod says (state): the wire check never fails the commit it is looking at", () => {
  _resetAioRuntime();
  _wireLossSeen.clear();
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  // ~6000 deep: `JSON.stringify` carries it; a recursive walk does not.
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 6000; i++) cur = cur.n = {};
  cur.m = new Map();
  const hostile: [string, unknown][] = [
    ["getter", {
      get x(): number {
        throw new Error("boom");
      },
    }],
    ["revoked", proxy],
    ["deep", deep],
  ];
  for (const fromSource of [false, true]) {
    for (const [name, value] of hostile) {
      const { lines } = inProd(() => {
        const cellName = `prodsays-${name}-${fromSource}`;
        warnWireLoss(cellName, [{ path: ["k"], value }], fromSource);
        warnWireLoss(cellName, [{ path: ["k"], value }], fromSource);
      });
      // Said once, at warn — and what it says is true of the value.
      assertEquals(lines.length, 1, `${name}: ${lines.join("\n")}`);
      assert(lines[0]!.startsWith("warn: "), lines[0]);
      assert(
        name === "deep"
          ? lines[0]!.includes("holds a Map")
          : lines[0]!.includes("could not read"),
        lines[0],
      );
    }
  }
  _wireLossSeen.clear();
});

Deno.test("prod says (state): a compiled build looks at a bounded number of values per commit", () => {
  _resetAioRuntime();
  _wireLossSeen.clear();
  // Counted in VALUES READ, not in time: 100 000 rows with the one Map last.
  let reads = 0;
  const rows: unknown[] = Array.from({ length: 100_000 }, (_, i) => i);
  rows.push(new Map());
  const counted = new Proxy(rows, {
    get: (
      t,
      k,
      r,
    ) => (typeof k === "string" && k !== "length" && reads++,
      Reflect.get(t, k, r)),
  });
  const patches = [{ path: ["rows"], value: counted }, {
    path: ["more"],
    value: counted,
  }];
  const compiled = inProd(() => warnWireLoss("prodsays-big", patches, false));
  assertEquals(compiled.lines, [], "the walk went past its budget");
  assert(reads <= MAX_NODES, `${reads} values read, budget ${MAX_NODES}`);
  // Dev and a run from source look at all of it, as before.
  const source = inProd(() => warnWireLoss("prodsays-big", patches, true));
  assertEquals(source.lines.length, 2, source.lines.join("\n"));
  assert(source.lines[0]!.includes("state.rows[100000] holds a Map"));
  // The path is built for a hit only, and it is the same path as ever.
  assertEquals(
    findWireLoss({ a: [{ b: 1 }, { c: { d: new Set() } }] }, "s")?.path,
    "s.a[1].c.d",
  );
  _wireLossSeen.clear();
});

Deno.test("prod says (state): _wrongPrefix shares the one memory the runtime reset clears", () => {
  _resetAioRuntime();
  const { result } = inProd(() => [
    _wrongPrefix("Row"),
    _wrongPrefix("Row"),
    (_resetAioRuntime(), _wrongPrefix("Row")),
  ]);
  assertEquals(result, ["[aio] ", null, "[aio] "]);
});
