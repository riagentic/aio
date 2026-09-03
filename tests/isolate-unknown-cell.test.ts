// `--isolate=<name>` names cells to run. A name that matches NOTHING used to
// warn once and boot an app with ZERO cells.
//
// What the operator then saw was not "you typed setings": it was the
// shape-drift check meeting a database full of keys that no longer had a cell
// behind them, and blaming the SCHEMA — "counter (stored, no longer declared)
// … Bump the cell's version + add onMigrate". A typo in a flag, reported as a
// migration the app owes its own data. `--isolate=todo,setings` was worse
// still: it booted `todo` alone and said nothing at all, because SOMETHING
// matched.
//
// A zero-cell app is never what anyone meant, and a partly-matching list is
// never what anyone meant either. Both are now refused with the nearest name,
// in dev AND prod, before anything opens a database.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { filterCellsByIsolate } from "../src/server/aio-cells-bridge.ts";
import { nearestOf } from "../src/state/cell-helpers.ts";
import type { CellsConfig } from "../src/server/aio-types.ts";

type Entries = NonNullable<CellsConfig["cells"]>;

/** Cell entries with these ids — the only thing the filter reads. */
const defs = (...ids: string[]): Entries =>
  ids.map((id) => ({ __aio: { id } })) as unknown as Entries;

const idsOf = (e: Entries): string[] =>
  e.map((x) => ("__aio" in x ? x : x.cell).__aio.id);

Deno.test("isolate: an unknown name is REFUSED, with the nearest cell named", () => {
  const err = assertThrows(
    () => filterCellsByIsolate(defs("counter", "todo"), ["setings"]),
    Error,
  );
  const msg = String(err);
  assert(
    msg.includes("setings"),
    `the refusal must quote what was typed: ${msg}`,
  );
  assert(
    msg.includes("counter") && msg.includes("todo"),
    `the refusal must list the cells that exist: ${msg}`,
  );
});

Deno.test("isolate: a near miss gets a did-you-mean", () => {
  const err = assertThrows(
    () => filterCellsByIsolate(defs("settings", "todo"), ["setings"]),
    Error,
  );
  assert(
    String(err).includes("setings → settings"),
    `did-you-mean missing: ${err}`,
  );
});

Deno.test("isolate: ONE bad name in a good list is refused too — a partial match booted silently", () => {
  const err = assertThrows(
    () => filterCellsByIsolate(defs("todo", "counter"), ["todo", "setings"]),
    Error,
  );
  assert(String(err).includes("setings"), String(err));
  assert(
    !String(err).includes("todo, setings"),
    `only the unknown name is the fault: ${err}`,
  );
});

Deno.test("isolate: the names that DO match are the app's cells", () => {
  assertEquals(
    idsOf(filterCellsByIsolate(defs("a", "b", "c"), ["b"])),
    ["b"],
  );
  assertEquals(
    idsOf(filterCellsByIsolate(defs("a", "b", "c"), ["c", "a"])),
    ["a", "c"],
    "order follows the app's cell list, not the flag",
  );
  // No isolate at all: every cell, untouched.
  assertEquals(idsOf(filterCellsByIsolate(defs("a", "b"), undefined)), [
    "a",
    "b",
  ]);
  assertEquals(idsOf(filterCellsByIsolate(defs("a", "b"), [])), ["a", "b"]);
});

Deno.test("isolate: `{ cell }` entries are read the same way as bare defs", () => {
  const wrapped = [{
    cell: { __aio: { id: "wrapped" } },
  }] as unknown as Entries;
  assertEquals(idsOf(filterCellsByIsolate(wrapped, ["wrapped"])), ["wrapped"]);
  assertThrows(() => filterCellsByIsolate(wrapped, ["nope"]), Error);
});

// The property that makes the whole class unshippable: whatever is asked for,
// the filter either throws or hands back at least one cell. A zero-cell app
// can no longer come out of this function by any route.
Deno.test("isolate: never returns an empty cell list (property)", () => {
  const vocab = ["a", "bb", "counter", "todo", "notes", "x"];
  const rand = (n: number) => Math.floor(Math.random() * n);
  for (let i = 0; i < 300; i++) {
    const app = defs(
      ...[
        ...new Set(
          Array.from({ length: 1 + rand(4) }, () => vocab[rand(vocab.length)]!),
        ),
      ],
    );
    const asked = Array.from(
      { length: rand(4) },
      () => Math.random() < 0.5 ? vocab[rand(vocab.length)]! : `q${rand(9)}`,
    );
    const have = idsOf(app);
    const unknown = [...new Set(asked)].filter((n) => !have.includes(n));
    let out: Entries | null = null;
    let refusal: string | null = null;
    try {
      out = filterCellsByIsolate(app, asked);
    } catch (e) {
      refusal = String(e);
    }
    if (unknown.length > 0) {
      // Refused — and the refusal has to be WORTH producing: every name it
      // cannot honour, the cells it does have, and the nearest id when there
      // is one. "no cells matched — check spelling" was the old message, and
      // it is what sent readers to their schema instead of their flag.
      assert(refusal !== null, `accepted ${JSON.stringify(unknown)}`);
      for (const u of unknown) assertStringIncludes(refusal, u);
      for (const h of have) assertStringIncludes(refusal, h);
      const near = unknown
        .map((u) => [u, nearestOf(u, have)] as const)
        .filter((p): p is readonly [string, string] => p[1] !== null);
      for (const [u, m] of near) assertStringIncludes(refusal, `${u} → ${m}`);
      continue;
    }
    // Nothing unknown: the cells asked for, and never an empty app.
    assertEquals(refusal, null, `refused a list it could honour: ${refusal}`);
    assertEquals(
      idsOf(out!),
      asked.length === 0 ? have : have.filter((id) => asked.includes(id)),
      `isolate=${JSON.stringify(asked)} over ${JSON.stringify(have)}`,
    );
    assert(out!.length > 0, "an app with no cells is never what anyone meant");
  }
});
