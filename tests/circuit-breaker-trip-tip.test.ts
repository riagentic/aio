// A circuitBreaker trip was reported as a plain EFFECT_ERROR with no effect
// type, so every trip, of every cell, printed the sync-effect tip:
// `Sync effect "?" threw. If doing I/O, move to an async method…` — advice
// about an effect that does not exist, and nothing about what actually
// happened (the framework disabled the cell) or how to bring it back.
import { assert, assertEquals } from "@std/assert";
import { until } from "../src/state/async-helpers.ts";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import type { Msg } from "../src/state/cell-types.ts";
import { type AioError, generateTip } from "../src/diagnostics/error.ts";

Deno.test("circuit breaker trip: its own truthful tip, not the sync-effect one", async () => {
  const tripper = cell("tripper", {
    state: { x: 0 },
    methods: {
      async crash(_s) {
        throw new Error("boom");
      },
    },
  });
  const errors: AioError[] = [];
  const composed = composeCells([tripper], {
    onCellError: (err) => errors.push(err as AioError),
    circuitBreaker: { maxErrors: 2 },
  });
  let state = composed.initialState;
  const app = {
    dispatch: (a: Msg): void => {
      const r = composed.reduce(state, a);
      state = r.state;
      for (const eff of r.effects) composed.execute(app, eff as Msg);
    },
    getState: () => state,
  };
  composed.initAll(app);
  app.dispatch({ type: "tripper:crash", payload: { args: [] } });
  app.dispatch({ type: "tripper:crash", payload: { args: [] } });
  await until(() => !composed.registry.isEnabled("tripper"), {
    timeoutMs: 2000,
    intervalMs: 5,
  });
  const trips = errors.filter((e) => /circuit breaker/.test(e.message));
  assertEquals(trips.length, 1);
  const tip = generateTip(trips[0]!) ?? "";
  assert(!/Sync effect/.test(tip), tip);
  assert(/circuit breaker disabled cell "tripper"/.test(tip), tip);
  assert(/cells\.enable\("tripper"\)/.test(tip), tip);
});
