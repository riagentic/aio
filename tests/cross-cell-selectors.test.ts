import { assertEquals } from "@std/assert";
import { cell } from "../src/cell-create.ts";
import { composeCellsWiring } from "../src/aio-composition.ts";

// Tests for 3.1: cross-cell selectors via explicit `deps` form.

function wiring(
  cellEntries: Parameters<typeof composeCellsWiring>[0]["cellEntries"],
) {
  return composeCellsWiring({ cellEntries }).composed;
}

Deno.test(
  "3.1: plain selector (no deps) — unchanged behavior, receives own slice",
  () => {
    const counter = cell("counter", {
      state: { count: 0 } as { count: number },
      methods: {
        noop(s: { count: number }) {
          void s;
        },
      },
      selectors: {
        plain: (s: { count: number }) => s.count * 2,
      },
    });
    const composed = wiring([counter]);
    const result = (counter.__aio.selectors.plain as (s: unknown) => unknown)(
      (composed.initialState as Record<string, unknown>).counter,
    );
    assertEquals(result, 0);
  },
);

Deno.test(
  "3.1: deps selector — receives own slice plus listed deps in order",
  () => {
    const counter = cell("counter", {
      state: { count: 5 } as { count: number },
      methods: {
        noop(s: { count: number }) {
          void s;
        },
      },
    });
    const wallet = cell("wallet", {
      state: { balance: 100 } as { balance: number },
      methods: {
        noop(s: { balance: number }) {
          void s;
        },
      },
    });
    const dashboard = cell("dashboard", {
      state: { theme: "dark" } as { theme: string },
      methods: {
        noop(s: { theme: string }) {
          void s;
        },
      },
      selectors: {
        summary: {
          deps: ["counter", "wallet"],
          // deno-lint-ignore no-explicit-any
          fn: (s: any, counter: any, wallet: any) =>
            `Count: ${counter.count}, Balance: ${wallet.balance}, theme=${s.theme}`,
        },
      },
    });
    const composed = wiring([counter, wallet, dashboard]);
    const result = (dashboard.__aio.selectors.summary as (
      s: unknown,
      full: unknown,
    ) => string)(
      (composed.initialState as Record<string, unknown>).dashboard,
      composed.initialState,
    );
    assertEquals(result, "Count: 5, Balance: 100, theme=dark");
  },
);

Deno.test(
  "3.1: unknown dep name throws at aio.run() with clear message",
  () => {
    const dashboard = cell("dashboard", {
      state: { theme: "dark" } as { theme: string },
      methods: {
        noop(s: { theme: string }) {
          void s;
        },
      },
      selectors: {
        // deno-lint-ignore no-explicit-any
        summary: {
          deps: ["walet" as any], // intentional typo
          fn: (_s: unknown, _c: unknown, _w: unknown) => "never",
        },
      },
    });
    let caught: Error | null = null;
    try {
      composeCellsWiring({
        cellEntries: [dashboard],
      });
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(caught instanceof Error, true);
    assertEquals(
      (caught as unknown as Error).message.includes("walet"),
      true,
    );
    assertEquals(
      (caught as unknown as Error).message.includes("known cells:"),
      true,
    );
  },
);

Deno.test(
  "3.1: deps selector recomputes when a dep cell changes",
  () => {
    const counter = cell("counter", {
      state: { count: 0 } as { count: number },
      methods: {
        increment(s: { count: number }) {
          s.count++;
        },
      },
    });
    const dashboard = cell("dashboard", {
      state: { note: "x" } as { note: string },
      methods: {
        noop(s: { note: string }) {
          void s;
        },
      },
      selectors: {
        summary: {
          deps: ["counter"],
          // deno-lint-ignore no-explicit-any
          fn: (s: any, counter: any) => `note=${s.note} count=${counter.count}`,
        },
      },
    });
    const composed = wiring([counter, dashboard]);
    const initial = (dashboard.__aio.selectors.summary as (
      s: unknown,
      full: unknown,
    ) => string)(
      (composed.initialState as Record<string, unknown>).dashboard,
      composed.initialState,
    );
    assertEquals(initial, "note=x count=0");

    // Mutate counter — selectors read fresh state, so the recomputed value reflects the change.
    const next = composed.reduce(composed.initialState, {
      type: "counter:increment",
      payload: { args: [] },
    }).state;
    const after = (dashboard.__aio.selectors.summary as (
      s: unknown,
      full: unknown,
    ) => string)(
      (next as Record<string, unknown>).dashboard,
      next,
    );
    assertEquals(after, "note=x count=1");
  },
);
