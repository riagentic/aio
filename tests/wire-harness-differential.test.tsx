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
import { fromFileUrl } from "@std/path";
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
  /** How many arguments ARRIVED, and what they were. */
  seen(s: { calls: number }, ...rest: unknown[]) {
    s.calls++;
    return `${rest.length}:${describe(rest)}`;
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

// WHY A TRAILING `undefined` IS NOT TRIMMED BEFORE ENCODING.
//
// `add("x", undefined)` reaches the server as `["x", null]`, so `due = today`
// does not apply — and dropping the trailing slot on the client would make the
// server see exactly what an in-process call sees. It is also a change an
// existing app can observe on the same wire, three ways, which is what the
// frozen surface forbids: a body that tests `arg === null` (the documented
// way to tell "cleared" from "left out"), one that stores the argument (state
// holds `null` today — a value JSON, persistence and every client keep — and
// would hold `undefined`, which all three drop), and one that counts its
// arguments. So the wire stays as it is, the call is NAMED on every path (the
// table above, the dev and production warnings), and this pins the three
// observables: a trim that ships by default turns this red on purpose.
Deno.test("wire differential: a trailing undefined arrives as null — observable by the method, so it is reported, not rewritten", async () => {
  await using m = await testMultiClient({ cells: [real] }, 1);
  const call = (...args: unknown[]) =>
    m.clients[0]!.call<string>("wirediff-real", "seen", ...args);
  assertEquals(await call("a"), '1:["a"]');
  assertEquals(await call("a", null), '2:["a",null]');
  assertEquals(
    await call("a", undefined),
    '2:["a",null]',
    "the slot is there, holding null: `arg === null` and a rest/arguments " +
      "count both see it",
  );
  assertEquals(await call("a", undefined, undefined), '3:["a",null,null]');
  // …and in process (no wire: a server-side call, a standalone build) the
  // same call hands the body `undefined` — the difference the warnings name.
  assertEquals(methods.seen({ calls: 0 }, "a", undefined), '2:["a",undefined]');
});

// ── `aio.run({ wire: { omitTrailingUndefined: true } })` ───────────────────
//
// The opt-in. The page learns it as `__aioConfig.wire` (the shell, or the
// `cfg` frame — tests/wire-option-reaches-client.test.ts), and ONE function
// reads it for every door. Here the page's global is set by hand and the
// rest is production: the client's encode, a real socket, the server's
// decode.
async function withWireFlag<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __aioConfig?: Record<string, unknown> };
  const had = g.__aioConfig;
  if (on) g.__aioConfig = { ...had, wire: { omitTrailingUndefined: true } };
  try {
    return await fn();
  } finally {
    if (had === undefined) delete g.__aioConfig;
    else g.__aioConfig = had;
  }
}

/** [method, args] — every shape a trailing `undefined` comes in. */
const TRAILING: ["seen" | "take3", unknown[]][] = [
  ["seen", ["a"]],
  ["seen", ["a", null]],
  ["seen", ["a", undefined]],
  ["seen", ["a", undefined, undefined]],
  ["seen", [undefined]],
  ["seen", []],
  ["seen", ["a", null, undefined]],
  ["take3", ["a", undefined, undefined]],
  ["take3", ["a", "b", undefined]],
];

