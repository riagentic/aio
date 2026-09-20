// Dev time travel's history is bounded by what it RETAINS, not only by how
// many actions it holds.
//
// An entry stores the committed state REFERENCE, which is free thanks to
// Immer's structural sharing — for the deltas between actions. It is not free
// for what an action REPLACES: a method writing a fresh 1 MB value leaves a
// whole new 1 MB tree per entry, and the only cap was 2 000 entries, i.e. ~2 GB
// held by a dev inspector nobody opened. (The always-on timeline learned this
// first — tests/timeline-byte-budget.test.ts — and time travel, which retains
// far more per entry, kept only the count cap.)
import { assert, assertEquals } from "@std/assert";
import {
  createTT,
  MAX_ENTRIES,
  record,
  resume,
  TT_MAX_BYTES,
  undo,
} from "../src/diagnostics/time-travel.ts";
import { approxDeltaBytes } from "../src/diagnostics/retained-bytes.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

const MB = 1024 * 1024;
type S = { big: { blob: string }; n: number };
type A = { type: string };

/** What the history really holds: one base tree plus every entry's delta. */
function retained(entries: { state: S }[]): number {
  let held = entries.length > 0
    ? approxDeltaBytes(undefined, entries[0]!.state)
    : 0;
  for (let i = 1; i < entries.length; i++) {
    held += approxDeltaBytes(entries[i - 1]!.state, entries[i]!.state);
  }
  return held;
}

Deno.test("tt: a history of replaced big values is bounded by bytes", () => {
  let tt = createTT<S, A>();
  let state: S = { big: { blob: "" }, n: 0 };
  for (let i = 1; i <= 400; i++) {
    state = { big: { blob: String(i).padEnd(MB, "y") }, n: i };
    tt = record(tt, { type: "big:put" }, state);
  }
  // Instrument: each entry really carries its own ~1 MB tree.
  assert(
    approxDeltaBytes(tt.entries[0]?.state, tt.entries[1]?.state) > MB,
    "the probe's entries are not the size the test assumes",
  );
  assert(
    tt.entries.length < 400,
    `nothing was evicted: ${tt.entries.length} entries × ~1 MB`,
  );
  assert(
    retained(tt.entries) <= TT_MAX_BYTES + 4 * MB,
    `the history retains ~${(retained(tt.entries) / MB) | 0} MB for a 1 MB ` +
      `value — it must stay inside the ${(TT_MAX_BYTES / MB) | 0} MB budget`,
  );
  // The newest action is ALWAYS kept — it is the one a jump lands on.
  assertEquals(tt.entries[tt.entries.length - 1]!.state.n, 400);
  assertEquals(tt.index, tt.entries.length - 1);
  assert(
    (tt.droppedForBytes ?? 0) > 0,
    "the history has to SAY it dropped history for size",
  );
});

Deno.test("tt: small actions still fill the count window, and are never evicted for bytes", () => {
  let tt = createTT<S, A>();
  let state: S = { big: { blob: "small" }, n: 0 };
  for (let i = 1; i <= MAX_ENTRIES + 50; i++) {
    state = { ...state, n: i };
    tt = record(tt, { type: "inc" }, state);
  }
  assertEquals(tt.entries.length, MAX_ENTRIES, "the count cap still rules");
  assertEquals(tt.droppedForBytes ?? 0, 0, "nothing was dropped for size");
  assertEquals(tt.entries[tt.entries.length - 1]!.state.n, MAX_ENTRIES + 50);
});

Deno.test("tt: dropping history for size is said ONCE, loudly", () => {
  const warns: string[] = [];
  const prev = getLogger();
  setLogger({
    // deno-lint-ignore no-explicit-any
    pub: (lvl: string, cat: string, msg: string) => {
      // The category is where "time travel" lives — the logger prints it.
      if (lvl === "warn") warns.push(`${cat}: ${msg}`);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    let tt = createTT<S, A>();
    let state: S = { big: { blob: "" }, n: 0 };
    for (let i = 1; i <= 200; i++) {
      state = { big: { blob: String(i).padEnd(MB, "y") }, n: i };
      tt = record(tt, { type: "big:put" }, state);
    }
    assert((tt.droppedForBytes ?? 0) > 0, "instrument: it did drop entries");
    const mine = warns.filter((w) => w.includes("time travel"));
    assertEquals(mine.length, 1, `said ${mine.length} times: ${mine[0]}`);
    assert(
      mine[0]!.includes("MB") && mine[0]!.includes("dev"),
      `the warning must name the size and that this is a dev history: ${
        mine[0]
      }`,
    );
  } finally {
    setLogger(prev);
  }
});

Deno.test("tt: rewinding and branching keeps the byte budget honest", () => {
  let tt = createTT<S, A>();
  let state: S = { big: { blob: "" }, n: 0 };
  for (let i = 1; i <= 60; i++) {
    state = { big: { blob: String(i).padEnd(MB, "y") }, n: i };
    tt = record(tt, { type: "big:put" }, state);
  }
  const before = tt.entries.length;
  for (let i = 0; i < 20; i++) tt = undo(tt);
  tt = resume(tt);
  assertEquals(
    tt.entries.length,
    before - 20,
    "a branch drops the forward arm",
  );
  state = { big: { blob: "z".padEnd(MB, "z") }, n: 999 };
  tt = record(tt, { type: "big:put" }, state);
  assert(
    retained(tt.entries) <= TT_MAX_BYTES + 4 * MB,
    `after a branch the history holds ~${(retained(tt.entries) / MB) | 0} MB`,
  );
  assertEquals(tt.entries[tt.entries.length - 1]!.state.n, 999);
});
