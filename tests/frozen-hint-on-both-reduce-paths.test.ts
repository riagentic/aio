// The frozen-state hint must reach every cell, not only the ones without a
// listener.
//
// Mutating frozen state throws a cryptic engine message ("Cannot add property
// 2, object is not extensible"). It means the method mutated something OTHER
// than its own `s` draft — almost always another cell's state
// (`otherCell.field.push(...)`) or a value captured from a read. That is the
// most common mistake a cell author makes, and the whole point of the hint is
// to turn the engine's sentence into an actionable one.
//
// There are two reduce paths — a simple one and a machine one — and the hint
// was only on the simple one. `listensTo` SYNTHESISES a machine
// (`cell-methods-internals.ts`), so every cell with a listener silently lost
// it. This file's neighbour already mirrors `narrowPatches` across both paths
// with a comment saying both must; the hint was the half that had not been
// done.
import { assert, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const FROZEN = Object.freeze([1, 2]) as number[];

Deno.test("frozen hint: a cell with `listensTo` gets the same message as one without", async () => {
  const src = cell("hintsrc", {
    state: { n: 0 },
    methods: {
      ping(s: { n: number }) {
        s.n++;
      },
    },
  });
  const plain = cell("hintplain", {
    state: { n: 0 },
    methods: {
      bad(s: { n: number }) {
        FROZEN.push(3);
        s.n++;
      },
    },
  });
  const machine = cell("hintmachine", {
    state: { n: 0 },
    listensTo: { onPing: src.ping },
    methods: {
      onPing(s: { n: number }) {
        s.n++;
      },
      bad(s: { n: number }) {
        FROZEN.push(3);
        s.n++;
      },
    },
  });

  const h = await bootCells([src, plain, machine]);
  try {
    const messageOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const plainMsg = await messageOf(() => plain.bad());
    const machineMsg = await messageOf(() => machine.bad());

    assertStringIncludes(
      plainMsg,
      "may only mutate its own",
      "the simple path has always had the hint",
    );
    assertStringIncludes(
      machineMsg,
      "may only mutate its own",
      "a cell with a listener must get it too — `listensTo` synthesises a " +
        "machine, and that path threw the bare engine message",
    );
    // The hint carries the ACTIONABLE part, not just a sentence.
    for (const m of [plainMsg, machineMsg]) {
      assertStringIncludes(m, "otherCell.add(");
      assert(
        m.includes("JSON.parse(JSON.stringify"),
        `and the snapshot advice: ${m}`,
      );
    }
  } finally {
    h.dispose();
  }
});

Deno.test("frozen hint: an ordinary method error is NOT dressed up as one", async () => {
  // The control — a hint appended to every failure would be noise, and would
  // send an author looking for a mutation they never made.
  const c = cell("hintordinary", {
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }) {
        throw new Error("the API said no");
      },
    },
  });
  const h = await bootCells([c]);
  try {
    let msg = "";
    try {
      await c.boom();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assertStringIncludes(msg, "the API said no");
    assert(
      !msg.includes("may only mutate its own"),
      `an unrelated throw must stay unadorned: ${msg}`,
    );
  } finally {
    h.dispose();
  }
});
