// Bug hunt r2 (effects & lifecycle): an ASYNC onInit/onDestroy that rejects is
// guarded at boot (`initAll` — "An `async onInit` that rejects is the same
// failure as one that throws") but NOT on the registry's re-enable path, nor on
// disable / destroyAll for onDestroy. There the rejection escapes as an
// unhandled rejection: no INIT_ERROR / DESTROY_ERROR reaches onCellError, and
// the cell's error counter never moves.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import type { AioError } from "../src/diagnostics/error.ts";
import type { Msg } from "../src/state/cell-types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Collect unhandled rejections for the duration of `fn` (and a few turns). */
async function withUnhandled(fn: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRej = (e: PromiseRejectionEvent) => {
    seen.push(e.reason);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRej);
  try {
    fn();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRej);
  }
  return seen;
}

function mkApp(composed: Any) {
  let state = composed.initialState;
  return {
    dispatch: (a: Msg) => {
      state = composed.reduce(state, a).state;
    },
    getState: () => state,
  };
}

Deno.test("r2 hunt: async onInit rejecting on RE-ENABLE is reported as INIT_ERROR, like at boot", async () => {
  const c = cell("zzhookinit", {
    state: { n: 0 },
    methods: {
      bump(s: Any) {
        s.n++;
      },
    },
    onInit: async () => {
      await Promise.resolve();
      throw new Error("init boom");
    },
  } as Any);
  const errors: AioError[] = [];
  const composed: Any = composeCells([c], {
    onCellError: (e) => errors.push(e),
  });
  const app = mkApp(composed);

  // Boot path: guarded.
  const bootUnhandled = await withUnhandled(() => composed.initAll(app));
  assertEquals(bootUnhandled.length, 0, "boot: no unhandled rejection");
  assertEquals(
    errors.filter((e) => e.code === "INIT_ERROR").length,
    1,
    "boot reports INIT_ERROR",
  );

  // Re-enable path: the same failure.
  composed.registry.disable("zzhookinit", app);
  const reUnhandled = await withUnhandled(() =>
    composed.registry.enable("zzhookinit", app)
  );
  assertEquals(
    reUnhandled.length,
    0,
    `re-enable: async onInit rejection escaped as unhandled: ${reUnhandled}`,
  );
  assertEquals(
    errors.filter((e) => e.code === "INIT_ERROR").length,
    2,
    "re-enable reports INIT_ERROR too",
  );
});

Deno.test("r2 hunt: async onDestroy rejecting on disable is reported as DESTROY_ERROR", async () => {
  const c = cell("zzhookdestroy", {
    state: { n: 0 },
    methods: {
      bump(s: Any) {
        s.n++;
      },
    },
    onDestroy: async () => {
      await Promise.resolve();
      throw new Error("destroy boom");
    },
  } as Any);
  const errors: AioError[] = [];
  const composed: Any = composeCells([c], {
    onCellError: (e) => errors.push(e),
  });
  const app = mkApp(composed);
  composed.initAll(app);
  const un = await withUnhandled(() =>
    composed.registry.disable("zzhookdestroy", app)
  );
  assertEquals(
    un.length,
    0,
    `disable: async onDestroy rejection escaped as unhandled: ${un}`,
  );
  assert(
    errors.some((e) => e.code === "DESTROY_ERROR"),
    "disable reports DESTROY_ERROR for a rejecting async onDestroy",
  );
});

Deno.test("r2 hunt: async onDestroy rejecting in destroyAll (shutdown) is reported", async () => {
  const c = cell("zzhookdestroyall", {
    state: { n: 0 },
    methods: {
      bump(s: Any) {
        s.n++;
      },
    },
    onDestroy: async () => {
      await Promise.resolve();
      throw new Error("destroyAll boom");
    },
  } as Any);
  const errors: AioError[] = [];
  const composed: Any = composeCells([c], {
    onCellError: (e) => errors.push(e),
  });
  const app = mkApp(composed);
  composed.initAll(app);
  const un = await withUnhandled(() => composed.destroyAll(app));
  assertEquals(
    un.length,
    0,
    `destroyAll: async onDestroy rejection escaped as unhandled: ${un}`,
  );
  assert(
    errors.some((e) => e.code === "DESTROY_ERROR"),
    "destroyAll reports DESTROY_ERROR",
  );
});
