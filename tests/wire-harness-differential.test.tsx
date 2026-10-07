// The harness's verdict on a client call IS the transport's.
//
// A cell method called from the UI crosses a socket: its arguments are JSON by
// the time the server runs it, and so is what it returns. `testUI` used to
// hand the method the caller's own object, so `dialog.open({ when: new Date() })`
// was green in a test while the app stored a string (a field report: the only
// witness was a dev-console line, and the packaged build had none).
//
// One table, two paths, compared — the shape `tests/proxy-differential.test.ts`
// uses for sync/async parity, so the two can never drift:
//
//   • REAL: `testMultiClient().call()` — a real server, a real WebSocket, the
//     frame a browser sends.
//   • HARNESS: the same call made from a `testUI` mount.
//
// For every row the method reports what it RECEIVED (type-faithfully — JSON
// would hide the seams this is about), and:
//
//   exact    both paths hand the method the original
//   lossy    the real server receives something else ⇔ testUI fails the test,
//            naming cell, method, argument path and the kind of loss
//   omitted  an `undefined` object member: the key is absent on the server,
//            in the app and here — an optional field left unset. The method
//            runs, with exactly what the real socket hands it; no failure
//   refused  both paths reject the call and neither runs the method
//
// The RETURN direction has its own table: what the test awaits under testUI is
// what the real client's ack carries.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";
import { encodeAction } from "../src/state/action-encode.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** A value, rendered so every JSON seam stays visible. */
function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v !== "object") {
    return typeof v === "boolean" ? String(v) : typeof v;
  }
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (v instanceof Map) return `Map(${describe([...v])})`;
  if (v instanceof Set) return `Set(${describe([...v])})`;
  if (v instanceof RegExp) return `RegExp(${v})`;
  if (v instanceof Error) return `Error(${v.message})`;
  if (ArrayBuffer.isView(v)) {
    return `${v.constructor.name}(${[...(v as Uint8Array)]})`;
  }
  if (Array.isArray(v)) {
    const items: string[] = [];
    for (let i = 0; i < v.length; i++) {
      items.push(i in v ? describe(v[i]) : "<hole>");
    }
    // Named properties ride on an array in process and not in JSON.
    for (const k of Object.keys(v)) {
      if (!/^\d+$/.test(k)) items.push(`${k}:${describe(v[k as never])}`);
    }
    return `[${items.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(v);
  const name = proto === Object.prototype || proto === null
    ? ""
    : (v.constructor?.name ?? "?");
  return `${name}{${
    Object.keys(v).sort().map((k) =>
      `${k}:${describe((v as Record<string, unknown>)[k])}`
    ).join(",")
  }}`;
}

class Money {
  constructor(public cents: number) {}
  get dollars() {
    return this.cents / 100;
  }
}
const cyclic = (): unknown => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return o;
};

type Kind = "exact" | "lossy" | "omitted" | "refused";
/** `make` builds a fresh value per path — nothing is shared across the two. */
type Row = { name: string; kind: Kind; make: () => unknown; lost?: string };

const ROWS: Row[] = [
  // ── what JSON carries ──
  { name: "string", kind: "exact", make: () => "milk" },
  { name: "number", kind: "exact", make: () => 42.5 },
  { name: "boolean", kind: "exact", make: () => false },
  { name: "null", kind: "exact", make: () => null },
  {
    name: "ISO date string",
    kind: "exact",
    make: () => new Date(0).toISOString(),
  },
  {
    name: "unicode + quotes",
    kind: "exact",
    make: () => 'a"b\\c\ndé\u{1F600}',
  },
  {
    name: "empty containers",
    kind: "exact",
    make: () => ({ arr: [], obj: {} }),
  },
  {
    name: "nested plain",
    kind: "exact",
    make: () => ({ rows: [[1, 2], [{ id: "a", n: null }]] }),
  },
  {
    name: "null-prototype object",
    kind: "exact",
    make: () => Object.assign(Object.create(null), { a: 1 }),
  },
  {
    name: "max safe integer",
    kind: "exact",
    make: () => ({ big: Number.MAX_SAFE_INTEGER }),
  },
  {
    name: "entries array for a Map",
    kind: "exact",
    make: () => [["k", 1], ["j", 2]],
  },
  // ── what JSON changes ──
  {
    name: "Date",
    kind: "lossy",
    make: () => new Date(0),
    lost: "args[0]: Date → string",
  },
  {
    name: "nested Date",
    kind: "lossy",
    make: () => ({ id: 1, when: new Date(0) }),
    lost: "args[0].when: Date → string",
  },
  {
    name: "Map",
    kind: "lossy",
    make: () => new Map([["k", 1]]),
    lost: "args[0]: Map → Object",
  },
  {
    name: "Set",
    kind: "lossy",
    make: () => ({ tags: new Set(["a"]) }),
    lost: "args[0].tags: Set → Object",
  },
  {
    name: "undefined argument",
    kind: "lossy",
    make: () => undefined,
    lost: "args[0]: undefined → null",
  },
  {
    name: "undefined in an array",
    kind: "lossy",
    make: () => [1, undefined, 3],
    lost: "args[0][1]: undefined → null",
  },
  {
    name: "undefined member",
    kind: "omitted",
    make: () => ({ a: 1, gone: undefined }),
  },
  {
    name: "nested undefined member",
    kind: "omitted",
    make: () => ({ todo: { text: "x", due: undefined }, n: 1 }),
  },
  {
    name: "only undefined members",
    kind: "omitted",
    make: () => ({ a: undefined, b: undefined }),
  },
  {
    name: "{a: undefined} in an array",
    kind: "omitted",
    make: () => [{ a: undefined }],
  },
  {
    name: "undefined members in an array of objects",
    kind: "omitted",
    make: () => [{ id: 1, due: undefined }, { id: 2, due: "2026-01-01" }],
  },
  {
    name: "undefined member beside a Date",
    kind: "lossy",
    make: () => ({ due: undefined, when: new Date(0) }),
    lost: "args[0].when: Date → string",
  },
  {
    name: "undefined member beside an undefined array slot",
    kind: "lossy",
    make: () => ({ due: undefined, tags: ["a", undefined] }),
    lost: "args[0].tags[1]: undefined → null",
  },
  {
    name: "NaN",
    kind: "lossy",
    make: () => ({ n: NaN }),
    lost: "args[0].n: NaN → null",
  },
  {
    name: "Infinity",
    kind: "lossy",
    make: () => [Infinity, -Infinity],
    lost: "args[0][0]: Infinity → null",
  },
  {
    name: "-0",
    kind: "lossy",
    make: () => -0,
    lost: "args[0]: -0 → 0 (sign lost)",
  },
  {
    name: "class instance",
    kind: "lossy",
    make: () => new Money(250),
    lost: "args[0]: Money → Object",
  },
  {
    name: "function member",
    kind: "lossy",
    make: () => ({ id: 1, onDone: () => 1 }),
    lost: "args[0].onDone: function → absent",
  },
  {
    name: "function in an array",
    kind: "lossy",
    make: () => [() => 1],
    lost: "args[0][0]: function → null",
  },
  {
    name: "symbol member",
    kind: "lossy",
    make: () => ({ tag: Symbol("x") }),
    lost: "args[0].tag: symbol → absent",
  },
  {
    name: "typed array",
    kind: "lossy",
    make: () => new Uint8Array([1, 2]),
    lost: "args[0]: Uint8Array → Object",
  },
  {
    name: "RegExp",
    kind: "lossy",
    make: () => /ab+c/gi,
    lost: "args[0]: RegExp → Object",
  },
  {
    name: "Error",
    kind: "lossy",
    make: () => new Error("no"),
    lost: "args[0]: Error → Object",
  },
  {
    name: "toJSON object",
    kind: "lossy",
    make: () => ({ toJSON: () => "swapped" }),
    lost: "args[0]: Object → string",
  },
  {
    name: "sparse array",
    kind: "lossy",
    make: () => [1, , 3],
    lost: "args[0][1]: undefined → null",
  },
  {
    name: "array with a named property",
    kind: "lossy",
    make: () => Object.assign([1, 2], { tag: "x" }),
    lost: "args[0].tag: string → absent",
  },
  // ── what JSON refuses ──
  { name: "BigInt", kind: "refused", make: () => ({ n: 10n }) },
  { name: "cyclic", kind: "refused", make: cyclic },
];

const methods = {
  /** Report what the body RECEIVED. */
  take(s: { calls: number }, v: unknown, _second: unknown = null) {
    s.calls++;
    return describe(v);
  },
  /** Report three positional arguments, two with a default. */
  take3(
    s: { calls: number },
    a: unknown,
    b: unknown = "dflt",
    c: unknown = "dflt",
  ) {
    s.calls++;
    return describe([a, b, c]);
  },
  /** The OWN keys the body can see. */
  keys(s: { calls: number }, v: Record<string, unknown>) {
    s.calls++;
    return Object.keys(v).sort().join(",");
  },
  /** Declares no parameter: `onClick={cell.ping}` hands it an Event it ignores. */
  ping(s: { calls: number }) {
    s.calls++;
  },
  /** Return a row's value, for the other direction. */
  give(_s: unknown, name: string) {
    return ROWS.find((r) => r.name === name)!.make();
  },
  async giveLater(_s: unknown, name: string) {
    await Promise.resolve();
    return ROWS.find((r) => r.name === name)!.make();
  },
};
const real = cell("wirediff-real", { state: { calls: 0 }, methods });
const harness = cell("wirediff-ui", { state: { calls: 0 }, methods });

function App() {
  return (
    <div>
      <span>{harness.calls}</span>
      <button class="button" onClick={() => harness.take(new Date(0))}>
        Rich
      </button>
      <button class="button" onClick={() => harness.take("plain")}>
        Plain
      </button>
      <button class="button" onClick={harness.give as never}>Bare</button>
      <button class="button" onClick={harness.ping as never}>Ping</button>
    </div>
  );
}

type Outcome = { received?: string; error?: string; calls: number };

/** Every row over a real WebSocket. */
async function overRealWire(
  method: "take" | "give" | "giveLater",
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  await using m = await testMultiClient({ cells: [real] }, 1);
  const client = m.clients[0]!;
  for (const row of ROWS) {
    const before = m.serverState<{ calls: number }>("wirediff-real").calls;
    const o: Outcome = { calls: 0 };
    try {
      const got = method === "take"
        ? await client.call<string>("wirediff-real", "take", row.make())
        : describe(await client.call("wirediff-real", method, row.name));
      o.received = got;
    } catch (e) {
      o.error = (e as Error).message;
    }
    o.calls = m.serverState<{ calls: number }>("wirediff-real").calls - before;
    out.set(row.name, o);
  }
  return out;
}

/** Every row from a `testUI` mount. */
async function underTestUI(
  method: "take" | "give" | "giveLater",
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  await using ui = await testUI(App, { cells: [harness] });
  for (const row of ROWS) {
    const before = harness.calls;
    const o: Outcome = { calls: 0 };
    try {
      const got = method === "take"
        ? await harness.take(row.make()) as string
        : describe(await harness[method](row.name));
      o.received = got;
    } catch (e) {
      o.error = (e as Error).message;
    }
    await ui.settle();
    o.calls = harness.calls - before;
    out.set(row.name, o);
  }
  return out;
}

Deno.test("wire differential: testUI hands a method what the real socket hands it, and fails where the socket changes it", async (t) => {
  const wire = await overRealWire("take");
  const ui = await underTestUI("take");
  for (const row of ROWS) {
    await t.step(`${row.kind}: ${row.name}`, () => {
      const w = wire.get(row.name)!, u = ui.get(row.name)!;
      const original = (() => {
        try {
          return describe(row.make());
        } catch {
          return "<cyclic>"; // describe() recurses; the row is `refused` anyway
        }
      })();
      if (row.kind === "refused") {
        assert(w.error, `the real client refuses to send it: ${w.received}`);
        assertEquals(
          u.error?.replace("wirediff-ui", "wirediff-real"),
          w.error,
          "…and testUI refuses with the same words",
        );
        assertEquals([w.calls, u.calls], [0, 0], "neither ran the method");
        return;
      }
      assertEquals(w.error, undefined, "the real call is sent and acked");
      // The table's own claim, checked against the REAL transport and not
      // against the walk that makes the verdict: a row is lossy exactly when
      // the server received something other than what was passed.
      assertEquals(
        w.received !== original,
        row.kind !== "exact",
        `the real server received ${w.received} for ${original}`,
      );
      if (row.kind === "exact" || row.kind === "omitted") {
        assertEquals(u.error, undefined);
        assertEquals(u.received, w.received, "same value in the method body");
        assertEquals(u.calls, 1);
        return;
      }
      assert(
        u.error,
        `testUI must fail a call the wire changes — it ran the method with ${u.received}`,
      );
      assertEquals(
        u.calls,
        0,
        "the method did not run on a value the app would not hand it",
      );
      for (
        const part of [
          "wirediff-ui.take()",
          row.lost!,
          "fix: change the CALLER",
        ]
      ) {
        assert(
          u.error.includes(part),
          `the failure names "${part}":\n${u.error}`,
        );
      }
      assert(
        !u.error.includes("→ absent") || row.lost!.includes("→ absent"),
        `an omitted optional field is not listed as a loss:\n${u.error}`,
      );
    });
  }
});

// ── Positional arguments ──────────────────────────────────────────────────
//
// `cell.m(a, undefined)` is `args: ["a", null]` on the wire — the client stub
// sends `args` as called and trims nothing — so the method's DEFAULT PARAMETER
// does not apply and it receives `null`. In process the default applies. That
// is a value the caller did not pass, so testUI fails it; a call that simply
// leaves the argument out is the same on both paths.
const POSITIONAL: { name: string; args: unknown[]; lost?: string }[] = [
  { name: "argument left out", args: ["a"] },
  { name: "all passed", args: ["a", "b", "c"] },
  { name: "null passed", args: ["a", null] },
  {
    name: "trailing undefined",
    args: ["a", undefined],
    lost: "args[1]: undefined → null",
  },
  {
    name: "middle undefined",
    args: ["a", undefined, "c"],
    lost: "args[1]: undefined → null",
  },
  {
    name: "two trailing undefined",
    args: ["a", undefined, undefined],
    lost: "args[2]: undefined → null",
  },
];

Deno.test("wire differential: positional undefined — testUI fails exactly the calls whose server-side arguments differ from an in-process call", async (t) => {
  await using m = await testMultiClient({ cells: [real] }, 1);
  await using _ui = await testUI(App, { cells: [harness] });
  for (const row of POSITIONAL) {
    await t.step(row.name, async () => {
      const inProcess = methods.take3({ calls: 0 }, ...row.args as [unknown]);
      const wire = await m.clients[0]!.call<string>(
        "wirediff-real",
        "take3",
        ...row.args,
      );
      // The oracle is the real socket against a plain function call — not the
      // walk that makes the harness's verdict.
      assertEquals(wire !== inProcess, row.lost !== undefined, wire);
      const before = harness.calls;
      if (row.lost === undefined) {
        assertEquals(
          await (harness.take3 as (...a: unknown[]) => unknown)(...row.args),
          wire,
        );
        assertEquals(harness.calls, before + 1);
        return;
      }
      const err = await assertRejects(
        () =>
          (harness.take3 as (...a: unknown[]) => Promise<unknown>)(...row.args),
        Error,
      );
      assert(err.message.includes(row.lost), err.message);
      assert(err.message.includes("default parameter"), err.message);
      assertEquals(harness.calls, before);
    });
  }
});

Deno.test("wire differential: an optional field left undefined passes, and the method receives the key absent", async () => {
  function Form() {
    const due: string | undefined = undefined;
    return (
      <button
        class="button"
        onClick={() => harness.keys({ text: "x", due })}
      >
        Add
      </button>
    );
  }
  await using ui = await testUI(Form, { cells: [harness] });
  const before = harness.calls;
  ui.AddButton.click();
  await ui.settle();
  assertEquals(harness.calls, before + 1, "the call was dispatched");
  assertEquals(await harness.keys({ text: "x", due: undefined }), "text");
  assertEquals(await harness.keys({ a: undefined }), "");
});

for (const method of ["give", "giveLater"] as const) {
  Deno.test(`wire differential: what a test awaits from ${method}() under testUI is what the real ack carries`, async (t) => {
    const wire = await overRealWire(method);
    const ui = await underTestUI(method);
    for (const row of ROWS) {
      await t.step(row.name, () => {
        const w = wire.get(row.name)!, u = ui.get(row.name)!;
        assertEquals(u.error, w.error, "a returned value is never a rejection");
        assertEquals(u.received, w.received);
      });
    }
  });
}

Deno.test("wire differential: a click whose handler passes a Date fails the test at the next observation", async () => {
  const ui = await testUI(App, { cells: [harness] });
  try {
    ui.RichButton.click();
    const err = await assertRejects(() => ui.settle(), Error);
    assert(
      err.message.includes("wirediff-ui.take()") &&
        err.message.includes("args[0]: Date → string") &&
        err.message.includes("toISOString"),
      err.message,
    );
    assertEquals(harness.calls, 0);
    ui.PlainButton.click();
    await ui.settle();
    assertEquals(harness.calls, 1, "a JSON-safe click goes through");
  } finally {
    await ui.dispose();
  }
});

Deno.test("wire differential: a second argument is named by its own path", async () => {
  await using _ui = await testUI(App, { cells: [harness] });
  const err = await assertRejects(
    () => harness.take("ok", { when: new Date(0) }) as Promise<unknown>,
    Error,
  );
  assert(err.message.includes("args[1].when: Date → string"), err.message);
});

Deno.test("wire differential: onClick={cell.method} — an Event the method ignores is fine, one it declares a parameter for is not", async () => {
  await using ui = await testUI(App, { cells: [harness] });
  // `ping(s)` declares nothing: a browser sends `{"isTrusted":true}` and
  // nothing reads it.
  ui.PingButton.click();
  await ui.settle();
  assertEquals(harness.calls, 1);
  // `give(s, name)` DECLARES the slot the Event lands in: the app's server
  // would look a row up by `{"isTrusted":true}`.
  ui.BareButton.click();
  const err = await assertRejects(() => ui.settle(), Error);
  assert(/args\[0\]: \w*Event → object/.test(err.message), err.message);
  assert(
    err.message.includes("a raw element handler passes the EVENT"),
    err.message,
  );
});

// ── Server-side callers cross no wire, here or in the app ─────────────────

const store = cell("wirediff-store", {
  state: { kind: "" },
  methods: {
    keep(s: { kind: string }, when: unknown) {
      s.kind = when instanceof Date ? "Date" : typeof when;
    },
  },
});
const caller = cell("wirediff-caller", {
  state: { n: 0 },
  methods: {
    async stamp(s: { n: number }) {
      s.n++;
      await store.keep(new Date(0)); // cell → cell: the server calling itself
    },
  },
});

Deno.test("wire differential: a cell calling another cell passes its Date by reference, as on a server", async () => {
  await using ui = await testUI(() => <p>{store.kind}</p>, {
    cells: [store, caller],
  });
  await caller.stamp();
  await ui.settle();
  assertEquals(store.kind, "Date");
});

testCell(
  store,
  "wire differential: testCell drives the method server-side — a rich argument arrives as passed",
  async (t) => {
    await t.send.keep(new Date(0));
    t.expect.state((s) => s.kind === "Date");
  },
);

// ── The console line, dev and prod ────────────────────────────────────────

function warningsOf(fn: () => void): string[] {
  const got: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") got.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    fn();
  } finally {
    setLogger(prev);
  }
  return got;
}

Deno.test("wire warning: a production client says a changed argument too — once per method, same frame", () => {
  _resetAioRuntime();
  const action = (when: unknown) => ({
    type: "dialog:open",
    payload: { args: [{ when }] },
  });
  try {
    setDevModeOverride(true);
    let devFrame = "";
    const dev = warningsOf(() => devFrame = encodeAction(action(new Date(0))));
    assertEquals(dev.length, 1);
    assert(dev[0]!.includes("dialog:open.args[0].when: Date → string"), dev[0]);

    _resetAioRuntime();
    setDevModeOverride(false);
    let prodFrame = "";
    const prod = warningsOf(() => {
      prodFrame = encodeAction(action(new Date(0)));
      encodeAction(action(new Date(1)));
      encodeAction({ type: "dialog:open", payload: { args: [new Map()] } });
    });
    assertEquals(prodFrame, devFrame, "the frame is the same in dev and prod");
    assertEquals(prod.length, 1, `once per cell:method:\n${prod.join("\n")}`);
    assert(
      prod[0]!.includes("dialog:open.args[0].when: Date → string"),
      prod[0],
    );
    assert(prod[0]!.length < dev[0]!.length, "prod is the short form");
    assertEquals(
      warningsOf(() => encodeAction(action("2026-01-01"))).length,
      0,
      "a JSON-safe call says nothing",
    );
    // An optional field left unset: prod never said it (1.0.18 had no prod
    // line at all) and still does not; dev says what it said in 1.0.18.
    const unset = {
      type: "todos:add",
      payload: { args: [{ text: "x", due: undefined }] },
    };
    _resetAioRuntime();
    setDevModeOverride(false);
    assertEquals(warningsOf(() => encodeAction(unset)), []);
    assertEquals(
      warningsOf(() =>
        encodeAction({ type: "todos:add", payload: { args: ["x", undefined] } })
      ).length,
      1,
      "an undefined ARGUMENT arrives as null — prod says that",
    );
    _resetAioRuntime();
    setDevModeOverride(true);
    const devUnset = warningsOf(() => encodeAction(unset));
    assertEquals(devUnset.length, 1);
    assert(
      devUnset[0]!.includes("todos:add.args[0].due: undefined → absent"),
      devUnset[0],
    );
    // Prod checks a method's first 16 calls: the walk costs a second parse
    // of the frame on every call. A loss inside them is said; one that only
    // starts later is dev's to catch, where every call is checked.
    _resetAioRuntime();
    setDevModeOverride(false);
    const late = (when: unknown) => ({
      type: "list:save",
      payload: { args: [{ when }] },
    });
    assertEquals(
      warningsOf(() => {
        for (let i = 0; i < 15; i++) encodeAction(late("2026-01-01"));
        encodeAction(late(new Date(0)));
      }).length,
      1,
      "a loss on the 16th call is said",
    );
    _resetAioRuntime();
    assertEquals(
      warningsOf(() => {
        for (let i = 0; i < 16; i++) encodeAction(late("2026-01-01"));
        encodeAction(late(new Date(0)));
      }).length,
      0,
      "after 16 clean calls prod stops checking that method",
    );
    setDevModeOverride(true);
    _resetAioRuntime();
    assertEquals(
      warningsOf(() => {
        for (let i = 0; i < 16; i++) encodeAction(late("2026-01-01"));
        encodeAction(late(new Date(0)));
      }).length,
      1,
      "dev checks every call",
    );
  } finally {
    setDevModeOverride(null);
    _resetAioRuntime();
  }
});
