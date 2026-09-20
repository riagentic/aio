// `visible: { exclude: ["accounts.encSecKey"] }` is enforced on every CLIENT
// read (bindCellReactive). That seam walked and re-copied the whole value on
// EVERY property read: `cell.accounts` on a 10 000-row list built 10 000 fresh
// row objects, every time any component read it. Two costs, both measured in a
// field report: 25.5 s of a 27 s renderer profile inside the filter, and — the
// worse one — a brand-new object graph per read, so every `WeakMap`-on-the-row
// memo downstream missed forever. One keypress froze that app for 38 s.
//
// The filter is memoized per source value now. State is immutable (Immer
// `autoFreeze`, and a delta applies as `applyPatches`), so a changed value is
// a different object: same source ⇒ same view is exact, not a cache with a
// staleness window. The assertions below are IDENTITY, not a stopwatch —
// re-copying shows up as a new object on every machine.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

type Row = { id: number; name: string; encSecKey: string };
type View = { id: number; name: string; encSecKey?: string };

function reset(): void {
  _resetAioRuntime();
  _resetSignals();
}

const row = (i: number): Row => ({
  id: i,
  name: `acct ${i}`,
  encSecKey: `s3cret-${i}`,
});

Deno.test("visible.exclude: a client read is stable in identity, not a fresh copy", () => {
  reset();
  const rows = [row(0), row(1), row(2)];
  const c = cell("vx-memo-ids", {
    state: { accounts: rows as Row[] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(c);
  getCellSignal("vx-memo-ids", c.__aio.state).set({ accounts: rows });

  const read = () => (c as unknown as { accounts: View[] }).accounts;
  const a = read();
  const b = read();
  assert(a === b, "two reads of an unchanged value are the SAME array");
  assert(a[0] === b[0], "…and the same rows");
  // The filtering itself still holds.
  assertEquals(JSON.parse(JSON.stringify(a)), [
    { id: 0, name: "acct 0" },
    { id: 1, name: "acct 1" },
    { id: 2, name: "acct 2" },
  ]);
  assertThrows(
    () => a[1]!.encSecKey,
    Error,
    "vx-memo-ids.accounts.encSecKey",
    "the memoized row keeps the loud tripwire",
  );
  reset();
});

Deno.test("visible.exclude: a changed row is re-filtered, an unchanged one is reused", () => {
  reset();
  const keep0 = row(0);
  const keep2 = row(2);
  const c = cell("vx-memo-fresh", {
    state: { accounts: [keep0, row(1), keep2] as Row[] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(c);
  const sig = getCellSignal("vx-memo-fresh", c.__aio.state);
  sig.set({ accounts: [keep0, row(1), keep2] });
  const before = (c as unknown as { accounts: View[] }).accounts;
  assertEquals(before[1]!.name, "acct 1");

  // A commit: Immer's structural sharing keeps the untouched rows and replaces
  // the changed one. The view must follow — a stale memo would serve the old
  // name — while the untouched rows keep the identity the UI memoizes on.
  const changed = { ...keep0, name: "renamed" };
  sig.set({ accounts: [changed, before[1] as unknown as Row, keep2] });
  const after = (c as unknown as { accounts: View[] }).accounts;
  assert(after !== before, "a new state is a new view");
  assertEquals(after[0]!.name, "renamed", "the changed row is re-filtered");
  assert(after[2] === before[2], "an unchanged row keeps its view identity");
  assertThrows(
    () => after[0]!.encSecKey,
    Error,
    "vx-memo-fresh.accounts.encSecKey",
    "a re-filtered row keeps the tripwire",
  );
  reset();
});

Deno.test("visible.exclude: reading a 5k-row list twice does no second walk", () => {
  reset();
  const N = 5000;
  const rows = Array.from({ length: N }, (_, i) => row(i));
  const c = cell("vx-memo-big", {
    state: { accounts: rows as Row[] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(c);
  getCellSignal("vx-memo-big", c.__aio.state).set({ accounts: rows });
  const read = () => (c as unknown as { accounts: View[] }).accounts;

  const first = read();
  assertEquals(first.length, N);
  // 200 further reads — the shape a render loop makes. Every one of them used
  // to copy all 5000 rows.
  for (let i = 0; i < 200; i++) {
    assert(read() === first, `read ${i} rebuilt the whole list`);
  }
  assertEquals(first[N - 1]!.name, `acct ${N - 1}`);
  assertEquals(
    Object.keys(first[N - 1]!).sort(),
    ["id", "name"],
    "the secret is still gone from every row",
  );
  reset();
});
