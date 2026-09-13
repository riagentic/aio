// `am timetravel undo` at the oldest entry and `redo` at the newest answered
// `{"ok":true}` and did nothing — a script looping `undo` "succeeded" forever
// at index 0. The no-op is by design (time-travel.ts); saying nothing about it
// is not. `ok` keeps its meaning (the command was accepted) and the exit stays
// 0; `moved` and `note` are added beside it. Measured by a hunter running `am`
// as a user.
//
// Also here, because it needs the same live history: `am actions --lines=N`,
// which was accepted and ignored (the whole window printed).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import {
  cmdActions,
  cmdDispatch,
  cmdTT,
  ttMoved,
} from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-tt-noop-app";
const CELL = "am-tt-noop-c";

const counter = cell(CELL, {
  state: { n: 0 },
  methods: {
    inc(s: { n: number }) {
      s.n++;
    },
  },
});

async function capture(fn: () => Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = realLog;
  }
  return JSON.parse(lines.join("\n"));
}

Deno.test({
  name: "am timetravel: an undo that cannot move says so; one that can, moves",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer({ cells: [counter], appId: APP });
    const flags = { app: APP, port: srv.port, json: true } as GlobalFlags;
    for (let i = 0; i < 3; i++) {
      await capture(() => cmdDispatch([`${CELL}:inc`], flags));
    }

    // Newest entry: redo has nowhere to go.
    const redo = await capture(() => cmdTT(["redo"], flags)) as {
      ok: boolean;
      moved?: boolean;
      note?: string;
    };
    assertEquals(redo.ok, true);
    assertEquals(redo.moved, false, "redo at the newest entry claimed nothing");
    assertStringIncludes(redo.note ?? "", "newest");

    // Walk to the oldest, then one more undo.
    let last: { moved?: boolean; note?: string } = {};
    for (let i = 0; i < 10; i++) {
      last = await capture(() => cmdTT(["undo"], flags)) as typeof last;
      if (last.moved === false) break;
    }
    assertEquals(last.moved, false, "undo never reported reaching the start");
    assertStringIncludes(last.note ?? "", "oldest");

    // A move is reported as one.
    const back = await capture(() => cmdTT(["redo"], flags)) as {
      moved?: boolean;
    };
    assertEquals(back.moved, true);

    // `am actions --lines=1`: the newest entry only, and how many there are.
    const one = await capture(() => cmdActions([], { ...flags, lines: 1 })) as {
      entries: unknown[];
      shown: number;
      total: number;
    };
    assertEquals(one.entries.length, 1, "--lines=1 printed the whole history");
    assertEquals(one.shown, 1);
    assert(one.total >= 3, `total ${one.total}`);
    // …and `am actions 2`, the spelling the docs have always shown.
    const two = await capture(() => cmdActions(["2"], flags)) as {
      entries: unknown[];
    };
    assertEquals(two.entries.length, 2, "`am actions 2` printed everything");
  },
});

Deno.test("ttMoved: compares the app's history before and after", () => {
  const h = (index: number, paused = true, n = 3) => ({
    entries: Array.from({ length: n }, (_, id) => ({ id })),
    index,
    paused,
  });
  assertEquals(ttMoved("undo", h(1), h(0)).moved, true);
  assertEquals(ttMoved("undo", h(0), h(0)).moved, false);
  assertEquals(ttMoved("pause", h(2, false), h(2, true)).moved, true);
  assertStringIncludes(ttMoved("pause", h(2), h(2)).note, "already paused");
  assertStringIncludes(
    ttMoved("undo", h(-1, false, 0), h(-1, false, 0)).note,
    "empty",
  );
});
