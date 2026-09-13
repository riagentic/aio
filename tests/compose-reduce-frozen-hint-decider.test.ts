// The sync reduce's "you mutated frozen state" hint had its own loose regex —
// a bare `read-only` — so a method whose file write failed with EROFS
// ("Read-only file system (os error 30)") was told it had mutated another
// cell's state. It now asks THE decider (immutable.ts `isFrozenWriteError`).
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/testing/cell-test.ts";

const HINT = "in-place mutation of frozen state";
const frozenOutside = Object.freeze({ a: 1 }) as Record<string, number>;

const c = cell("frozenhint", {
  state: { n: 0 },
  methods: {
    erofs(_s: { n: number }) {
      throw new Error("Read-only file system (os error 30): writeFile 'x'");
    },
    realFrozenWrite(_s: { n: number }) {
      frozenOutside.b = 2; // a module is strict: this throws
    },
  },
});

testCell(c, "an EROFS from a method gets no frozen-state hint", async (t) => {
  const err = await assertRejects(() => t.send.erofs(), Error);
  assertStringIncludes(err.message, "Read-only file system");
  assert(
    !err.message.includes(HINT),
    `an EROFS is not a frozen-state write: ${err.message}`,
  );
});

testCell(c, "a real write to a frozen object keeps the hint", async (t) => {
  const err = await assertRejects(() => t.send.realFrozenWrite(), Error);
  assertStringIncludes(err.message, HINT);
});
