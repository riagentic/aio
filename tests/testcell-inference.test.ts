// tbd B8 / inews #8 regression — testCell infers EVERYTHING from the cell ref:
// state (getState / expect.state / invariant), sender args, and sender RETURN
// types. These are compile-time guarantees: if inference regresses to
// Record<string, unknown> / Promise<unknown>, this file fails `deno check`.
//
// Root cause of the original gap: the selector-less `cell()` overload
// defaulted `Sel` to Record<string, …>, stamping a string INDEX SIGNATURE on
// every cell ref — `keyof cellRef` widened to `string` and every mapped type
// over the ref collapsed. The default is now an empty record.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testCell } from "../src/testing/cell-test.ts";

const inferCell = cell("infer-probe", {
  state: { count: 0, name: "start" },
  methods: {
    bump(s, by: number = 1) {
      s.count += by;
    },
    // Sync method WITH a return value (AIO-427 transport).
    label(s, prefix: string): string {
      return `${prefix}:${s.name}`;
    },
    // Async method with a typed return.
    async fetchName(s): Promise<string> {
      await Promise.resolve();
      s.name = "fetched";
      return s.name;
    },
  },
  selectors: {
    doubled: (s) => s.count * 2,
  },
});

testCell(
  inferCell,
  "state + sender args + sender returns are fully typed",
  async (t) => {
    // State inference — `count` must be a number without any annotation.
    const s0 = t.getState();
    const _count: number = s0.count;
    t.expect.state((st) => st.count === 0 && st.name === "start");
    t.expect.invariant((st) => st.count >= 0);

    // Sender ARG inference — bump takes an optional number.
    await t.send.bump(2);
    t.expect.state((st) => st.count === 2);

    // Sender RETURN inference — sync method's transported return is a string.
    const label: string = await t.send.label("pre");
    assertEquals(label, "pre:start");

    // Async method return is Promise<string>, resolved to string.
    const name: string = await t.send.fetchName();
    assertEquals(name, "fetched");
    t.expect.state((st) => st.name === "fetched");
  },
);

// Legacy explicit-state form keeps working (loose senders — non-null assert
// as in tests/cell.test.ts — with typed state).
testCell<{ count: number; name: string }>(
  inferCell,
  "legacy explicit-S form still accepted",
  async (t) => {
    await t.send.bump!(3);
    t.expect.state((st) => st.count === 3);
  },
);
