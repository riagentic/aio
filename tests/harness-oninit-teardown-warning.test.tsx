// A long-lived async `onInit` (a poll loop, a subscription it keeps open) is a
// normal cell. The harness holds teardown for a pending `onInit` so one that
// rejects just after the test body still fails the test — and when it is
// still running after that bounded wait, it is named. It was named as an
// "un-awaited call" with the advice to "await the call": no call was made,
// and an `onInit` cannot be awaited by the test.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A cell whose `onInit` runs until the test releases it. */
const looping = (id: string) => {
  let release!: () => void;
  const stop = new Promise<void>((r) => release = r);
  const c: Any = cell(id, {
    state: { n: 0 },
    methods: {},
    async onInit() {
      await stop;
    },
  });
  return { c, release };
};

async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = w;
  }
  return seen.filter((s) => s.includes("[aio:test]"));
}

function assertInitWarning(seen: string[], id: string): void {
  assertEquals(seen.length, 1, seen.join("\n---\n"));
  const msg = seen[0]!;
  assert(msg.includes(`${id}.onInit()`), msg);
  assert(msg.includes("still running"), msg);
  assert(!msg.includes("un-awaited call"), `not a call: ${msg}`);
  assert(!msg.includes("await the call"), `cannot be awaited: ${msg}`);
  assert(msg.includes("onDestroy"), `names the way to stop it: ${msg}`);
}

Deno.test("bootCells: an onInit still running at teardown is named as the cell's onInit, not an un-awaited call", async () => {
  const { c, release } = looping("init_loop_boot");
  try {
    const seen = await warnings(async () => {
      await using h = await bootCells([c]);
      void h;
    });
    assertInitWarning(seen, "init_loop_boot");
  } finally {
    release();
  }
});

Deno.test("testUI: an onInit still running at dispose() is named as the cell's onInit, not an un-awaited call", async () => {
  const { c, release } = looping("init_loop_ui");
  try {
    const App = () => <div>{String(c.n)}</div>;
    const seen = await warnings(async () => {
      const ui = await testUI(App as never, { cells: [c] });
      await ui.dispose();
    });
    assertInitWarning(seen, "init_loop_ui");
  } finally {
    release();
  }
});