Deno.test("wire.omitTrailingUndefined: off, a trailing undefined arrives as null; on, the socket hands the method what an in-process call does", async () => {
  await using m = await testMultiClient({ cells: [real] }, 1);
  const over = (method: string, args: unknown[]) =>
    m.clients[0]!.call<string>("wirediff-real", method, ...args);
  const inProcess = (method: "seen" | "take3", args: unknown[]) =>
    (methods[method] as (s: unknown, ...a: unknown[]) => string)(
      { calls: 0 },
      ...args,
    );
  for (const [method, args] of TRAILING) {
    const trailing = args.length > 0 && args.at(-1) === undefined;
    const off = await withWireFlag(false, () => over(method, args));
    const on = await withWireFlag(true, () => over(method, args));
    const local = inProcess(method, args);
    const name = `${method}(${describe(args)})`;
    if (trailing) {
      assert(off !== local, `${name}: the default changes it (${off})`);
      // In process a rest parameter still COUNTS the undefined; on the wire
      // it is not there to count. What the method can read from each
      // parameter is the same.
      assertEquals(
        on,
        method === "seen"
          ? inProcess(
            method,
            args.slice(0, args.findLastIndex((a) => a !== undefined) + 1),
          )
          : local,
        name,
      );
    } else {
      assertEquals(off, local, name);
      assertEquals(on, off, `${name}: nothing to omit, nothing changes`);
    }
  }
  // The default parameter gets its default — the reason the option exists.
  assertEquals(
    await withWireFlag(true, () => over("take3", ["a", undefined, undefined])),
    describe(["a", "dflt", "dflt"]),
  );
  assertEquals(
    await withWireFlag(false, () => over("take3", ["a", undefined, undefined])),
    describe(["a", null, null]),
  );
  // Not trailing: it cannot be dropped without moving the argument after it,
  // so it is `null` with the flag on too.
  for (const on of [false, true]) {
    assertEquals(
      await withWireFlag(on, () => over("seen", [undefined, "a"])),
      '2:[null,"a"]',
    );
  }
});

