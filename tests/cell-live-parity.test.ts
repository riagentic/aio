// The live async proxy vs the Immer draft: the divergences audit a8 found by
// running the SAME method body twice, once declared `async`.
//
// `tests/proxy-differential.test.ts` fuzzes the class; these are the named
// cases, each of which shipped as a silent difference between two spellings of
// one method — the shape CLAUDE.md calls green-test-broken-prod.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { registerCall, resetPending } from "../src/state/cell-impl.ts";
import type { Msg } from "../src/state/cell-types.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { _wireLossSeen } from "../src/state/wire-fidelity.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Run one method body BOTH ways and hand back the two committed states plus
 *  whatever each throw was. Two cells, one boot — the only difference between
 *  them is the `async` keyword, which is the whole point. */
async function bothKinds(
  id: string,
  state: () => Record<string, unknown>,
  body: (s: Any) => void,
): Promise<
  { sync: unknown; async: unknown; syncErr: string; asyncErr: string }
> {
  const sc = cell(`${id}_s`, { state: state(), methods: { run: body } });
  const ac = cell(`${id}_a`, {
    state: state(),
    // deno-lint-ignore require-await
    methods: {
      async run(s: Any) {
        body(s);
      },
    },
  });
  const h = await bootCells([sc, ac] as never);
  let syncErr = "";
  let asyncErr = "";
  try {
    try {
      await (sc as Any).run();
    } catch (e) {
      syncErr = e instanceof Error ? e.message : String(e);
    }
    try {
      await (ac as Any).run();
    } catch (e) {
      asyncErr = e instanceof Error ? e.message : String(e);
    }
    await h.settle();
    // Only the DECLARED state keys — a cell object also carries its methods
    // and its `__aio` definition, and comparing those compares the two cells'
    // names, which differ by construction.
    const snap = (c: Any) =>
      JSON.parse(
        JSON.stringify(
          Object.fromEntries(Object.keys(state()).map((k) => [k, c[k]])),
        ),
      );
    return { sync: snap(sc), async: snap(ac), syncErr, asyncErr };
  } finally {
    h.dispose();
  }
}

// ── G1: a live reference assigned to a second path ──────────────────────

Deno.test("alias: `s.sel = s.items[0]` then a write reaches BOTH paths, in both kinds", async () => {
  const r = await bothKinds(
    "alias1",
    () => ({ items: [{ id: 1, done: false }], sel: null as unknown }),
    (s) => {
      s.sel = s.items[0];
      s.sel.done = true;
    },
  );
  assertEquals(r.syncErr, "");
  assertEquals(r.asyncErr, "");
  // Plain JavaScript, and the Immer draft, write both names. The async twin
  // used to write only `sel` — one method body, two committed states.
  assertEquals(r.async, r.sync);
  assertEquals((r.sync as Any).items[0].done, true);
  assertEquals((r.sync as Any).sel.done, true);
});

Deno.test("alias: an element pushed into its own array is the SAME element, in both kinds", async () => {
  const r = await bothKinds(
    "alias2",
    () => ({ items: [{ id: 1, q: 0 }] }),
    (s) => {
      s.items.push(s.items[0]);
      s.items[1].q = 7;
    },
  );
  assertEquals(r.asyncErr, "");
  assertEquals(r.async, r.sync);
  assertEquals((r.sync as Any).items[0].q, 7);
});

Deno.test("alias: a nested container aliased into another key, in both kinds", async () => {
  const r = await bothKinds(
    "alias3",
    () => ({
      obj: {} as Record<string, unknown>,
      deep: { l1: { l2: { l3: [1] } } },
    }),
    (s) => {
      s.obj.d = s.deep.l1;
      s.deep.l1.l2.l3.push(5);
    },
  );
  assertEquals(r.asyncErr, "");
  assertEquals(r.async, r.sync);
  assertEquals((r.sync as Any).obj.d.l2.l3, [1, 5]);
});

// ── G2: defineProperty / setPrototypeOf ─────────────────────────────────

