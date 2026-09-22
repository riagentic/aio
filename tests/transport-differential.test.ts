// The same call, in-process and over a real socket, must land the same state.
//
// `testUI`/`testCell`/`bootCells` never cross a transport, so a structured-clone
// hop, a JSON round trip and a client-context replay are all invisible to them.
// That gap is tracked in todo.md, and this release already paid for it twice:
// `appFlags` shipped dead with five green tests because every one of them
// called the helper directly, and the hook guard warned on every boot of every
// app while every unit test of the validator passed.
//
// This is the differential shape the repo already trusts for sync/async parity
// (tests/proxy-differential.test.ts): run the SAME scenario both ways and
// compare, rather than write two sets of expectations that can drift apart.
// A divergence here is either a real bug or a documented limit — and if it is a
// limit, the harness must be the STRICTER side, because a test that accepts
// what the wire cannot carry manufactures green-test-broken-prod.
import { assertEquals, assertNotEquals } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Render a value so JSON's losses stay visible on BOTH sides of a differential.
 *
 *  A bare `JSON.stringify` hides the seams this file exists to catch (`undefined`
 *  members vanish identically either way; a `Date`'s `toJSON` makes in-process
 *  and wire look the same). Top-level BigInt/undefined/Date/RegExp/Map/Set are
 *  named before stringify — BigInt throws, `Date.toJSON` would otherwise erase
 *  the instanceof seam, and RegExp/Map/Set collapse to `{}`. */
function show(v: unknown): string {
  if (v === undefined) return '"<undefined>"';
  if (typeof v === "bigint") return JSON.stringify(`<bigint:${v}>`);
  if (v instanceof Date) return JSON.stringify(`<Date:${v.toISOString()}>`);
  if (v instanceof RegExp) return JSON.stringify(`<RegExp:${v}>`);
  if (v instanceof Map) {
    return JSON.stringify(`<Map:${JSON.stringify([...v])}>`);
  }
  if (v instanceof Set) {
    return JSON.stringify(`<Set:${JSON.stringify([...v])}>`);
  }
  return JSON.stringify(v, (_k, val) => {
    if (val === undefined) return "<undefined>";
    if (typeof val === "number" && Object.is(val, -0)) return "<-0>";
    if (typeof val === "bigint") return `<bigint:${val}>`;
    if (val instanceof Map) return `<Map:${JSON.stringify([...val])}>`;
    if (val instanceof Set) return `<Set:${JSON.stringify([...val])}>`;
    if (typeof val === "number" && !Number.isFinite(val)) {
      return `<${String(val)}>`;
    }
    return val;
  });
}

/** One scenario: a payload, dispatched both ways. */
type Case = {
  name: string;
  payload: unknown;
  /** What the wire makes of it, when it legitimately cannot carry the value.
   *
   *  These are JSON's documented losses, not aio defects — but leaving them
   *  unpinned means the harness quietly accepts a shape production does not
   *  have, which is the lenient-test half of green-test-broken-prod. Pinned,
   *  they are executable documentation: a change in EITHER direction (the wire
   *  learning to carry it, or a new loss appearing) turns this red. */
  wireBecomes?: string;
};