Deno.test("wire.omitTrailingUndefined: testUI follows the flag — a trailing undefined passes and is not delivered, a non-trailing one still fails", async () => {
  const g = globalThis as { __aioConfig?: unknown };
  const before = g.__aioConfig;
  {
    await using ui = await testUI(App, {
      cells: [harness],
      wire: { omitTrailingUndefined: true },
    });
    assertEquals(await harness.seen("a", undefined), '1:["a"]');
    assertEquals(
      await harness.take3("a", undefined, undefined),
      describe(["a", "dflt", "dflt"]),
    );
    await assertRejects(
      async () => await harness.seen(undefined, "a"),
      Error,
      "args[0]: undefined → null",
    );
    await ui.settle();
  }
  assertEquals(g.__aioConfig, before, "the mount's wire config left with it");
  // …and without the option the same call is the failure it always was.
  await using ui = await testUI(App, { cells: [harness] });
  await assertRejects(
    async () => await harness.seen("a", undefined),
    Error,
    "args[1]: undefined → null",
  );
  await ui.settle();
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

// ── A thrown error ────────────────────────────────────────────────────────
//
// In process the caller of a failing method got the server's own object: its
// class, its `cause`, its properties, its stack. A client gets a failed ack —
// two fields, `error` and `code` — and rebuilds a plain Error from them. A
// test checking `instanceof`, `e.cause` or `e.status` under `testUI` was green
// over a call the app answers with none of them.

class HttpError extends Error {
  status = 422;
  constructor(message: string) {
    super(message, { cause: new Error("root") });
    this.name = "HttpError";
  }
}
const THROWS: Record<string, () => unknown> = {
  "plain Error": () => new Error("plain"),
  TypeError: () => new TypeError("typed"),
  "subclass with a property and a cause": () => new HttpError("unprocessable"),
  "Error with a code": () => Object.assign(new Error("coded"), { code: "MY" }),
  "a string": () => "nope",
  "an object": () => ({ reason: "x" }),
  "empty message": () => new Error(""),
  "unicode message": () => new Error('a"b\\c\ndé\u{1F600}'),
};
const failing = {
  fail(_s: unknown, k: string) {
    throw THROWS[k]!();
  },
  // deno-lint-ignore require-await
  async failNow(_s: unknown, k: string) {
    throw THROWS[k]!();
  },
  async failLater(_s: unknown, k: string) {
    await Promise.resolve();
    throw THROWS[k]!();
  },
};
const FAILING = ["fail", "failNow", "failLater"] as const;
const realThrow = cell("wirediff-throw-real", {
  state: { n: 0 },
  methods: failing,
});
const uiThrow = cell("wirediff-throw-ui", {
  state: { n: 0 },
  methods: failing,
});

/** Everything about a rejection a test could check. */
function sayRejection(e: unknown): string {
  if (!(e instanceof Error)) return `not an Error: ${describe(e)}`;
  return [
    e.constructor.name,
    e.name,
    JSON.stringify(e.message),
    `code=${String((e as { code?: unknown }).code)}`,
    `own=${Object.keys(e).join("+")}`,
    e.cause === undefined ? "no cause" : "cause",
  ].join(" | ");
}

/** The harness and the real client log the server's failure; that is not what
 *  is compared here. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: () => {},
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    return await fn();
  } finally {
    setLogger(prev);
  }
}

// The three crossings below are `wire.strict` — opt-in, because a test that
// was green on 1.0.19's harness must stay green (the default is pinned by
// tests/testui-wire-strict-is-opt-in.test.tsx). Stated on each mount, so this
// file proves harness == wire whatever environment runs it.
const STRICT = { strict: true } as const;

Deno.test("wire differential: a method that throws rejects its testUI caller with exactly what the real ack rejects a client with", async (t) => {
  const wire = new Map<string, string>();
  const ui = new Map<string, string>();
  await quietly(async () => {
    {
      await using m = await testMultiClient({ cells: [realThrow] }, 1);
      for (const method of FAILING) {
        for (const k of Object.keys(THROWS)) {
          wire.set(
            `${method}: ${k}`,
            await m.clients[0]!.call("wirediff-throw-real", method, k).then(
              () => "resolved",
              sayRejection,
            ),
          );
        }
      }
    }
    await using _ui = await testUI(() => <div />, {
      cells: [uiThrow],
      wire: STRICT,
    });
    for (const method of FAILING) {
      for (const k of Object.keys(THROWS)) {
        ui.set(
          `${method}: ${k}`,
          await (uiThrow[method](k) as unknown as Promise<unknown>).then(
            () => "resolved",
            sayRejection,
          ),
        );
      }
    }
  });
  assertEquals(wire.size, FAILING.length * Object.keys(THROWS).length);
  for (const [row, w] of wire) {
    await t.step(row, () => {
      assert(w.startsWith("Error | Error | "), `the real client got: ${w}`);
      assertEquals(ui.get(row), w);
    });
  }
});

// The method is called from the server's side — another cell, `testCell` —
// and crosses no wire: its caller keeps the error itself.
const throwCaller = cell("wirediff-throw-caller", {
  state: { saw: "" },
  methods: {
    async relay(s: { saw: string }, k: string) {
      s.saw = await (uiThrow.failLater(k) as unknown as Promise<void>).then(
        () => "resolved",
        (e) =>
          `${e instanceof HttpError} ${(e as HttpError).status} ${
            (e as Error).cause !== undefined
          }`,
      );
    },
  },
});

Deno.test("wire differential: a cell calling a method that throws catches the error itself, as on a server", async () => {
  await quietly(async () => {
    await using _ui = await testUI(() => <div />, {
      cells: [uiThrow, throwCaller],
    });
    await throwCaller.relay("subclass with a property and a cause");
    assertEquals(throwCaller.saw, "true 422 true");
  });
});

// A test that could only pass because the error never left the process fails
// now — and is told why, in the failure itself.
Deno.test("wire differential: a test that checks the class of a rejection fails under testUI with the reason in its message", async () => {
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("wirediff-why-");
  try {
    const root = new URL("../", import.meta.url).href;
    await Deno.writeTextFile(
      `${dir}/why.test.ts`,
      `import { cell } from "${root}mod.ts";
import { testUI } from "${root}src/testing/ui-test.ts";
import { h } from "${root}src/air/vdom.ts";
class HttpError extends Error { status = 422; }
const c = cell("why", { state: { n: 0 }, methods: {
  async save() { await Promise.resolve(); throw new HttpError("unprocessable"); },
} });
testUI(() => h("div", null), "relies on the class", { wire: { strict: true } }, async () => {
  try { await c.save(); } catch (e) {
    if (!(e instanceof HttpError)) throw new Error("expected an HttpError");
  }
});
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        `${dir}/why.test.ts`,
      ],
      env: { NO_COLOR: "1", AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.success, false, text);
    for (
      const part of [
        "expected an HttpError",
        "what the caller received is what a real client receives",
        "why.save() — class HttpError, .status",
        "errorCode(e)",
      ]
    ) assert(text.includes(part), `the failure says "${part}":\n${text}`);
  } finally {
    await dropTempDir(dir);
  }
});

// The handle form's body fails outside the harness, so no failure message is
// there to carry the reason: it is said when the rejection loses something,
// once per run — and the wrapper form, which words the failure, does not
// say it twice.
Deno.test("wire differential: the handle form says what a rejection lost on the wire, once — the wrapper form keeps it for the failure", async () => {
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("wirediff-handle-");
  try {
    const root = new URL("../", import.meta.url).href;
    const file = (form: "handle" | "wrapper") =>
      `import { cell } from "${root}mod.ts";
import { testUI } from "${root}src/testing/ui-test.ts";
import { h } from "${root}src/air/vdom.ts";
class HttpError extends Error { status = 422; }
const c = cell("why", { state: { n: 0 }, methods: {
  async save() { await Promise.resolve(); throw new HttpError("unprocessable"); },
} });
const App = () => h("div", null);
const body = async () => {
  for (let i = 0; i < 2; i++) await c.save().catch(() => {});
  try { await c.save(); } catch (e) {
    if (!(e instanceof HttpError)) throw new Error("expected an HttpError");
  }
};
` + (form === "handle"
        ? `Deno.test("relies on the class", async () => {
  await using _ui = await testUI(App, { wire: { strict: true } });
  await body();
});
`
        : `testUI(App, "relies on the class", { wire: { strict: true } }, body);
`);
    const run = async (form: "handle" | "wrapper") => {
      await Deno.writeTextFile(`${dir}/${form}.test.ts`, file(form));
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "test",
          "-A",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          `${dir}/${form}.test.ts`,
        ],
        env: { NO_COLOR: "1", AIO_APPS_DIR: dir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertEquals(out.success, false, text);
      assert(text.includes("expected an HttpError"), text);
      return text;
    };
    const said = "[aio] testUI: why.save() rejected, and its caller " +
      "received what a real client receives";
    const handle = await run("handle");
    assertEquals(handle.split(said).length - 1, 1, handle);
    for (
      const part of ["not carried: class HttpError, .status", "errorCode(e)"]
    ) {
      assert(handle.includes(part), `the hint says "${part}":\n${handle}`);
    }
    assert(!(await run("wrapper")).includes(said));
  } finally {
    await dropTempDir(dir);
  }
});

// ── `serverFn` ────────────────────────────────────────────────────────────
//
// A component's `serverFn("ns").f(x)` is a frame too. Under testUI it reached
// the function itself: `x` by reference, no access rule, the thrown error by
// identity, the result by reference.

import { serverFn, serverFns } from "../src/server/server-fns.ts";
import { serverUser } from "../src/server/auth-context.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { serializeArgs } from "../src/protocol/wire-value.ts";
import { sfnArgsDropped, sfnError } from "../src/browser/server-fns-client.ts";

const apiDef = serverFns("wirediff-api", {
  take: (v: unknown) => describe(v),
  give: (name: string) => ROWS.find((r) => r.name === name)!.make(),
  fail: (k: string) => {
    throw THROWS[k]!();
  },
  who: () => serverUser()?.id ?? "anonymous",
});
serverFns("wirediff-admin", { secret: () => "s3" }, { access: "admin" });
const api = serverFn<typeof apiDef>("wirediff-api");
const admin = serverFn<{ secret: () => string }>("wirediff-admin");

type SfnOutcome = { received?: string; error?: string };
type SfnCall = [ns: string, name: string, args: unknown[]];

/** Each call as a browser makes it: its own argument vetting, an `sfn` frame
 *  on a real WebSocket, its own reader of the `sfnr` reply. */
async function sfnOverRealWire(calls: SfnCall[]): Promise<SfnOutcome[]> {
  await using srv = await testServer({ cells: [real] });
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  const replies = new Map<string, (d: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = typeof e.data === "string" ? dec(e.data) : null;
    if (f?.t !== "sfnr") return;
    const d = f.d as { cid: string };
    replies.get(d.cid)?.(d as Record<string, unknown>);
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error("no WebSocket to the test server"));
  });
  const out: SfnOutcome[] = [];
  try {
    for (const [i, [ns, name, args]] of calls.entries()) {
      const what = `serverFn("${ns}").${name}`;
      const { args: safe, dropped } = serializeArgs(args, what);
      if (dropped) {
        out.push({ error: sfnArgsDropped(what).message });
        continue;
      }
      const cid = `c${i}`;
      const reply = new Promise<Record<string, unknown>>((r) =>
        replies.set(cid, r)
      );
      ws.send(enc("sfn", { cid, ns, name, args: safe }));
      const r = await reply;
      out.push(
        r.ok
          ? { received: describe(r.value) }
          : { error: sayRejection(sfnError(r)) },
      );
    }
  } finally {
    const closed = new Promise((r) => ws.onclose = r);
    ws.close();
    await closed;
  }
  return out;
}

