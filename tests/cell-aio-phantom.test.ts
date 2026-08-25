// `cell.__aio.methods` never existed, but it was typed — so reaching for it
// returned `undefined`, and a test guarded with `typeof fn === "function"`
// passed while asserting nothing (field report §4.2: two sat green that way). Under
// the harness a phantom `__aio` read now throws, naming the supported path.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { _armTestStrict } from "../src/testing/test-strict.ts";

const c = cell("phantom-probe", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
    },
  },
});

Deno.test("__aio: a phantom key throws under the harness, naming testCell", () => {
  _armTestStrict();
  const aio = c.__aio as unknown as Record<string, unknown>;
  const err = assertThrows(() => aio.methods, Error);
  assert(err.message.includes("[cell:phantom-probe]"), err.message);
  assert(err.message.includes("__aio.methods does not exist"), err.message);
  assert(err.message.includes("testCell"), err.message);
  assertThrows(() => aio.syncMethods, Error);
  assertThrows(() => aio.dispatchRaw, Error);
});

Deno.test("__aio: declared-but-absent slots and writes stay ordinary", () => {
  _armTestStrict();
  const aio = c.__aio as unknown as Record<string, unknown>;
  assertEquals(aio.execute, undefined, "optional slot, absent — not a phantom");
  assert(aio.worker === undefined || aio.worker === false, "declared slot");
  assertEquals(aio.persist, undefined);
  assert(aio.asyncMethods instanceof Set, "the real slot for method names");
  assertEquals(typeof aio.then, "undefined", "await-probe is not a phantom");
  assertEquals(JSON.stringify({ id: aio.id }), '{"id":"phantom-probe"}');
  // Writes pass through (cell-catalog sets `bound = true` on bind).
  aio.bound = true;
  assertEquals(aio.bound, true);
  aio.bound = false;
});

Deno.test("__aio: prod answers like the plain object (dev stricter, never the reverse)", () => {
  const g = globalThis as Record<string, unknown>;
  const was = g.__aioDev;
  g.__aioDev = false;
  try {
    const aio = c.__aio as unknown as Record<string, unknown>;
    assertEquals(aio.methods, undefined);
  } finally {
    g.__aioDev = was;
  }
});
