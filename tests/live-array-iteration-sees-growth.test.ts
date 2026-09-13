// An array iterator reads `length` at EVERY step — in the spec, and on the
// Immer draft a sync method runs on — so a loop sees what it appended.
//
// The async method's live proxy captured the length when the loop began, for
// `for…of` and for `.entries()`/`.keys()`/`.values()` alike. Measured, the
// identical worklist body:
//
//   sync  [1,2,10,20,100,200]   visited 6
//   async [1,2,10,20]           visited 4
//
// The random-program version of this lives in tests/fuzz-ops.ts
// (`arr_for_of_push` and friends), which tests/proxy-differential.test.ts runs.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const shapes: Record<string, (s: Any) => void> = {
  forOf: (s) => {
    for (const n of s.queue) if (n < 100) s.queue.push(n * 10);
  },
  entries: (s) => {
    for (const [, n] of s.queue.entries()) if (n < 100) s.queue.push(n * 10);
  },
  values: (s) => {
    for (const n of s.queue.values()) if (n < 100) s.queue.push(n * 10);
  },
  keys: (s) => {
    for (const i of s.queue.keys()) {
      if (s.queue[i] < 100) s.queue.push(s.queue[i] * 10);
    }
  },
  // Shrinking too: the walk stops where the array now ends.
  shrink: (s) => {
    for (const _n of s.queue) s.queue.pop();
  },
};

for (const [name, body] of Object.entries(shapes)) {
  Deno.test(`live array iteration (${name}): async walks what sync walks`, async () => {
    const sc = cell(`iter_s_${name}`, {
      state: { queue: [1, 2] },
      methods: { run: (s: Any) => body(s) },
    } as Any) as Any;
    const ac = cell(`iter_a_${name}`, {
      state: { queue: [1, 2] },
      methods: {
        // deno-lint-ignore require-await
        async run(s: Any) {
          body(s);
        },
      },
    } as Any) as Any;
    const h = await bootCells([sc, ac]);
    try {
      await sc.run();
      await ac.run();
      await h.settle();
      if (name !== "shrink") {
        assertEquals(sc.queue, [1, 2, 10, 20, 100, 200], "the sync baseline");
      }
      assertEquals(ac.queue, sc.queue);
    } finally {
      h.dispose();
    }
  });
}
