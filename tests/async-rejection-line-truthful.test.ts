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
  needle = "rejected: nope",
): Promise<string> {
  const cap = capture();
  try {
    await run().catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes(needle));
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

// The only write-set the method made was REFUSED by `validate`, so nothing
// changed — the line said "those earlier writes STAY committed" anyway,
// because it asked whether a write-set was DISPATCHED, not whether one landed.
const refused = cell("rej-line-refused", {
  state: { n: 0 } as S,
  validate: (s: S) => s.n >= 0 || "nope",
  methods: {
    async go(s: S) {
      await new Promise((r) => setTimeout(r, 1));
      s.n = -1;
    },
  },
});

testCell(
  refused,
  "async write refused by validate: the rejection line says no state changed",
  async (t) => {
    const line = await rejectionOf(() => t.send.go!(), "failed: nope");
    assertEquals(t.getState().n, 0, "the refused write never landed");
    assertStringIncludes(line, "no state changed");
  },
);

// A transaction that published with `s.$commit()` and THEN threw: the commit
// stays (n === 1), and the line said "no state changed".
const txCommitted = cell("rej-line-tx-commit", {
  state: { n: 0 } as S,
  transaction: true,
  methods: {
    async go(s: S & { $commit(): void }) {
      s.n = 1;
      s.$commit();
      await new Promise((r) => setTimeout(r, 1));
      s.n = 2;
      throw new Error("nope");
    },
  },
});

testCell(
  txCommitted,
  "transactional throw after $commit: the line says the commit stayed",
  async (t) => {
    const line = await rejectionOf(() => t.send.go!());
    assertEquals(t.getState().n, 1, "the $commit stayed, the rest did not");
    assert(!line.includes("no state changed"), `false claim: ${line}`);
    assertStringIncludes(line, "STAYS committed");
  },
);
