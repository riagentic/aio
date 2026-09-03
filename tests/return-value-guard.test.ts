// Unit coverage for serializeReturn — the guard that vets a method's return
// value before it crosses the wire in an ack frame. JSON-clean values pass
// through; anything that can't survive JSON is coerced to undefined + flagged
// dropped (the transports warn in dev and resolve the caller with undefined
// rather than hanging).
import { assert, assertEquals } from "@std/assert";
import { serializeReturn } from "../src/protocol/return-value.ts";

Deno.test("serializeReturn: undefined passes as undefined, not dropped", () => {
  const r = serializeReturn(undefined);
  assertEquals(r, {
    value: undefined,
    dropped: false,
    lossy: [],
    truncated: false,
  });
});

Deno.test("serializeReturn: primitives round-trip", () => {
  for (const v of [0, 1, -1, 3.14, "hi", "", true, false, null]) {
    const r = serializeReturn(v);
    assertEquals(r.dropped, false);
    assertEquals(r.value, v);
  }
});

Deno.test("serializeReturn: plain objects/arrays round-trip by value", () => {
  const r = serializeReturn({ sum: 5, nested: { a: [1, 2, 3] } });
  assertEquals(r.dropped, false);
  assertEquals(r.value, { sum: 5, nested: { a: [1, 2, 3] } });
});

Deno.test("serializeReturn: a bare function is dropped to undefined", () => {
  const r = serializeReturn(() => 42);
  assertEquals(r, {
    value: undefined,
    dropped: true,
    lossy: [],
    // A dropped value was never walked, so the walk cannot have run out of
    // budget — `truncated` is the pair-property `serializeArgs` already
    // reported and `serializeReturn` used to throw away.
    truncated: false,
  });
});

Deno.test("serializeReturn: BigInt (JSON.stringify throws) is dropped", () => {
  const r = serializeReturn(10n);
  assertEquals(r, {
    value: undefined,
    dropped: true,
    lossy: [],
    // A dropped value was never walked, so the walk cannot have run out of
    // budget — `truncated` is the pair-property `serializeArgs` already
    // reported and `serializeReturn` used to throw away.
    truncated: false,
  });
});

Deno.test("serializeReturn: a circular structure is dropped, never throws", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  const r = serializeReturn(a);
  assertEquals(r, {
    value: undefined,
    dropped: true,
    lossy: [],
    // A dropped value was never walked, so the walk cannot have run out of
    // budget — `truncated` is the pair-property `serializeArgs` already
    // reported and `serializeReturn` used to throw away.
    truncated: false,
  });
});

Deno.test("serializeReturn: functions nested in an object are stripped by JSON", () => {
  // JSON.stringify drops function-valued props silently — the surviving object
  // is clean and transportable, so this is NOT a drop.
  const r = serializeReturn({ keep: 1, fn: () => 0 });
  assertEquals(r.dropped, false);
  assertEquals(r.value, { keep: 1 });
});

Deno.test("serializeReturn: returned value is a fresh clone (no proxy/alias leak)", () => {
  const src = { a: 1 };
  const r = serializeReturn(src);
  assert(
    r.value !== src,
    "must be a JSON round-tripped copy, not the original",
  );
  assertEquals(r.value, { a: 1 });
});

// A value the wire cannot carry at all must be said out loud, in production.
//
// The ack for it is `{ok:true}` with no `value` — on the wire, identical to a
// method that returns nothing — so the client cannot tell either. The server
// is the only place the fact exists. It used to be said at each ack site
// instead of here: `uds.ts` warned always, `server-ws.ts` warned only when
// `!prod`, so in production, over the transport every browser uses, a thrown-
// away return value logged nothing at any level. Its sibling `warnLossy` had
// already settled the question one line below — a corrupted return value is a
// defect either way.
async function warningsDuring(fn: () => void): Promise<string[]> {
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
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
  return seen;
}

Deno.test("serializeReturn: a DROPPED value warns, and names the method", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [() => 1, 10n, circular, Symbol("s")]) {
    const seen = await warningsDuring(() => {
      const r = serializeReturn(value, "cart:checkout");
      assertEquals(r.dropped, true);
      assertEquals(r.value, undefined);
    });
    assertEquals(seen.length, 1, `${String(value)} → ${JSON.stringify(seen)}`);
    assert(seen[0]!.includes("cart:checkout"), seen[0]);
    assert(seen[0]!.includes("resolves with"), seen[0]);
  }
});

Deno.test("serializeReturn: a value that DOES cross says nothing", async () => {
  // The instrument check: the same capture, on a clean value, must be empty —
  // otherwise the assertion above would pass on any noisy logger.
  const seen = await warningsDuring(() => {
    assertEquals(serializeReturn({ ok: 1 }, "cart:checkout").dropped, false);
    assertEquals(serializeReturn(undefined, "cart:checkout").dropped, false);
  });
  assertEquals(seen, []);
});
