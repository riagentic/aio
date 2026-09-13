// Two holes in the unobserved-call ledger, both "same app code, different
// verdict":
//
// 1. SYNC methods were never ledgered in `testUI`/`bootCells`. The runtime's
//    bound method pre-catches a reducer throw (fire-and-forget callers must not
//    crash the app), so `onClick={() => c.validate()}` with a throwing reducer
//    logged REDUCE_ERROR and PASSED there — while `testCell` failed the same
//    call (as an uncaught rejection that also cancelled the rest of the file).
//
// 2. A failing call fired on the line before teardown passed: `dispose()` read
//    the ledger before the rejection had landed, and the runtime reset then
//    orphaned the call. The old guard slept 20ms before `dispose()`, which is
//    the one gap a real test never leaves.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells, testCell, testUI } from "../src/testing/cell-test.ts";
import { h } from "../src/air/vdom.ts";

const syncBoom = (name: string) =>
  cell(name, {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
      boom(_s: { n: number }) {
        throw new Error(`${name}: sync-kaboom`);
      },
      // deno-lint-ignore require-await
      async aboom(_s: { n: number }) {
        await Promise.resolve();
        throw new Error(`${name}: async-kaboom`);
      },
    },
  });

const App = () => h("div", { class: "button" }, "Go");

/** Capture console.warn lines for the length of `body`. */
async function warnings(body: () => unknown): Promise<string[]> {
  const said: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    await body();
  } finally {
    console.warn = w;
  }
  return said;
}

// ── 1. sync-method failures nobody awaited ──

const tcSync = syncBoom("hus1");
testCell(
  tcSync,
  "testCell: an un-awaited SYNC throw surfaces at settle()",
  async (t) => {
    t.send.boom();
    await assertRejects(() => t.settle(), Error, "hus1: sync-kaboom");
  },
);

testCell(
  tcSync,
  "testCell: an awaited SYNC throw is not reported again",
  async (t) => {
    await assertRejects(() => t.send.boom(), Error, "hus1: sync-kaboom");
    await t.settle();
  },
);

const bcSync = syncBoom("hus2");
Deno.test("bootCells: an un-awaited SYNC throw surfaces at settle()", async () => {
  const h1 = await bootCells([bcSync]);
  try {
    bcSync.boom();
    const e = await assertRejects(() => h1.settle());
    assertStringIncludes((e as Error).message, "hus2.boom()");
    assertStringIncludes((e as Error).message, "hus2: sync-kaboom");
    assertStringIncludes((e as Error).message, "nothing awaited it");
  } finally {
    h1.dispose();
  }
});

Deno.test("bootCells: an awaited SYNC throw is not reported again", async () => {
  using h1 = await bootCells([bcSync]);
  await assertRejects(() => bcSync.boom(), Error, "hus2: sync-kaboom");
  await h1.settle();
});

const uiSync = syncBoom("hus3");
Deno.test("testUI: an un-awaited SYNC throw surfaces at settle()", async () => {
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App as any, { cells: [uiSync] as any });
  try {
    uiSync.boom(); // the onClick shape
    const e = await assertRejects(() => ui.settle());
    assertStringIncludes((e as Error).message, "hus3.boom()");
    assertStringIncludes((e as Error).message, "nothing awaited it");
  } finally {
    await ui.dispose();
  }
});

// ── 2. a failing call fired immediately before teardown ──

const uiTear = syncBoom("hus4");
Deno.test("testUI: dispose() right after an un-awaited failing call fails", async () => {
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App as any, { cells: [uiTear] as any });
  uiTear.aboom();
  const e = await assertRejects(() => ui.dispose());
  assertStringIncludes((e as Error).message, "hus4: async-kaboom");
});

Deno.test("testUI: dispose() right after an un-awaited SYNC throw fails", async () => {
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App as any, { cells: [uiTear] as any });
  uiTear.boom();
  const e = await assertRejects(() => ui.dispose());
  assertStringIncludes((e as Error).message, "hus4: sync-kaboom");
});

const bcTear = syncBoom("hus5");
Deno.test("bootCells: `await using` waits for the call fired on the line before", async () => {
  const e = await assertRejects(async () => {
    await using _h1 = await bootCells([bcTear]);
    bcTear.aboom();
  });
  assertStringIncludes((e as Error).message, "hus5: async-kaboom");
});

Deno.test("bootCells: sync dispose() after a SYNC throw fails loud, not never", async () => {
  // The rejection already happened when the reducer threw; only its handler
  // is a microtask away. A synchronous teardown cannot wait for it, so it is
  // rethrown where nothing can swallow it — an unhandled rejection.
  let caught: unknown;
  const onUnhandled = (ev: PromiseRejectionEvent) => {
    caught = ev.reason;
    ev.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    {
      using _h1 = await bootCells([bcTear]);
      bcTear.boom();
    }
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  assert(caught instanceof Error, "the sync throw vanished at teardown");
  assertStringIncludes((caught as Error).message, "hus5.boom()");
  assertStringIncludes((caught as Error).message, "nothing awaited it");
});

Deno.test("bootCells: a sync dispose() after a SUCCESSFUL sync call is silent", async () => {
  // The ordinary shape must not start warning: a sync call has already
  // committed by the time it returns, so there is nothing to abandon.
  const said = await warnings(async () => {
    {
      using _h1 = await bootCells([bcTear]);
      bcTear.inc();
      assertEquals(bcTear.n, 1);
    }
    await new Promise((r) => setTimeout(r, 10));
  });
  assertEquals(said.filter((m) => m.includes("still in flight")), []);
});
