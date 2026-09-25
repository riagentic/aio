// An async method that writes, then throws: its earlier writes are NOT rolled
// back (a non-transactional async method commits as it goes). The runtime's
// rejection line used to say "the method threw it, so no state changed" right
// beside `n: 20` — a false sentence in the one place an author looks.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/testing/cell-test.ts";

type S = { n: number };

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const sink = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = sink;
  console.info = sink;
  console.warn = sink;
  return {
    lines,
    restore: () => Object.assign(console, orig),
  };
}

const partial = cell("rej-line-partial", {
  state: { n: 0 } as S,
  methods: {
    async go(s: S) {
      s.n = 10;
      await new Promise((r) => setTimeout(r, 1));
      s.n = 20;
      throw new Error("nope");
    },
  },
});

const tx = cell("rej-line-tx", {
  state: { n: 0 } as S,
  transaction: true,
  methods: {
    async go(s: S) {
      s.n = 10;
      await new Promise((r) => setTimeout(r, 1));
      throw new Error("nope");
    },
  },
});

async function rejectionOf(
  run: () => Promise<unknown>,
): Promise<string> {
  const cap = capture();
  try {
    await run().catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes("rejected: nope"));
  assert(line, `no rejection line in: ${cap.lines.join("\n")}`);
  return line;
}

testCell(
  partial,
  "async throw after writing: the rejection line says the writes stayed",
  async (t) => {
    const line = await rejectionOf(() => t.send.go!());
    assertEquals(t.getState().n, 20, "the earlier writes committed");
    assert(!line.includes("no state changed"), `false claim: ${line}`);
    assertStringIncludes(line, "STAY committed");
  },
);

testCell(
  tx,
  "transactional throw: the rejection line still says no state changed",
  async (t) => {
    const line = await rejectionOf(() => t.send.go!());
    assertEquals(t.getState().n, 0, "the transaction rolled back");
    assertStringIncludes(line, "no state changed");
  },
);
