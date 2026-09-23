// The ONE persist decider, pinned directly: `src/state/cell-persist-filter.ts`.
//
// Every runtime that writes cell state (the server's persistence, the
// standalone/Android store) takes WHAT it writes and WHAT may come back from
// these three functions; `scripts/check-persist-decider.ts` makes sure no host
// can go around them. Until this file, nothing imported them — they were
// proven only through the hosts, so a change to the rule itself surfaced as a
// host failure somewhere else. The `@decider` wiring gate
// (`scripts/check-dead-wiring.ts`) now requires a test that holds them still.
import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import {
  buildDBStateGetter,
  persistFilterOf,
  persistingCellIds,
} from "../src/state/cell-persist-filter.ts";

const composed = composeCells([
  cell("pfAll", { state: { a: 1, b: 2 }, methods: {} }),
  cell("pfNone", { state: { token: "SECRET" }, persist: "none", methods: {} }),
  cell("pfSome", {
    state: { keep: 1, drop: 2 },
    persist: { exclude: ["drop"] },
    methods: {},
  }),
], { perfCheck: false });
const byId = (id: string) => composed.cells.find((c) => c.__aio.id === id)!;

Deno.test('persistFilterOf: undeclared resolves to "all"; a declared filter is returned as-is', () => {
  assertEquals(persistFilterOf(byId("pfAll")), "all");
  assertEquals(persistFilterOf(byId("pfNone")), "none");
  assertEquals(persistFilterOf(byId("pfSome")), { exclude: ["drop"] });
});

Deno.test('persistingCellIds: every cell except persist:"none" — the restore side\'s set', () => {
  assertEquals([...persistingCellIds(composed)].sort(), ["pfAll", "pfSome"]);
});

Deno.test('buildDBStateGetter: persist:"none" never reaches the store; filters apply per field', () => {
  const get = buildDBStateGetter(composed);
  assertEquals(get(composed.initialState), {
    pfAll: { a: 1, b: 2 },
    pfSome: { keep: 1 },
  });
});

Deno.test("buildDBStateGetter: a throwing persist transform is re-thrown with the cell named, never swallowed", () => {
  const c = composeCells([
    cell("pfShaped", {
      state: { x: 1 },
      onPersist: () => {
        throw new Error("boom");
      },
      methods: {},
    }),
  ], { perfCheck: false });
  const e = assertThrows(() => buildDBStateGetter(c)(c.initialState));
  assertEquals((e as Error).message.startsWith("[cell:pfShaped]"), true);
});
