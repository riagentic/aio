// `Object.hasOwn(s.map, key)` is THE guard for a map keyed by user input — it
// is how a word count tells "constructor" (a word) from `constructor` (the
// inherited function). On an async method's live view it answered `true` for
// every inherited name on an empty object: the proxy's getOwnPropertyDescriptor
// trap asked `prop in obj`, which walks the prototype chain. So the guarded
// read went ahead, got `Object`, and the method threw "constructor() is not
// supported on live async state" — while the identical sync body (an Immer
// draft, which answers own keys only) counted the word and committed.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let n = 0;
async function bothKinds(
  state: () => Record<string, unknown>,
  body: (s: Any) => unknown,
): Promise<{ sync: string; async: string }> {
  const id = `hasown${n++}`;
  const sc = cell(`${id}_s`, { state: state(), methods: { run: body } });
  const ac = cell(`${id}_a`, {
    state: state(),
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        return body(s);
      },
    },
  });
  const h = await bootCells([sc, ac] as never);
  try {
    const out: string[] = [];
    for (const c of [sc, ac] as Any[]) {
      try {
        const ret = await c.run();
        out.push(
          JSON.stringify({
            ret,
            state: Object.fromEntries(
              Object.keys(state()).map((k) => [k, c[k]]),
            ),
          }),
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

const WORDS = ["a", "constructor", "toString", "valueOf", "a"];

Deno.test("async parity: Object.hasOwn on live state answers OWN keys only", async () => {
  const r = await bothKinds(
    () => ({ w: { a: 1 } }),
    (s) =>
      ["a", "constructor", "toString", "hasOwnProperty", "nope"].map((k) =>
        Object.hasOwn(s.w, k)
      ),
  );
  assertEquals(
    r.sync,
    JSON.stringify({
      ret: [true, false, false, false, false],
      state: { w: { a: 1 } },
    }),
  );
  assertEquals(r.async, r.sync);
});

Deno.test("async parity: a word count guarded by Object.hasOwn commits the same", async () => {
  const r = await bothKinds(() => ({ w: {} }), (s) => {
    for (const k of WORDS) s.w[k] = (Object.hasOwn(s.w, k) ? s.w[k] : 0) + 1;
  });
  assertEquals(r.sync.startsWith("threw"), false, r.sync);
  assertEquals(r.async, r.sync);
});

Deno.test("async parity: getOwnPropertyDescriptor of an inherited name is undefined", async () => {
  const r = await bothKinds(() => ({ w: {} }), (s) => [
    Object.getOwnPropertyDescriptor(s.w, "constructor") === undefined,
    Object.getOwnPropertyDescriptor(s.w, "toString") === undefined,
  ]);
  assertEquals(r.async, r.sync);
});
