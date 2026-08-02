// a component that does `globalThis.addEventListener("keydown",
// …)` looks right — in a browser `window` IS the global — but under testUI the
// events are dispatched on the happy-dom window, so the handler never fires.
// No error, no clue. That cost one app its entire UI-test suite until it was
// diagnosed by hand, which is exactly the kind of silence this framework
// refuses elsewhere. Registration is the last moment we can still explain it.
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { onMount } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.warn = orig) };
}

Deno.test("testUI: a UI listener on the Deno global is called out", async () => {
  const cap = capture();
  try {
    const App = () => {
      onMount(() => {
        // The trap, verbatim.
        globalThis.addEventListener("keydown", () => {});
      });
      return h("div", null, "game");
    };
    await using ui = await testUI(App);
    await ui.settle();

    const warned = cap.lines.filter((l) => l.includes("keydown"));
    assert(warned.length > 0, "the inert listener must be reported");
    const msg = warned[0]!;
    assert(msg.includes("NEVER fire"), `says it will not work: ${msg}`);
    assert(msg.includes("happy-dom"), `says why: ${msg}`);
    assert(msg.includes("fix:"), `and how to fix it: ${msg}`);
  } finally {
    cap.restore();
  }
});

Deno.test("testUI: Deno's own lifecycle events stay silent", async () => {
  const cap = capture();
  try {
    const App = () => {
      onMount(() => {
        // Legitimately global — the framework's own test sandbox uses these.
        globalThis.addEventListener("unload", () => {});
        globalThis.addEventListener("unhandledrejection", () => {});
      });
      return h("div", null, "ok");
    };
    await using ui = await testUI(App);
    await ui.settle();
    assertEquals(
      cap.lines.filter((l) => l.includes("Deno global")),
      [],
      "process lifecycle listeners are not a mistake — no crying wolf",
    );
  } finally {
    cap.restore();
  }
});

Deno.test("testUI: the patched global is restored on teardown", async () => {
  const before = globalThis.addEventListener;
  {
    await using ui = await testUI(() => h("div", null, "x"));
    await ui.settle();
    assert(
      globalThis.addEventListener !== before,
      "patched while the harness is up",
    );
  }
  assertEquals(
    globalThis.addEventListener,
    before,
    "and handed back afterwards — a harness must not outlive its own test",
  );
});