const CASES: Case[] = [
  { name: "primitives", payload: { n: 1, s: "x", b: true, nil: null } },
  { name: "nested arrays", payload: { rows: [[1, 2], [3, [4, 5]]] } },
  { name: "empty containers", payload: { arr: [], obj: {} } },
  { name: "unicode + quotes", payload: { s: 'a"b\\c\ndé\u{1F600}' } },
  {
    name: "big-ish array",
    payload: { xs: Array.from({ length: 500 }, (_, i) => i) },
  },
  // Measured divergences. `undefined` in an object survives in-process and the
  // KEY ITSELF is gone over the wire — so `"gone" in state` is true in a test
  // and false in a browser. `-0` arrives as `0`, so `Object.is(x, -0)` differs.
  // Both are JSON, both are real, and both are now facts rather than surprises.
  {
    name: "undefined member",
    payload: { a: 1, gone: undefined },
    wireBecomes: '{"a":1}',
  },
  {
    name: "-0 and big numbers",
    payload: { z: -0, big: 9007199254740991 },
    wireBecomes: '{"z":0,"big":9007199254740991}',
  },
  // Array slots keep their place: `undefined` becomes `null`, so `xs[1] ===
  // undefined` is true in-process and false over the wire. Distinct from the
  // object-member case above (key vanishes entirely).
  {
    name: "undefined in array",
    payload: { xs: [1, undefined, 3] },
    wireBecomes: '{"xs":[1,null,3]}',
  },
  // NaN / ±Infinity all become null. A harness test that branches on
  // Number.isNaN(state.n) is green-test-broken-prod.
  {
    name: "NaN and ±Infinity",
    payload: { n: NaN, i: Infinity, ni: -Infinity },
    wireBecomes: '{"n":null,"i":null,"ni":null}',
  },
  // Set (and Map) stringify as {}. Contents are gone; `got.s instanceof Set`
  // is true in-process and false on the wire.
  {
    name: "a Set",
    payload: { s: new Set([1, 2]) },
    wireBecomes: '{"s":{}}',
  },
];

async function bothWays(c: Case): Promise<{ direct: string; wire: string }> {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const mk = (id: string) =>
    cell(id, {
      state: { got: null as unknown },
      methods: {
        take(s: { got: unknown }, v: unknown) {
          s.got = v;
        },
      },
    });

  // ── in-process ──
  _resetAioRuntime();
  const a = mk("xdiffa");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  await bootCells([a] as never);
  (a as unknown as { take: (v: unknown) => void }).take(c.payload);
  await new Promise((r) => setTimeout(r, 20));
  const direct = show((a as unknown as { got: unknown }).got);

  // ── over a real WebSocket ──
  _resetAioRuntime();
  const b = mk("xdiffb");
  const port = freePort();
  const app = await aio.run({
    cells: [b],
    appId: `xdiff-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  ws.send(
    enc("action", { type: "xdiffb:take", payload: { args: [c.payload] } }),
  );
  await new Promise((r) => setTimeout(r, 250));
  const wire = show((b as unknown as { got: unknown }).got);
  ws.close();
  await handle.close();
  return { direct, wire };
}

for (const c of CASES) {
  Deno.test(`transport differential: ${c.name}`, async () => {
    const { direct, wire } = await bothWays(c);
    if (c.wireBecomes !== undefined) {
      assertEquals(
        wire,
        c.wireBecomes,
        `the wire's treatment of this payload CHANGED\n` +
          `  in-process: ${direct}\n  over wire : ${wire}\n  pinned    : ${c.wireBecomes}`,
      );
      // …and the divergence must still BE one. Without this the known-loss
      // list rots into a tautology the day the two sides happen to agree.
      assertNotEquals(
        wire,
        direct,
        `${c.name} no longer diverges — the wire carries it now. Good news: ` +
          `drop wireBecomes and let it assert equality.`,
      );
      return;
    }
    assertEquals(
      wire,
      direct,
      `the same call landed different state in-process vs over the wire\n` +
        `  in-process: ${direct}\n  over wire : ${wire}`,
    );
  });
}