async function sfnUnderTestUI(
  calls: SfnCall[],
  opts: Parameters<typeof testUI>[1] = {},
): Promise<SfnOutcome[]> {
  await using _ui = await testUI(() => <div />, {
    cells: [harness],
    wire: STRICT,
    ...opts,
  });
  const out: SfnOutcome[] = [];
  for (const [ns, name, args] of calls) {
    const fn = (serverFn(ns) as Record<string, (...a: unknown[]) => unknown>)[
      name
    ]!;
    out.push(
      await (fn(...args) as Promise<unknown>).then(
        (v) => ({ received: describe(v) }),
        (e) => ({
          error: (e as Error).message.startsWith("testUI:") ||
              (e as Error).message.includes("nothing was sent")
            ? (e as Error).message
            : sayRejection(e),
        }),
      ),
    );
  }
  return out;
}

Deno.test("wire differential: serverFn arguments — testUI hands the function what the real socket hands it, and fails where the socket changes it", async (t) => {
  const calls: SfnCall[] = ROWS.map((
    r,
  ) => ["wirediff-api", "take", [r.make()]]);
  const wire = await quietly(() => sfnOverRealWire(calls));
  const ui = await quietly(() => sfnUnderTestUI(calls));
  for (const [i, row] of ROWS.entries()) {
    await t.step(`${row.kind}: ${row.name}`, () => {
      const w = wire[i]!, u = ui[i]!;
      if (row.kind === "refused") {
        assert(w.error?.includes("nothing was sent"), JSON.stringify(w));
        assertEquals(u.error, w.error, "refused with the same words");
        return;
      }
      if (row.kind === "exact" || row.kind === "omitted") {
        assertEquals(u, w, "same value in the function body");
        return;
      }
      assert(w.received !== undefined, "the real call is sent, changed");
      for (
        const part of [
          'testUI: serverFn("wirediff-api").take()',
          row.lost!,
          "fix: change the CALLER",
        ]
      ) {
        assert(u.error?.includes(part), `names "${part}":\n${u.error}`);
      }
    });
  }
});

