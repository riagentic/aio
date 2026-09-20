// A key named `__proto__` in cell state, from inside a method.
//
// It can only reach state as parsed JSON data (`JSON.parse` makes it an own
// data key; `deep-merge` restores it the same way). Two things about it were
// wrong in the error text, never in what was refused:
//
//  • a SYNC method assigning it (`s.c["__proto__"] = v`) was told
//    "Object.defineProperty(…) cannot be used on cell state … Assign instead"
//    — it HAD assigned. Deno's `__proto__` setter turns an assignment into a
//    defineProperty, which the Immer draft refuses; the message blamed a call
//    the author never wrote and prescribed the spelling that just failed.
//  • an ASYNC method whose write ran through that key (`s.y = { ...s.m }`,
//    `delete s.m.__proto__`, `s.m.__proto__.a = 1`) was refused at commit as
//    "[aio:cell] blocked unsafe mutation — path contains the banned key
//    __proto__, a non-string segment, or exceeds depth (path=["y"])": no cell,
//    no method, a list of three possible causes, and for the spread a path
//    that does not even contain the key.
//
// The async side stays STRICTER than the sync one (decided: a write-set path
// through `__proto__` is refused whatever its source). What these pin is that
// both refusals say what happened, where, and what to do instead.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function run(
  id: string,
  kind: "sync" | "async",
  state: () => Record<string, unknown>,
  body: (s: Any) => void,
): Promise<{ err: string; state: Any }> {
  const c = cell(id, {
    state: state(),
    methods: kind === "sync" ? { run: body } : {
      // deno-lint-ignore require-await
      async run(s: Any) {
        body(s);
      },
    },
  });
  const h = await bootCells([c] as never);
  let err = "";
  try {
    try {
      await (c as Any).run();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    await h.settle();
    const snap = JSON.parse(
      JSON.stringify(
        Object.fromEntries(Object.keys(state()).map((k) => [k, c[k as never]])),
      ),
    );
    return { err, state: snap };
  } finally {
    h.dispose();
  }
}

const withProtoKey = () => ({
  m: JSON.parse('{"__proto__":{"a":1},"b":2}'),
  y: null as unknown,
});

Deno.test("sync: assigning a key named __proto__ is refused as an ASSIGNMENT, not as a defineProperty call", async () => {
  const r = await run("pk_sync_assign", "sync", () => ({ c: {} }), (s) => {
    s.c["__proto__"] = { x: 1 };
  });
  assertStringIncludes(r.err, "[pk_sync_assign:run]");
  assertStringIncludes(r.err, 'a key named "__proto__"');
  // It must not prescribe the very thing that just failed.
  assertEquals(r.err.includes("Assign instead"), false, r.err);
  assertEquals(r.err.includes("Object.defineProperty"), false, r.err);
  assertEquals(r.state, { c: {} });
});

Deno.test("sync: a real Object.defineProperty call keeps its own message", async () => {
  const r = await run("pk_sync_dp", "sync", () => ({ c: {} }), (s) => {
    Object.defineProperty(s.c, "k", { value: 1, enumerable: true });
  });
  assertStringIncludes(r.err, "Object.defineProperty");
  assertStringIncludes(r.err, "Assign instead");
});

Deno.test("sync: a real defineProperty inside a helper whose NAME contains __proto__ keeps its own message", async () => {
  function strip__proto__Keys(o: Any) {
    Object.defineProperty(o, "k", { value: 1, enumerable: true });
  }
  const r = await run("pk_sync_named", "sync", () => ({ c: {} }), (s) => {
    strip__proto__Keys(s.c);
  });
  assertStringIncludes(r.err, "Object.defineProperty");
  assertEquals(r.err.includes('a key named "__proto__"'), false, r.err);
});

Deno.test("async: assigning a key named __proto__ is refused by name, cell, method and path", async () => {
  const r = await run("pk_async_assign", "async", () => ({ c: {} }), (s) => {
    s.c["__proto__"] = { x: 1 };
  });
  assertStringIncludes(r.err, "[pk_async_assign:run]");
  assertStringIncludes(r.err, 'a key named "__proto__"');
  assertStringIncludes(r.err, "s.c.__proto__");
  assertEquals(r.state, { c: {} });
});

const asyncCases: [string, (s: Any) => void, string][] = [
  ["spread", (s) => (s.y = { ...s.m }), "s.y.__proto__"],
  [
    "fromEntries",
    (s) => (s.y = Object.fromEntries(Object.entries(s.m))),
    "s.y.__proto__",
  ],
  ["delete", (s) => delete s.m.__proto__, "s.m.__proto__"],
  ["write-inside", (s) => (s.m["__proto__"].a = 5), "s.m.__proto__.a"],
  ["alias-of-it", (s) => (s.y = s.m["__proto__"]), "s.m.__proto__"],
];

for (const [name, body, at] of asyncCases) {
  Deno.test(`async: a write through a JSON "__proto__" key (${name}) is refused clearly, and does not land`, async () => {
    const id = `pk_async_${name.replace(/-/g, "_")}`;
    const r = await run(id, "async", withProtoKey, body);
    assertStringIncludes(r.err, `[${id}:run]`);
    assertStringIncludes(r.err, 'a key named "__proto__"');
    assertStringIncludes(r.err, at);
    // The fix, not just the refusal.
    assertStringIncludes(r.err, "rename the key");
    assertEquals(r.err.includes("non-string segment"), false, r.err);
    assertEquals(r.state, {
      m: JSON.parse('{"__proto__":{"a":1},"b":2}'),
      y: null,
    });
  });
}

Deno.test("async: the same state still reads, writes siblings, and takes plain JSON with the key", async () => {
  const r = await run("pk_async_ok", "async", withProtoKey, (s) => {
    s.m.b = s.m["__proto__"].a + 2;
    s.y = JSON.parse('{"__proto__":{"a":9}}');
  });
  assertEquals(r.err, "");
  assertEquals(r.state.m.b, 3);
  assertEquals(Object.keys(r.state.y), ["__proto__"]);
});

Deno.test("sync: the same writes through a JSON __proto__ key still commit (the async side is the stricter one)", async () => {
  const r = await run("pk_sync_ok", "sync", withProtoKey, (s) => {
    s.y = { ...s.m };
  });
  assertEquals(r.err, "");
  assertEquals(Object.keys(r.state.y).sort(), ["__proto__", "b"]);
});

// The refusal is a THROW at the write, so it behaves like any throw in an
// async method: writes made BEFORE it are the method's own and commit, as
// they do before a plain `throw`. (It used to be refused at the commit, which
// dropped the earlier writes with it — the one refusal that did.)
Deno.test("async: writes before a refused __proto__ write commit, exactly as before a plain throw", async () => {
  const refused = await run("pk_async_partial", "async", withProtoKey, (s) => {
    s.m.b = 7;
    s.m["__proto__"].a = 5;
  });
  const thrown = await run("pk_async_partial_t", "async", withProtoKey, (s) => {
    s.m.b = 7;
    throw new Error("plain");
  });
  assertStringIncludes(refused.err, 'a key named "__proto__"');
  assertEquals(thrown.err, "plain");
  assertEquals(refused.state.m.b, thrown.state.m.b);
  assertEquals(refused.state.m["__proto__"].a, 1);
});