// Date: show() JSON-ifies both sides to the same ISO string, which HIDES the
// real seam — in-process `got.when instanceof Date` is true; over the wire it
// is a string. Harness tests that branch on Date are green-test-broken-prod.
Deno.test("transport differential: Date is an instance in-process and a string on the wire", async () => {
  const when = new Date("2026-09-15T10:00:00.000Z");
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const { freePort } = await import("../src/testing/server-test.ts");
  const { enc } = await import("../src/protocol/envelope.ts");

  _resetAioRuntime();
  const a = cell("xdati", {
    state: { got: null as unknown },
    methods: {
      take(s: { got: unknown }, v: unknown) {
        s.got = v;
      },
    },
  });
  await bootCells([a] as never);
  (a as unknown as { take: (v: unknown) => void }).take({ when });
  await new Promise((r) => setTimeout(r, 20));
  const directWhen = (a as unknown as { got: { when: unknown } }).got?.when;
  assertEquals(directWhen instanceof Date, true, "in-process must keep Date");

  _resetAioRuntime();
  const b = cell("xdatw", {
    state: { got: null as unknown },
    methods: {
      take(s: { got: unknown }, v: unknown) {
        s.got = v;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("xdat-");
  try {
    const app = await aio.run({
      cells: [b],
      appId: `xdat-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
    } as never);
    const handle = app as unknown as {
      port: number;
      close: () => Promise<void>;
    };
    const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws never opened"));
    });
    ws.send(
      enc("action", { type: "xdatw:take", payload: { args: [{ when }] } }),
    );
    await new Promise((r) => setTimeout(r, 250));
    const wireWhen = (b as unknown as { got: { when: unknown } }).got?.when;
    assertEquals(typeof wireWhen, "string", "wire must JSON-encode Date");
    assertEquals(wireWhen, when.toISOString());
    ws.close();
    await handle.close();
  } finally {
    await dropTempDir(dir);
  }
});

// ── the RETURN value, which travels the other way ───────────────────────────
//
// A method's return reaches an in-process caller as the object it returned, and
// a socket caller through `serializeReturn` in an `ack` frame. That path
// already has a guard (it warns that "the caller resolves with undefined" for a
// non-serializable return), which is more than state had — so this pins the
// contract rather than expecting a bug: JSON-safe values must round-trip
// identically, and the lossy ones must degrade the way the guard says.

type ReturnCase = {
  name: string;
  returns: unknown;
  wireBecomes?: string;
  /** The value changing silently is the bug; changing loudly is the design. */
  warns?: true;
};

const RETURN_CASES: ReturnCase[] = [
  { name: "plain object", returns: { ok: true, n: 3, xs: [1, 2] } },
  { name: "string", returns: "hello" },
  { name: "null", returns: null },
  // A Map SURVIVES JSON.stringify as `{}` — it does not throw, so it is not
  // "dropped"; it is silently emptied. The return path already knows this
  // (`findLossy`: "Date → ISO string, Map/Set/RegExp/Error → {}") and warns
  // loudly in dev AND prod that "the caller receives a DIFFERENT value than
  // the method returned". So the contract is the `{}` AND the warning: an
  // unwarned `{}` would be the bug. This pin was written expecting `null` and
  // was wrong — the framework is better than the guess.
  {
    name: "a Map",
    returns: new Map([["k", 1]]),
    wireBecomes: "{}",
    warns: true,
  },
  {
    name: "a Set",
    returns: new Set([1, 2]),
    wireBecomes: "{}",
    warns: true,
  },
  // Date → ISO string (lossy, warned). show() names the in-process Date so the
  // seam is not hidden by Date.toJSON agreeing with the wire.
  {
    name: "a Date",
    returns: new Date("2026-09-15T10:00:00.000Z"),
    wireBecomes: '"2026-09-15T10:00:00.000Z"',
    warns: true,
  },
  // NaN → null (lossy, warned). Number.isNaN(ret) is true in-process, false
  // over the wire.
  {
    name: "NaN",
    returns: NaN,
    wireBecomes: "null",
    warns: true,
  },
  // BigInt cannot cross at all — serializeReturn drops to undefined and warns
  // "AT ALL" (not "intact"). An unwarned undefined would look like a void method.
  {
    name: "BigInt",
    returns: 42n,
    wireBecomes: '"<undefined>"',
    warns: true,
  },
];

async function returnBothWays(
  c: ReturnCase,
): Promise<{ direct: string; wire: string; warnings: string[] }> {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const mk = (id: string, v: unknown) =>
    cell(id, {
      state: { n: 0 },
      methods: {
        give(s: { n: number }) {
          s.n++;
          return v;
        },
      },
    });

  _resetAioRuntime();
  const a = mk("xretа".replace("а", "a"), c.returns);
  await bootCells([a] as never);
  const direct = show(
    await (a as unknown as { give: () => Promise<unknown> }).give(),
  );

  _resetAioRuntime();
  const b = mk("xretb", c.returns);
  const app = await aio.run({
    cells: [b],
    appId: `xret-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: freePort(),
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const warnings: string[] = [];
  const prevLog = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, m: string) => {
        if (lvl === "warn") warnings.push(m);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  let noAck: ReturnType<typeof setTimeout> | undefined;
  const acked = new Promise<unknown>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res((f.d as { value?: unknown })?.value);
    };
    noAck = setTimeout(() => res("<no ack>"), 2_000);
  });
  ws.send(
    enc("action", { type: "xretb:give", payload: { args: [] }, cid: "c1" }),
  );
  const wire = show(await acked);
  clearTimeout(noAck); // the ack won — its deadline goes too
  ws.close();
  setLogger(prevLog);
  await handle.close();
  return { direct, wire, warnings };
}

for (const c of RETURN_CASES) {
  Deno.test(`return differential: ${c.name}`, async () => {
    const { direct, wire, warnings } = await returnBothWays(c);
    if (c.warns) {
      // The value changing silently is the bug; changing LOUDLY is the design.
      // "intact" (lossy) and "AT ALL" (dropped) are both the loud contract;
      // either substring means the change was named rather than silent.
      assertEquals(
        warnings.some((w) => w.includes("JSON cannot carry")),
        true,
        `the return was altered without a word:\n${
          warnings.join("\n") || "(no warnings)"
        }`,
      );
    }
    if (c.wireBecomes !== undefined) {
      assertEquals(
        wire,
        c.wireBecomes,
        `the wire's treatment of this RETURN changed\n  in-process: ${direct}\n  over wire : ${wire}`,
      );
      assertNotEquals(
        wire,
        direct,
        `${c.name} no longer diverges — drop the pin`,
      );
      return;
    }
    assertEquals(
      wire,
      direct,
      `the same method returned different values in-process vs over the wire\n` +
        `  in-process: ${direct}\n  over wire : ${wire}`,
    );
  });
}

// ── async methods, including the one that throws ────────────────────────────
//
// An async method resolves for an in-process caller as a promise, and for a
// socket caller as an `ack` — but ONLY if the dispatch carries `_callId`.
// aio-server.ts is explicit about this: "an ASYNC method carries `_callId`; the
// executor resolves that id with the method's RETURN value when it completes …
// SYNC/void methods have no `_callId`; dispatch() already resolves with their
// value". A client that omits it gets the early reduce result and no
// correlation, which is the contract, not a bug — the first version of these
// tests omitted it and read the result as two serious defects.
//
// The failure path is the interesting half: in-process a throw REJECTS, over
// the wire it becomes `{ ok: false, error }`. The shapes differ; what matters
// is that both callers learn the same thing.

Deno.test("async differential: state lands the same, and the ack waits for it", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");

  const mk = (id: string) =>
    cell(id, {
      state: { done: false, n: 0 },
      methods: {
        async work(s: { done: boolean; n: number }, by: number) {
          await new Promise((r) => setTimeout(r, 40));
          s.done = true;
          s.n += by;
          return { finished: true, n: s.n };
        },
      },
    });

  _resetAioRuntime();
  const a = mk("xasynca");
  await bootCells([a] as never);
  const directRet = await (a as unknown as {
    work: (n: number) => Promise<unknown>;
  }).work(5);
  const directState = JSON.stringify({
    done: (a as unknown as { done: boolean }).done,
    n: (a as unknown as { n: number }).n,
  });

  _resetAioRuntime();
  const b = mk("xasyncb");
  const app = await aio.run({
    cells: [b],
    appId: `xasync-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: freePort(),
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  let noAck: ReturnType<typeof setTimeout> | undefined;
  const ack = new Promise<{ ok?: boolean; value?: unknown }>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res(f.d as { ok?: boolean; value?: unknown });
    };
    noAck = setTimeout(() => res({}), 3_000);
  }).finally(() => clearTimeout(noAck));
  ws.send(
    enc("action", {
      type: "xasyncb:work",
      // `_callId` is what asks the executor to resolve with the RETURN value.
      payload: { args: [5], _callId: "a1" },
      cid: "a1",
    }),
  );
  const acked = await ack;
  // The ack must arrive AFTER the await inside the method, or a caller that
  // waits on it reads state that has not landed yet.
  const wireState = JSON.stringify({
    done: (b as unknown as { done: boolean }).done,
    n: (b as unknown as { n: number }).n,
  });
  ws.close();
  await handle.close();

  assertEquals(wireState, directState, "async state diverged across the wire");
  assertEquals(acked.ok, true, "the async ack did not report success");
  assertEquals(
    JSON.stringify(acked.value),
    JSON.stringify(directRet),
    "the async RETURN diverged across the wire",
  );
});

Deno.test("async differential: a throw reaches both callers, by their own means", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");

  const mk = (id: string) =>
    cell(id, {
      state: { n: 0 },
      methods: {
        async boom(_s: { n: number }) {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error("deliberate: xdiff boom");
        },
      },
    });

  _resetAioRuntime();
  const a = mk("xthrowa");
  await bootCells([a] as never);
  let directMsg = "";
  try {
    await (a as unknown as { boom: () => Promise<unknown> }).boom();
  } catch (e) {
    directMsg = (e as Error).message;
  }

  _resetAioRuntime();
  const b = mk("xthrowb");
  const app = await aio.run({
    cells: [b],
    appId: `xthrow-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: freePort(),
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  let noAck: ReturnType<typeof setTimeout> | undefined;
  const ack = new Promise<{ ok?: boolean; error?: string }>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res(f.d as { ok?: boolean; error?: string });
    };
    noAck = setTimeout(() => res({}), 3_000);
  }).finally(() => clearTimeout(noAck));
  ws.send(
    enc("action", {
      type: "xthrowb:boom",
      payload: { args: [], _callId: "t1" },
      cid: "t1",
    }),
  );
  const acked = await ack;
  ws.close();
  await handle.close();

  // Both callers must LEARN of the failure — the shapes differ (a rejection
  // vs `{ok:false,error}`), the knowledge must not.
  assertEquals(
    directMsg.includes("boom"),
    true,
    `the in-process caller was not told: ${directMsg || "(resolved!)"}`,
  );
  assertEquals(
    acked.ok,
    false,
    "the socket caller was told the call SUCCEEDED",
  );
  assertEquals(
    String(acked.error ?? "").includes("boom"),
    true,
    `the socket caller got no usable reason: ${acked.error}`,
  );
});

// BigInt is not a JSON *loss* — JSON.stringify THROWS. So `enc()` cannot even
// build the frame: in-process the payload lands as a bigint; over the wire the
// send never happens. Distinct from the return path (serializeReturn drops to
// undefined and warns "AT ALL"). Carrying BigInt on the wire would be a
// contract break → v2; this pin documents the refusal.
Deno.test("transport differential: BigInt payload lands in-process; enc refuses to send", async () => {
  const { cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");

  _resetAioRuntime();
  const a = cell("xbigi", {
    state: { got: null as unknown },
    methods: {
      take(s: { got: unknown }, v: unknown) {
        s.got = v;
      },
    },
  });
  await bootCells([a] as never);
  (a as unknown as { take: (v: unknown) => void }).take({ b: 1n });
  await new Promise((r) => setTimeout(r, 20));
  const direct = (a as unknown as { got: { b: unknown } }).got?.b;
  assertEquals(typeof direct, "bigint", "in-process must keep BigInt");
  assertEquals(direct, 1n);

  let threw = "";
  try {
    enc("action", {
      type: "xbigw:take",
      payload: { args: [{ b: 1n }] },
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  assertEquals(
    /bigint/i.test(threw),
    true,
    `enc must refuse a BigInt payload, got: ${threw || "(no throw)"}`,
  );
  // Every other test in this file resets at the END as well as the start, and
  // this one did not. Reading `a.got` above is a tracked read, which arms the
  // 16ms subscription-sync timer; the test then does only sync work, so the
  // timer was still pending at teardown and the leak sanitizer failed the
  // test — under the shard runner only, where the sanitizers are on.
  _resetAioRuntime();
});

// ── client-context replay of a sync method ──────────────────────────────────
//
// Closed in `tests/transport-differential-browser.test.ts`: the same sync
// method invoked from a real browser UI vs in-process, state + return compared,
// JSON losses pinned with `wireBecomes`, via existing `withE2E` (skips when no
// Chromium). Kept as its own file so an ignored empty Deno.test here cannot
// break check:vacuous, and so the e2e dependency stays optional.