Deno.test("wire differential: serverFn results, thrown errors, the access rule and an unknown function — testUI answers as the real socket does", async (t) => {
  const calls: SfnCall[] = [
    ...ROWS.filter((r) => r.kind !== "refused").map((r): SfnCall => [
      "wirediff-api",
      "give",
      [r.name],
    ]),
    ...Object.keys(THROWS).map((k): SfnCall => ["wirediff-api", "fail", [k]]),
    ["wirediff-api", "who", []],
    ["wirediff-admin", "secret", []],
    ["wirediff-api", "nope", []],
    ["wirediff-none", "f", []],
    ["wirediff-api", "toString", []],
  ];
  const wire = await quietly(() => sfnOverRealWire(calls));
  const ui = await quietly(() => sfnUnderTestUI(calls));
  assertEquals(wire.length, calls.length);
  assert(calls.length > 0);
  for (const [i, [ns, name, args]] of calls.entries()) {
    await t.step(`${ns}.${name}(${args.map(String).join(",")})`, () => {
      assertEquals(ui[i], wire[i]);
    });
  }
  // The rule is the server's: an admin passes it, and is who the function
  // sees; `enforceAccess: false` drives it deliberately.
  const asAdmin = await quietly(() =>
    sfnUnderTestUI([["wirediff-admin", "secret", []], [
      "wirediff-api",
      "who",
      [],
    ]], { user: { id: "ada", role: "admin" } })
  );
  assertEquals(asAdmin, [{ received: '"s3"' }, { received: '"ada"' }]);
  assertEquals(
    await quietly(() =>
      sfnUnderTestUI([["wirediff-admin", "secret", []]], {
        enforceAccess: false,
      })
    ),
    [{ received: '"s3"' }],
  );
  // Outside a mount nothing is in the way: a server-side caller.
  assertEquals(
    await api.take(new Date(0)),
    `Date(${new Date(0).toISOString()})`,
  );
  assertEquals(await admin.secret(), "s3");
});

