import { assertEquals } from "@std/assert";
import { cell } from "../src/cell-create.ts";
import { composeCellsWiring } from "../src/aio-composition.ts";
import { _resetCellRegistry, bindCellReactive } from "../src/cell-reactive.ts";
import { _resetSignals } from "../src/state-signals.ts";

function reset() {
  _resetCellRegistry();
  _resetSignals();
}

Deno.test("5.1: client cell — methods mutate local slice and trigger re-render", () => {
  reset();
  const view = cell("view", {
    scope: "client" as const,
    state: { filter: "all" as "all" | "active" | "done" },
    methods: {
      setFilter(
        s: { filter: "all" | "active" | "done" },
        f: "all" | "active" | "done",
      ) {
        s.filter = f;
      },
    },
  });

  // Compose: the client cell should be SKIPPED on the server (no reducer).
  const wiring = composeCellsWiring({
    cellEntries: [view],
  });
  assertEquals(wiring.composed.cellNames.includes("view"), false);
  // And no auto-persist/ui entries for it.
  // deno-lint-ignore no-explicit-any
  assertEquals((wiring.composed as any).cellUiEntries, undefined);

  // Browser-side binding: sendFn records dispatches, no actual network.
  const dispatched: { type: string; payload?: unknown }[] = [];
  const sendFn = (
    action: { type: string; payload?: unknown },
  ) => {
    dispatched.push(action);
  };
  bindCellReactive(view, sendFn);

  // Calling a method on a client cell does NOT dispatch to server.
  // deno-lint-ignore no-explicit-any
  const ret = (view as any).setFilter("active");
  assertEquals(ret instanceof Promise, true);
  // No network dispatch happened.
  assertEquals(dispatched.length, 0);
  reset();
});

Deno.test("5.1: client cell — async method throws at cell() time", () => {
  reset();
  let caught: Error | null = null;
  try {
    cell("view", {
      scope: "client" as const,
      state: { x: 0 },
      // deno-lint-ignore require-await
      methods: {
        async bump(s: { x: number }) {
          s.x++;
        },
      },
    });
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    (caught as unknown as Error).message.includes(
      "client-scoped cells support sync methods only",
    ),
    true,
  );
  reset();
});

Deno.test("5.1: client cell — generators throw at cell() time", () => {
  reset();
  let caught: Error | null = null;
  try {
    cell("view", {
      scope: "client" as const,
      state: { x: 0 },
      methods: {
        // deno-lint-ignore no-explicit-any
        noop(_s: any) {},
      },
      // deno-lint-ignore no-explicit-any
      generators: {
        noop: function* (_ctx: any) {
          yield;
        },
      } as any,
    });
  } catch (e) {
    caught = e as Error;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    (caught as unknown as Error).message.includes("client-scoped"),
    true,
  );
  reset();
});

Deno.test(
  "5.1: client cell — actions or machine on a client cell throw at cell() time",
  () => {
    reset();
    let caught: Error | null = null;
    try {
      cell("view", {
        scope: "client" as const,
        state: { x: 0 },
        methods: {
          // deno-lint-ignore no-explicit-any
          noop(_s: any) {},
        },
        // deno-lint-ignore no-explicit-any
        actions: { noop: () => ({}) } as any,
      });
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(caught instanceof Error, true);
    reset();
  },
);

Deno.test(
  "5.1: client cell — composed alongside a server cell: server cell still works",
  () => {
    reset();
    const counter = cell("counter", {
      state: { count: 0 },
      methods: {
        // deno-lint-ignore no-explicit-any
        inc(s: any) {
          s.count++;
        },
      },
    });
    const view = cell("view", {
      scope: "client" as const,
      state: { filter: "all" },
      methods: {
        // deno-lint-ignore no-explicit-any
        setFilter(s: any, f: string) {
          s.filter = f;
        },
      },
    });
    const wiring = composeCellsWiring({
      cellEntries: [counter, view],
    });
    // Server cell is in the composition; client cell is not.
    assertEquals(wiring.composed.cellNames.includes("counter"), true);
    assertEquals(wiring.composed.cellNames.includes("view"), false);
    reset();
  },
);
