// `testUI({ persist: true })` — the one mode meant to test a persistence flow.
//
// Two defects made it test the wrong thing:
//  1. the standalone boot ignored the `persistKey` the harness passed and used
//     `aio:testui` — a key in Deno's ON-DISK localStorage, so a persist mount
//     restored whatever a PREVIOUS `deno test` run left there;
//  2. dispose CANCELLED the 100 ms debounced save instead of flushing it, so
//     the last change before teardown never reached the store and the next
//     mount restored a stale value.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const counter = cell("persist-flow-counter", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n += 1;
    },
  },
});

function App() {
  return (
    <div>
      <span class="count">{counter.n}</span>
      <div class="button" onClick={() => counter.bump()}>Bump</div>
    </div>
  );
}

Deno.test("testUI persist: a previous run's aio:testui entry is never restored", async () => {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) return; // no host store → nothing to leak from
  ls.setItem(
    "aio:testui",
    JSON.stringify({ "persist-flow-counter": { n: 99 } }),
  );
  try {
    await using ui = await testUI(App, { persist: true });
    assertEquals(
      (ui.fullState(counter) as { n: number }).n,
      0,
      "a persist mount must not inherit a stale on-disk entry from another run",
    );
  } finally {
    ls.removeItem("aio:testui");
  }
});

Deno.test("testUI persist: dispose flushes the pending save, the next mount restores it", async () => {
  {
    await using ui = await testUI(App, { persist: true });
    ui.BumpButton.click();
    ui.BumpButton.click();
    await ui.expectCell(counter, (c) => c.n === 2);
    // Disposed well inside the 100 ms debounce window.
  }
  await using again = await testUI(App, { persist: true });
  assertEquals(
    (again.fullState(counter) as { n: number }).n,
    2,
    "the last change before teardown must be persisted, not cancelled",
  );
});