// ── `useAio().send` ───────────────────────────────────────────────────────
//
// The raw door: any action, no ack. Under testUI there is no transport, so
// the action was queued as "offline" and never ran — a click that did nothing.

import { useAio } from "../src/browser-air.ts";

const sent = cell("wirediff-send", {
  state: { log: [] as string[] },
  methods: {
    take(s: { log: string[] }, v: unknown = "dflt") {
      s.log.push(describe(v));
    },
    boom() {
      throw new Error("send-boom");
    },
  },
});

function Sender() {
  const { send } = useAio();
  const act = (type: string, ...args: unknown[]) => () =>
    send({ type, payload: { args } });
  return (
    <div>
      <button class="button" onClick={act("wirediff-send:take", "milk")}>
        Plain
      </button>
      <button
        class="button"
        onClick={act("wirediff-send:take", { rows: [1, null] })}
      >
        Nested
      </button>
      <button
        class="button"
        onClick={() => send({ type: "wirediff-send:take" })}
      >
        Bare
      </button>
      <button class="button" onClick={act("wirediff-send:take", new Date(0))}>
        Rich
      </button>
      <button class="button" onClick={act("wirediff-send:boom")}>Boom</button>
      <button class="button" onClick={act("wirediff-send:nope")}>
        Unknown
      </button>
      <button class="button" onClick={act("wirediff-send:__destroy")}>
        Internal
      </button>
    </div>
  );
}

Deno.test("wire differential: useAio().send — testUI runs the action the real socket runs, and fails the ones the app loses", async () => {
  const ACTIONS: unknown[][] = [["milk"], [{ rows: [1, null] }]];
  // REAL: the frame a tab sends, no cid.
  let wire: string[];
  {
    await using srv = await testServer({ cells: [sent] });
    const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
    await new Promise<void>((ok, fail) => {
      ws.onopen = () => ok();
      ws.onerror = () => fail(new Error("no WebSocket to the test server"));
    });
    const log = () =>
      (srv.state() as Record<string, { log: string[] }>)["wirediff-send"]!.log;
    for (const args of ACTIONS) {
      ws.send(encodeAction({ type: "wirediff-send:take", payload: { args } }));
    }
    ws.send(encodeAction({ type: "wirediff-send:take" }));
    const deadline = Date.now() + 5_000;
    while (log().length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    wire = [...log()];
    const closed = new Promise((r) => ws.onclose = r);
    ws.close();
    await closed;
  }
  assertEquals(wire, ['"milk"', "{rows:[1,null]}", '"dflt"']);

  await quietly(async () => {
    const ui = await testUI(Sender, { cells: [sent], wire: STRICT });
    try {
      ui.PlainButton.click();
      ui.NestedButton.click();
      ui.BareButton.click();
      await ui.settle();
      assertEquals([...sent.log], wire, "the same three calls ran");
      // What the socket would change is the test's failure, as for a call.
      ui.RichButton.click();
      let err = await assertRejects(() => ui.settle(), Error);
      assert(err.message.includes("args[0]: Date → string"), err.message);
      // A method that throws: no ack tells the app's client, so the ledger
      // tells the test.
      ui.BoomButton.click();
      err = await assertRejects(() => ui.settle(), Error);
      assert(err.message.includes("send-boom"), err.message);
      // An action no method has, and an internal one: refused by the server.
      for (const b of ["UnknownButton", "InternalButton"] as const) {
        ui[b].click();
        err = await assertRejects(() => ui.settle(), Error);
        assert(
          err.message.includes("no method of a cell booted in this test"),
          err.message,
        );
      }
      assertEquals(sent.log.length, 3, "none of those ran the method");
    } finally {
      await ui.dispose();
    }
  });
});
