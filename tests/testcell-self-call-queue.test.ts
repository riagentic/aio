// A call to a cell's OWN method from inside one of its methods is queued by
// the production dispatch loop: it starts after the current action commits.
// `testCell` used to run it inline, so the outer commit overwrote it —
// `addTwice` added nothing under the harness and both items on a server. Code
// that works in production must not fail its own test.
import { assertEquals } from "@std/assert";
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
