// The wire frame (applyCellFieldFilter → deepExcludePaths) takes the
// records-by-id reading from the cell's OWN top level: with
// `exclude: ["a.b"]`, `x.a.b` is stripped (pinned for the frame and the patch
// path by tests/visible-exclude-seams-property.test.ts, "a delta whose FIRST
// segment is a record id agrees with the frame"). The client read seam —
// the only filter in standalone/Electron/testUI — reads a top-level key `x`
// through `uiKeyVisibility`, which only hands out deep paths whose HEAD is
// `x`, so `cell.x` returns the secret the wire refuses.
import { assert, assertEquals } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import { cell } from "../src/state/cell-create.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("client read seam strips x.a.b exactly as the wire frame does", () => {
  _resetAioRuntime();
  _resetSignals();
  const state = {
    x: { a: { b: "SECRET-X-A-B", keep: 1 } },
    a: { b: "SECRET-A-B", q: 1 },
  };
  const filter = { exclude: ["a.b"] as "a.b"[] };
  const wire = applyCellFieldFilter(filter, state)!;
  // Sanity: the wire frame removes BOTH.
  assert(!JSON.stringify(wire).includes("SECRET"), JSON.stringify(wire));

  // deno-lint-ignore no-explicit-any
  const c: any = cell("hunt-r3-seam-top", {
    state,
    methods: {},
    visible: filter,
  });
  bindCellReactive(c);
  getCellSignal("hunt-r3-seam-top", c.__aio.state).set(state);

  const clientX = JSON.stringify(c.x);
  assertEquals(
    clientX,
    JSON.stringify((wire as Record<string, unknown>).x),
    `client read of x differs from wire: client=${clientX}`,
  );
  assert(
    !clientX.includes("SECRET"),
    `secret readable on client seam: ${clientX}`,
  );
  _resetAioRuntime();
  _resetSignals();
});
