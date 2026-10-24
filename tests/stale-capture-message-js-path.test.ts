// The stale-reference refusal suggests a fix as code — `const x =
// s.items.0?.field` is not JavaScript. Paths are written the way the author
// writes them: `s.items[0]`, `s.m["a-b"]`.
import { assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";

const c = cell("stale_js_path", {
  state: {
    items: [{ v: 1 }, { v: 2 }],
    m: { "a-b": { v: 1 } } as Record<string, { v: number }>,
  },
  methods: {
    // deno-lint-ignore require-await
    async swap(s) {
      const a = s.items[0]!;
      s.items[0] = s.items[1]!;
      s.items[1] = a;
    },
    // deno-lint-ignore require-await
    async odd(s) {
      const a = s.m["a-b"]!;
      s.m["a-b"] = { v: 2 };
      s.m.x = a;
    },
  },
});

testCell(c, "array index path reads as s.items[0]", async (t) => {
  await assertRejects(
    () => t.send.swap(),
    Error,
    "captured from s.items[0] before the method overwrote s.items[0]. " +
      "In an async method `s` is a live view — the old reference would " +
      "silently resolve to the NEW value (a sync method keeps the old " +
      "object). Copy what you need before overwriting " +
      "(const x = s.items[0]?.field) or snapshot first " +
      "(const v = { ...s.items[0] })",
  );
});

testCell(c, 'a non-identifier key reads as s.m["a-b"]', async (t) => {
  await assertRejects(() => t.send.odd(), Error, 'captured from s.m["a-b"]');
});
