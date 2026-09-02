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
];

async function bothWays(c: Case): Promise<{ direct: string; wire: string }> {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  // The comparison has to SEE what JSON does, or it hides the very thing it
  // exists to detect: the first version of this used a bare JSON.stringify on
  // both sides, so `{ gone: undefined }` rendered identically either way and
  // every case passed. A replacer keeps the lossy shapes visible.
  const show = (v: unknown) =>
    JSON.stringify(v ?? null, (_k, val) => {
      if (val === undefined) return "<undefined>";
      if (typeof val === "number" && Object.is(val, -0)) return "<-0>";
      if (typeof val === "bigint") return `<bigint:${val}>`;
      if (val instanceof Map) return `<Map:${JSON.stringify([...val])}>`;
      if (val instanceof Set) return `<Set:${JSON.stringify([...val])}>`;
      if (val instanceof Date) return `<Date:${val.toISOString()}>`;
      if (typeof val === "number" && !Number.isFinite(val)) {
        return `<${String(val)}>`;
      }
      return val;
    });

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
];

async function returnBothWays(
  c: ReturnCase,
): Promise<{ direct: string; wire: string; warnings: string[] }> {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const show = (v: unknown) =>
    JSON.stringify(v ?? null, (_k, val) => {
      if (val === undefined) return "<undefined>";
      if (val instanceof Map) return `<Map:${JSON.stringify([...val])}>`;
      return val;
    });
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
  const acked = new Promise<unknown>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res((f.d as { value?: unknown })?.value);
    };
    setTimeout(() => res("<no ack>"), 2_000);
  });
  ws.send(
    enc("action", { type: "xretb:give", payload: { args: [] }, cid: "c1" }),
  );
  const wire = show(await acked);
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
      assertEquals(
        warnings.some((w) => w.includes("JSON cannot carry intact")),
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
  const ack = new Promise<{ ok?: boolean; value?: unknown }>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res(f.d as { ok?: boolean; value?: unknown });
    };
    setTimeout(() => res({}), 3_000);
  });
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
  const ack = new Promise<{ ok?: boolean; error?: string }>((res) => {
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (f.t === "ack") res(f.d as { ok?: boolean; error?: string });
    };
    setTimeout(() => res({}), 3_000);
  });
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
