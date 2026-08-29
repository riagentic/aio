// The state before the first dispatch is frozen, exactly like every state
// after it.
//
// Committed state is frozen — immer's `autoFreeze` is never disabled, so a
// write to it throws in dev AND prod. The state at t=0 was the one exception:
// nothing produced it, so nothing froze it. The hole was silent in the worst
// way — measured on alpha71:
//
//     t.getState().n = 99   // before any dispatch: SUCCEEDED, and getState()
//                           // then reported 99
//     t.getState().n = 99   // after one dispatch: TypeError
//
// A rule with a window in it is not a rule, and the window was exactly the
// moment an app is being wired: an `onInit` hook, a boot-time effect, a
// component that renders before the first action.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell, composeCells } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { isFrozenWriteError } from "../src/state/immutable.ts";

const deep = cell("frozen-init", {
  state: {
    n: 0,
    obj: { a: 1, nested: { b: 2 } },
    list: [{ id: "x" }] as { id: string }[],
  },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

Deno.test("initial state: frozen all the way down, before any dispatch", () => {
  const composed = composeCells([deep]);
  const slice = composed.initialState["frozen-init"] as {
    obj: { nested: unknown };
    list: unknown[];
  };
  assert(Object.isFrozen(composed.initialState), "the root");
  assert(Object.isFrozen(slice), "the cell's slice");
  assert(Object.isFrozen(slice.obj), "a nested object");
  assert(Object.isFrozen(slice.obj.nested), "a nested nested object");
  assert(Object.isFrozen(slice.list), "an array");
  assert(Object.isFrozen(slice.list[0]), "an object inside an array");
});

Deno.test("initial state: a write throws, and says what to do instead", () => {
  const composed = composeCells([deep]);
  const slice = composed.initialState["frozen-init"] as { n: number };
  const e = assertThrows(() => {
    slice.n = 99;
  }) as Error;
  assert(
    isFrozenWriteError(e.message),
    `a write to boot state must be recognised as a frozen write: ${e.message}`,
  );
});

Deno.test("initial state: freezing it does not alias the DECLARATION", () => {
  // `cloneState` exists so live state never aliases `f.__aio.state`. If the
  // freeze reached through the clone, a second `composeCells` in the same
  // process — a second test, a worker — would inherit a frozen declaration and
  // the first mutation anywhere would throw for no reason the author can see.
  composeCells([deep]);
  const declared = deep.__aio.state as { obj: { a: number } };
  assert(
    !Object.isFrozen(declared),
    "composing a cell must not freeze the object the author wrote",
  );
  assert(!Object.isFrozen(declared.obj), "…nor anything inside it");
  const again = composeCells([deep]);
  assertEquals(
    (again.initialState["frozen-init"] as { n: number }).n,
    0,
    "and a second compose still produces a usable initial state",
  );
});

testCell(
  deep,
  "t=0 and t=1 behave the SAME, which was the whole point",
  (t) => {
    const before = t.getState() as { n: number };
    assertThrows(() => {
      before.n = 99;
    });
    assertEquals(
      (t.getState() as { n: number }).n,
      0,
      "and the refused write changed nothing",
    );
  },
);

Deno.test("initial state: BOOT gets a mutable copy — onRestore mutates by design", async () => {
  // The regression this freeze caused the first time it landed, and the reason
  // the invariant is "the DECLARATION is frozen" rather than "state is frozen".
  //
  // `onRestore` is a documented MUTATION hook — the rename recipe in the docs
  // is literally `s.new.field = s.old.field; delete s.old` — so the state boot
  // hands it must be mutable. Handed the frozen declaration, that assignment
  // threw into the hook's own error guard and the migration was reported as a
  // log line while the data quietly did not move:
  //
  //     ERROR hook onRestore: TypeError: Cannot assign to read only property
  //
  // A silent failed migration is the worst outcome available here, so this
  // pins the shape rather than the mechanism.
  const { bootState } = await import("./initial-state-frozen-helper.ts");
  const s = bootState();
  // Every level of what boot works with must accept a write.
  s.frozen1 = { a: 1 };
  (s.nested as Record<string, unknown>).deep = "changed";
  delete s.gone;
  assertEquals(s.frozen1, { a: 1 });
  assertEquals((s.nested as Record<string, unknown>).deep, "changed");
  assertEquals("gone" in s, false);
});
