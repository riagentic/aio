// `constructor` and `prototype` are ordinary state KEYS — a dictionary of
// words, a map keyed by user input — and an async method refused every write
// that touched one.
//
// The async write-set gate (`isSafeMutationPath`, cell-impl.ts) banned the
// three names outright. The identical body declared sync ran on an Immer draft
// and committed; declared `async`, it threw "blocked unsafe mutation" and the
// method rejected. One body, two outcomes — the sync/async parity CLAUDE.md
// promises. The client applier had already learned this (state-message.ts:
// "a dictionary holding the word constructor"); the server's async path had
// not. Measured through a trojan POST: `setk("constructor", 5)` → 200 on the
// sync twin, 400 REDUCE_ERROR on the async one.
//
// What the ban was FOR still holds: a crafted path must not walk the prototype
// chain (`["constructor", "prototype", "x"]` on a plain object reaches
// `Object.prototype`). That is now refused by what it DOES — a segment that is
// not the tree's own key and resolves to something anyway — instead of by
// name, which also closes `["m", "toString", "x"]` (a write onto the shared
// builtin `Object.prototype.toString`), a path the name list let through.
import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { applyMutations } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let n = 0;
/** Run one body as a sync method and as an async one; return both outcomes. */
async function bothKinds(
  state: () => Record<string, unknown>,
  body: (s: Any) => void,
): Promise<{ sync: string; async: string }> {
  const id = `ctorkey${n++}`;
  const sc = cell(`${id}_s`, { state: state(), methods: { run: body } });
  const ac = cell(`${id}_a`, {
    state: state(),
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        body(s);
      },
    },
  });
  const h = await bootCells([sc, ac] as never);
  try {
    const out: string[] = [];
    for (const c of [sc, ac] as Any[]) {
      try {
        await c.run();
        out.push(
          JSON.stringify(
            Object.fromEntries(Object.keys(state()).map((k) => [k, c[k]])),
          ),
        );
      } catch (e) {
        out.push(`threw: ${(e as Error).message}`);
      }
    }
    await h.settle();
    return { sync: out[0]!, async: out[1]! };
  } finally {
    h.dispose();
  }
}

const CASES: [string, () => Record<string, unknown>, (s: Any) => void][] = [
  ["set a `constructor` key", () => ({ m: {} }), (s) => {
    s.m["constructor"] = 5;
  }],
  ["set a `prototype` key", () => ({ m: {} }), (s) => {
    s.m["prototype"] = 5;
  }],
  [
    "write inside an own `constructor` object",
    () => ({ m: { constructor: { a: 1 } } }),
    (s) => {
      s.m["constructor"].a = 2;
    },
  ],
  [
    "push onto an own `constructor` array",
    () => ({ m: { constructor: [1] } }),
    (s) => {
      s.m["constructor"].push(2);
    },
  ],
  [
    "delete an own `constructor` key",
    () => ({ m: { constructor: 1, x: 1 } }),
    (s) => {
      delete s.m["constructor"];
    },
  ],
  ["key a map by user words, reserved-looking ones included", () => ({
    w: {},
  }), (s) => {
    for (const k of ["a", "prototype", "constructor", "toString"]) s.w[k] = 1;
  }],
];

for (const [name, state, body] of CASES) {
  Deno.test(`async parity: ${name} commits as it does in a sync method`, async () => {
    const r = await bothKinds(state, body);
    assertEquals(r.sync.startsWith("threw"), false, r.sync);
    assertEquals(r.async, r.sync);
  });
}

Deno.test("async parity: a path through the PROTOTYPE CHAIN is still refused", () => {
  for (
    const path of [
      ["constructor", "prototype", "pwnedA"],
      ["m", "constructor", "prototype", "pwnedA"],
      ["m", "toString", "pwnedA"],
      ["m", "hasOwnProperty", "pwnedA"],
    ]
  ) {
    const state: Record<string, unknown> = { m: {} };
    assertThrows(
      () => applyMutations(state, [{ path, value: 1 }]),
      Error,
      "blocked unsafe mutation",
      JSON.stringify(path),
    );
  }
  // An array op and a live reference addressed the same way.
  assertThrows(
    () =>
      applyMutations({ m: {} }, [
        { path: ["m", "constructor", "prototype"], op: "push", args: [1] },
      ]),
    Error,
    "blocked unsafe mutation",
  );
  assertThrows(
    () =>
      applyMutations({ m: {}, b: {} }, [
        {
          path: ["b"],
          value: {},
          refs: [{ at: ["x"], ref: ["m", "toString"] }],
        },
      ]),
    Error,
    "blocked unsafe mutation",
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((Object.prototype as any).pwnedA, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals((Object.prototype.toString as any).pwnedA, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals((Object.prototype.hasOwnProperty as any).pwnedA, undefined);
});
