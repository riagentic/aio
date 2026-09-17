// A call to a cell's OWN method from inside one of its methods is queued by
// the production dispatch loop: it starts after the current action commits.
// `testCell` used to run it inline, so the outer commit overwrote it —
// `addTwice` added nothing under the harness and both items on a server. Code
// that works in production must not fail its own test.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

const notes = cell("self-call-queue", {
  state: { items: [] as string[] },
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
    addTwice() {
      notes.add("a");
      notes.add("b");
    },
    writeThenCall(s) {
      s.items.push("w");
      notes.add("b");
    },
    reset(s) {
      s.items = [];
    },
    async addLater() {
      await notes.add("x");
    },
  },
});

const EXPECTED: Record<string, string[]> = {
  addTwice: ["a", "b"],
  writeThenCall: ["w", "b"],
  addLater: ["x"],
};

for (const [method, items] of Object.entries(EXPECTED)) {
  testCell(notes, `testCell: ${method} matches production`, async (t) => {
    // deno-lint-ignore no-explicit-any
    await (t.send as any)[method]();
    await t.settle();
    assertEquals(t.state.items, items);
  });
}

Deno.test("the same methods on a real server — the reference", async () => {
  await using srv = await testServer({ cells: [notes] });
  // deno-lint-ignore no-explicit-any
  const call = notes as any;
  for (const [method, items] of Object.entries(EXPECTED)) {
    await call.reset();
    await call[method]();
    await new Promise((r) => setTimeout(r, 20));
    // deno-lint-ignore no-explicit-any
    assertEquals((srv.state() as any)["self-call-queue"].items, items, method);
  }
});

// ── A queued self-call survives its caller's throw — SAID, not changed ──────
//
// Consistent on every door (h4 seqs.ts): the caller is rejected and its own
// write is rolled back, while the queued self-call commits as its own action.
// Documented in docs/state/methods.md; this pins the behaviour AND the debug
// line that names it, so the nested write landing after a failure is not a
// mystery.
import { assertStringIncludes } from "@std/assert";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

const survivor = cell("self-call-survives", {
  state: { items: [] as string[] },
  methods: {
    add(s, t: string) {
      s.items.push(t);
    },
    addThenThrow(s) {
      s.items.push("caller");
      survivor.add("queued");
      throw new Error("caller failed");
    },
  },
});

testCell(
  survivor,
  "testCell: a queued self-call commits although its caller threw",
  async (t) => {
    const lines: string[] = [];
    setLogger({
      logDir: "",
      pub: (_lvl: string, _cat: string, msg: string) => lines.push(msg),
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink);
    try {
      // deno-lint-ignore no-explicit-any
      await t.expect.rejects!(
        () => (t.send as any).addThenThrow(),
        /caller failed/,
      );
      await t.settle();
    } finally {
      setLogger(null);
    }
    assertEquals(
      t.state.items,
      ["queued"],
      "caller rolled back, self-call kept",
    );
    const line = lines.find((l) => l.includes("self-call"));
    assert(
      line,
      `no debug line named the surviving self-call:\n${lines.join("\n")}`,
    );
    assertStringIncludes(line, "self-call-survives:add");
    assertStringIncludes(line, "self-call-survives:addThenThrow threw");
  },
);
