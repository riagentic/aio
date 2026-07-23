import { assertEquals } from "@std/assert";
import { bindCell, cell, composeCells } from "../src/state/cell.ts";

// Tests for 2.1: server-side bound methods all return a Promise that
// resolves once dispatch is complete. Sync → Promise<void>; async → Promise<R>.

function createApp(
  composed: ReturnType<typeof composeCells>,
): {
  state: Record<string, unknown>;
  dispatch: (a: { type: string; payload: unknown }) => Promise<void>;
} {
  let state = composed.initialState;
  return {
    get state() {
      return state;
    },
    dispatch(action) {
      const result = composed.reduce(state, action);
      state = result.state;
      for (const eff of result.effects) {
        composed.execute(
          { dispatch: () => Promise.resolve(), getState: () => state },
          eff as never,
        );
      }
      return Promise.resolve();
    },
  };
}

Deno.test("2.1 A: bound sync method returns a Promise that resolves to undefined", async () => {
  const counter = cell("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });

  const composed = composeCells([counter]);
  const app = createApp(composed);
  bindCell(
    counter,
    (a) => app.dispatch(a as never),
    () => app.state as Record<string, unknown>,
  );

  const ret =
    (counter as unknown as { increment: (...a: unknown[]) => unknown })
      .increment(5);
  assertEquals(ret instanceof Promise, true);
  await ret;
  assertEquals(
    (app.state.counter as { count: number }).count,
    5,
    "state must reflect the change by the time await resolves",
  );
});

Deno.test("2.1 B: bound sync method preserves .type metadata", () => {
  const counter = cell("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });

  const composed = composeCells([counter]);
  const app = createApp(composed);
  bindCell(
    counter,
    (a) => app.dispatch(a as never),
    () => app.state as Record<string, unknown>,
  );

  const fn = (counter as unknown as { increment: { type: string } }).increment;
  assertEquals(fn.type, "counter:increment");
});

Deno.test("2.1 C: bound async method returns a Promise<R> with the return value", async () => {
  const math = cell("math", {
    state: { lastResult: 0 },
    methods: {
      // deno-lint-ignore require-await
      async double(s, n: number) {
        return n * 2;
      },
    },
  });

  const composed = composeCells([math]);
  const app = createApp(composed);
  bindCell(
    math,
    (a) => app.dispatch(a as never),
    () => app.state as Record<string, unknown>,
  );

  const ret = (math as unknown as { double: (...a: unknown[]) => unknown })
    .double(21);
  assertEquals(ret instanceof Promise, true);
  const v = await ret;
  assertEquals(v, 42);
});

Deno.test(
  "2.1 D: bound sync method is awaitable multiple times — both awaits see post-dispatch state",
  async () => {
    const counter = cell("counter", {
      state: { count: 0 },
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });

    const composed = composeCells([counter]);
    const app = createApp(composed);
    bindCell(
      counter,
      (a) => app.dispatch(a as never),
      () => app.state as Record<string, unknown>,
    );

    const inc = (counter as unknown as {
      increment: (...a: unknown[]) => Promise<void>;
    }).increment;
    await inc(2);
    assertEquals((app.state.counter as { count: number }).count, 2);
    await inc(3);
    assertEquals((app.state.counter as { count: number }).count, 5);
  },
);

// ── 2.3: Pre-binding behavior ─────────────────────────────────────────────

Deno.test(
  "2.3: calling a method before boot ALWAYS throws (dev + prod) — risoto: no silent no-op",
  () => {
    for (const dev of [true, false]) {
      (globalThis as Record<string, unknown>).__aioDev = dev;
      try {
        const counter = cell(`counter_${dev}`, {
          state: { count: 0 },
          methods: {
            increment(s) {
              s.count++;
            },
          },
        });
        let caught: Error | null = null;
        try {
          (counter as unknown as { increment: () => void }).increment();
        } catch (e) {
          caught = e as Error;
        }
        assertEquals(
          caught instanceof Error,
          true,
          `expected throw (dev=${dev})`,
        );
        // Loud + actionable, regardless of dev/prod — a pre-boot write must
        // never silently vanish.
        assertEquals(
          (caught as Error).message.includes(
            "before the cell's runtime is booted",
          ),
          true,
        );
      } finally {
        (globalThis as Record<string, unknown>).__aioDev = false;
      }
    }
  },
);

Deno.test(
  "2.3: bindCell replaces the unbound guard — calling no longer throws",
  () => {
    (globalThis as Record<string, unknown>).__aioDev = true;
    try {
      const counter = cell("counter3", {
        state: { count: 0 },
        methods: {
          increment(s) {
            s.count++;
          },
        },
      });

      const composed = composeCells([counter]);
      const app = createApp(composed);
      bindCell(
        counter,
        (a) => app.dispatch(a as never),
        () => app.state as Record<string, unknown>,
      );

      // Post-binding: should not throw, should return a Promise<void>.
      const ret = (counter as unknown as { increment: () => unknown })
        .increment();
      assertEquals(ret instanceof Promise, true);
    } finally {
      (globalThis as Record<string, unknown>).__aioDev = false;
    }
  },
);

Deno.test(
  "fire-and-forget async method that throws does NOT leak an unhandled rejection",
  async () => {
    // The server-side twin used to return the call promise without a safety
    // .catch(), so `cell.asyncMethod()` (no await) whose body threw escaped as
    // an unhandled rejection and killed the Deno process. Deno's test runner
    // fails a test on an unhandled rejection, so this reproduces the crash.
    const realError = console.error;
    console.error = () => {}; // silence the expected executor error log
    try {
      const boom = cell("boom", {
        state: { n: 0 },
        methods: {
          // deno-lint-ignore require-await
          async explode(_s) {
            throw new Error("kaboom");
          },
        },
      });
      const composed = composeCells([boom]);
      const app = createApp(composed);
      bindCell(
        boom,
        (a) => app.dispatch(a as never),
        () => app.state as Record<string, unknown>,
      );
      // Fire-and-forget — no await. Must not produce an unhandled rejection.
      (boom as unknown as { explode: () => void }).explode();
      // Let the microtask/timer queue drain so any rejection would surface.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = realError;
    }
  },
);