Deno.test("live state: Object.defineProperty is refused by name in BOTH kinds — never a silent no-op", async () => {
  const r = await bothKinds(
    "dp",
    () => ({ obj: { x: 1 } }),
    (s) => {
      Object.defineProperty(s.obj, "y", {
        value: 2,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  );
  // The sync side has always thrown (Immer's own refusal). The async side
  // had no trap at all: the descriptor landed on the placeholder target, the
  // read back was `undefined`, and nothing was logged.
  // Both messages must name the cell, the method, the refused operation and
  // the spelling that works — "some error happened" is what let the async
  // side stay silent in the first place. Since alpha76 they say it in the SAME
  // shape: Immer's own refusal names none of those things and was only legible
  // because the framework's generic `Cell '…' method '…' threw:` prefix was
  // glued in front of it, and that prefix had to go (an app shows `e.message`
  // to a user). So the sync side now emits the async side's sentence.
  assertStringIncludes(r.syncErr, "[dp_s:run]");
  assertStringIncludes(r.syncErr, "Object.defineProperty");
  assertStringIncludes(r.syncErr, "Assign instead");
  assertStringIncludes(r.asyncErr, "[dp_a:run]");
  assertStringIncludes(r.asyncErr, "Object.defineProperty(…, 'y', …)");
  assertStringIncludes(r.asyncErr, "Assign instead: s.obj.y = value");
  assertEquals(r.async, r.sync);
});

Deno.test("live state: Object.setPrototypeOf is refused by name in BOTH kinds", async () => {
  const r = await bothKinds(
    "spo",
    () => ({ obj: { x: 1 } }),
    (s) => {
      Object.setPrototypeOf(s.obj, { z: 1 });
    },
  );
  assertStringIncludes(r.syncErr, "[spo_s:run]");
  assertStringIncludes(r.syncErr, "Object.setPrototypeOf");
  assertStringIncludes(r.syncErr, "Assign instead");
  assertStringIncludes(r.asyncErr, "[spo_a:run]");
  assertStringIncludes(r.asyncErr, "Object.setPrototypeOf(…)");
  // The hint must fit the VALUE, not be the one generic spread line.
  assertStringIncludes(r.asyncErr, "const copy = { ...s.obj }");
});

// ── G5: symbol keys ─────────────────────────────────────────────────────

Deno.test("live state: a symbol key is refused by NAME in an async method", async () => {
  const sym = Symbol("k");
  const c = cell("symasync", {
    state: { obj: {} as Record<string | symbol, unknown> },
    // deno-lint-ignore require-await
    methods: {
      async put(s: Any) {
        s.obj[sym] = 1;
      },
    },
  });
  const h = await bootCells([c] as never);
  let msg = "";
  try {
    await (c as Any).put();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    h.dispose();
  }
  // Was: "'set' on proxy: trap returned falsish for property 'Symbol(k)'" —
  // no cell, no method, no reason.
  assertStringIncludes(msg, "symasync:put");
  assertStringIncludes(msg, "symbol-keyed property");
  assertStringIncludes(msg, "Use a string key");
});

Deno.test("a symbol key in a SYNC method reports the loss instead of killing the reduce", async () => {
  const sym = Symbol("k");
  _wireLossSeen.clear();
  const c = cell("symsync", {
    state: { obj: {} as Record<string | symbol, unknown> },
    methods: {
      put(s: Any) {
        s.obj[sym] = 1;
      },
    },
  });
  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, m: string) => {
        if (lvl === "warn") warnings.push(m);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as Any,
  );
  let msg = "";
  const h = await bootCells([c] as never);
  try {
    await (c as Any).put();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    setLogger(prev);
    h.dispose();
  }
  // The wire-loss reporter did `patch.path.join(".")` on a path holding a
  // symbol, so the METHOD failed — with "Cannot convert a Symbol value to a
  // string | fix: check action payload shape", from the very code whose job
  // is to say that a symbol key does not survive the wire.
  assertEquals(msg, "", "the reporter must not kill the write it describes");
  const hit = warnings.filter((w) => w.includes("symbol"));
  assertEquals(hit.length, 1, warnings.join("\n") || "(no warning at all)");
  assertStringIncludes(hit[0]!, "state.obj.Symbol(k)");
});

// ── G7: the root pseudo-keys ────────────────────────────────────────────

Deno.test("root keys: `'$do' in s` (and $commit/$live/$signal) agree across the kinds", async () => {
  const probe = (s: Any) => {
    s.seen = ["$do", "$commit", "$live", "$signal"]
      .map((k) => `${k}=${k in s}`).join(",");
  };
  const r = await bothKinds("rootkeys", () => ({ seen: "" }), probe);
  assertEquals(r.asyncErr, "");
  assertEquals(r.async, r.sync);
  assertEquals(
    (r.sync as Any).seen,
    "$do=true,$commit=true,$live=true,$signal=true",
  );
});

Deno.test("root keys: s.$signal / s.$live / s.$commit exist in a SYNC method too", async () => {
  const c = cell("rootsync", {
    state: { aborted: null as unknown, same: false },
    methods: {
      probe(s: Any) {
        s.aborted = s.$signal.aborted;
        s.same = s.$live === s.$live;
        s.$commit();
      },
    },
  });
  const h = await bootCells([c] as never);
  try {
    await (c as Any).probe();
    assertEquals((c as Any).aborted, false);
    assertEquals((c as Any).same, true);
  } finally {
    h.dispose();
  }
});

// ── G3: a sync return that CONTAINS drafts ──────────────────────────────

Deno.test("return: a sync method may return an object holding slices of state", async () => {
  const mk = (id: string, async: boolean) =>
    cell(id, {
      state: { items: [{ id: 1, q: 10 }, { id: 2, q: 20 }] },
      methods: async
        ? {
          // deno-lint-ignore require-await
          async pick(s: Any) {
            return {
              one: s.items[0],
              all: s.items.filter((x: Any) => x.q > 5),
            };
          },
        }
        : {
          pick(s: Any) {
            return {
              one: s.items[0],
              all: s.items.filter((x: Any) => x.q > 5),
            };
          },
        },
    });
  const sc = mk("ret_s", false);
  const ac = mk("ret_a", true);
  const h = await bootCells([sc, ac] as never);
  try {
    // Was: members were REVOKED Immer proxies — reading `.q` threw "Cannot
    // perform 'get' on a proxy that has been revoked", naming nothing.
    const s = await (sc as Any).pick();
    const a = await (ac as Any).pick();
    assertEquals(s.one.q, 10);
    assertEquals(s.all.length, 2);
    assertEquals(JSON.parse(JSON.stringify(s)), JSON.parse(JSON.stringify(a)));
  } finally {
    h.dispose();
  }
});

// ── W1 + G6: the action envelope, and who is told what ──────────────────

/** A hand-rolled app over `composeCells` — the reduce-level seam, where a
 *  malformed action from the network arrives. */
function tinyApp(cells: Any[]) {
  const composed = composeCells(cells as never);
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): unknown => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app as never, eff as Msg);
      return (r as { ret?: unknown }).ret;
    },
    getState: () => state,
  };
  composed.initAll(app as never);
  return app;
}

