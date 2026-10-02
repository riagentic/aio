// `Symbol.iterator in ref` — how a helper asks "is this iterable?" — on a
// reference an async method still holds after its slot became a primitive.
//
// A symbol `in` never throws the stale-reference error (a name does); it
// answers for what the slot holds NOW. With a primitive there, the live proxy
// ran `in` on the primitive itself and the method died on a raw
// `TypeError: Cannot use 'in' operator…`, where it used to answer `false`.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const SLOTS: [string, unknown][] = [
  ["a string", "str"],
  ["a number", 5],
  ["a boolean", true],
  ["null", null],
];

for (const [what, prim] of SLOTS) {
  for (const [shape, init] of [["array", [1]], ["object", { b: 1 }]] as const) {
    Deno.test(`async method: a symbol \`in\` on a held ${shape} whose slot became ${what} answers false`, async () => {
      const out: unknown[] = [];
      const c = cell(`symin_${shape}_${typeof prim}_${prim === null}`, {
        state: { v: null as Any },
        methods: {
          async run(s: Any) {
            await 0;
            s.v = { a: init };
            const held = s.v.a;
            out.push(Symbol.iterator in held);
            s.v.a = prim;
            out.push(Symbol.iterator in held, Symbol.asyncIterator in held);
          },
        },
      });
      const h = await bootCells([c]);
      try {
        await (c as Any).run();
        await h.settle();
      } finally {
        h.dispose();
      }
      assertEquals(out, [shape === "array", false, false]);
    });
  }
}