Deno.test("envelope: payload.args must be an ARRAY — refused identically for both kinds", async () => {
  const c = cell("envprobe", {
    state: { n: 0 },
    methods: {
      bump(s: Any, by = 1) {
        s.n += by;
      },
      // deno-lint-ignore require-await
      async bumpA(s: Any, by = 1) {
        s.n += by;
      },
    },
  });
  const app = tinyApp([c]);
  for (const m of ["bump", "bumpA"]) {
    let msg = "";
    try {
      app.dispatch({ type: `envprobe:${m}`, payload: { args: "notarray" } });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Was: the string was spread PER CHARACTER — `s.n += "n"` turned a number
    // into "0n" and the caller was acked ok:true — or it threw mid-spread and
    // only the sync half said so.
    assertStringIncludes(msg, "payload.args must be an ARRAY", `${m}: ${msg}`);
  }
  assertEquals((app.getState() as Any).envprobe.n, 0);
  await Promise.resolve();
});

Deno.test("call(): a _callId on a SYNC method is answered with its RETURN value", async () => {
  resetPending();
  const c = cell("callprobe", {
    state: { n: 0 },
    methods: {
      bump(s: Any, by = 1) {
        s.n += by;
        return s.n;
      },
    },
  });
  const app = tinyApp([c]);
  const done = registerCall("cid-sync", "callprobe:bump");
  app.dispatch({
    type: "callprobe:bump",
    payload: { args: [2], _callId: "cid-sync" },
  });
  // Was: the method RAN (state changed, the patch was broadcast) and the
  // caller was told `blocked — machine guard, cell disabled, or not found`.
  assertEquals(await done, 2);
  assertEquals((app.getState() as Any).callprobe.n, 2);
});

Deno.test("call(): a DISABLED cell is refused in that branch's own words", async () => {
  resetPending();
  const c = cell("disabledprobe", {
    state: { n: 0 },
    methods: {
      bump(s: Any) {
        s.n += 1;
      },
      async boom(_s: Any) {
        throw new Error("boom");
      },
    },
  });
  const composed = composeCells([c] as never, {
    circuitBreaker: { maxErrors: 1 },
  } as never);
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): unknown => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app as never, eff as Msg);
      return (r as { ret?: unknown }).ret;
    },
    getState: () => state,
  };
  composed.initAll(app as never);
  app.dispatch({ type: "disabledprobe:boom", payload: { args: [] } });
  for (let i = 0; i < 50 && composed.registry.isEnabled("disabledprobe"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assertEquals(composed.registry.isEnabled("disabledprobe"), false);
  const done = registerCall("cid-disabled", "disabledprobe:bump");
  app.dispatch({
    type: "disabledprobe:bump",
    payload: { args: [], _callId: "cid-disabled" },
  });
  let msg = "";
  try {
    await done;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  // One fixed sentence used to name three causes at once; each branch now
  // answers with the reason it actually applied.
  assertStringIncludes(msg, "is disabled");
  assertEquals((app.getState() as Any).disabledprobe.n, 0);
});

Deno.test("call(): an unknown method on a booted cell says so, not 'machine guard'", async () => {
  resetPending();
  const c = cell("knownprobe", {
    state: { n: 0 },
    methods: {
      bump(s: Any) {
        s.n += 1;
      },
    },
  });
  const app = tinyApp([c]);
  const done = registerCall("cid-unknown", "knownprobe:gone");
  app.dispatch({
    type: "knownprobe:gone",
    payload: { args: [], _callId: "cid-unknown" },
  });
  let msg = "";
  try {
    await done;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(msg, "has no method by that name");
});

// The other half of "never a silent wait": the executor is what settles a
// registered call, so anything that stops it from running the method must
// answer the call itself — or the caller waits out the whole ceiling and is
// then told the method "may still be running", about a method that never ran.
Deno.test("call(): an __exec the executor cannot run answers the caller at once", async () => {
  resetPending();
  const c = cell("execprobe", {
    state: { n: 0 },
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        s.n += 1;
      },
      bump(s: Any) {
        s.n += 1;
      },
    },
  });
  const composed = composeCells([c] as never);
  let state = composed.initialState;
  const app: Any = {
    dispatch: (a: Msg): unknown => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app, eff as Msg);
      return (r as { ret?: unknown }).ret;
    },
    getState: () => state,
  };
  composed.initAll(app);
  const rows: [string, Record<string, unknown>, RegExp][] = [
    // A method the executor has no async body for.
    [
      "unknown method",
      { _method: "nope", _args: [] },
      /no async method 'nope'/,
    ],
    ["sync method", { _method: "bump", _args: [] }, /is SYNC/],
    // A throw INSIDE execute, before the method could settle anything: a
    // non-iterable `_args` dies at the spread.
    [
      "executor throw",
      { _method: "run", _args: {} },
      /failed before the method could answer/,
    ],
  ];
  let i = 0;
  for (const [label, payload, expect] of rows) {
    const id = `cid-exec-${i++}`;
    const done = registerCall(id, "execprobe:run");
    composed.execute(app, {
      type: "execprobe:__exec",
      payload: { ...payload, _callId: id },
    } as Msg);
    const outcome = await Promise.race([
      done.then(() => "resolved", (e: unknown) => String((e as Error).message)),
      new Promise<string>((r) => setTimeout(() => r("NO ANSWER"), 200)),
    ]);
    assert(expect.test(outcome), `${label}: got ${outcome}`);
  }
});
