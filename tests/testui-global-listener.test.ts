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

Deno.test("testUI: a UI listener on the Deno global FAILS the test", async () => {
  // Tests are the strictest environment: the registration throws at the site
  // (a contained onMount error) AND the next observation point rethrows it,
  // so a green test can never hide an inert handler (field report §4.1).
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    const App = () => {
      onMount(() => {
        // The trap, verbatim.
        globalThis.addEventListener("keydown", () => {});
      });
      return h("div", null, "game");
    };
    const ui = await testUI(App);
    let thrown: unknown;
    try {
      await ui.settle();
    } catch (e) {
      thrown = e;
    } finally {
      await ui.dispose().catch(() => {});
    }
    assert(thrown instanceof Error, "settle() must rethrow the registration");
    const msg = thrown.message;
    assert(msg.includes("keydown"), `names the event: ${msg}`);
    assert(msg.includes("NEVER fire"), `says it will not work: ${msg}`);
    assert(msg.includes("happy-dom"), `says why: ${msg}`);
    assert(msg.includes("ui.window"), `and names the fix: ${msg}`);
    assert(
      errs.some((l) => l.includes("keydown")),
      "the hook error is also logged at the site (fail loud, twice is fine)",
    );
  } finally {
    console.error = origErr;
  }
});

Deno.test("testUI: the same registration on ui.window WORKS", async () => {
  let fired = 0;
  const App = () => {
    onMount(() => {
      // The fix the error names — the mount's own window, from the component.
      const w = (globalThis as { window?: Window }).window!;
      w.addEventListener("keydown", () => fired++);
    });
    return h("div", null, "game");
  };
  await using ui = await testUI(App);
  await ui.settle();
  assert(ui.window, "ui.window is exposed");
  assertEquals(ui.document, ui.window.document, "ui.document is ITS document");
  assertEquals(
    (globalThis as { window?: unknown }).window,
    ui.window,
    "and globalThis.window resolves to the same object while mounted",
  );
  ui.window.dispatchEvent(
    new ui.window.KeyboardEvent("keydown", { key: "a", bubbles: true }),
  );
  await ui.settle();
  assertEquals(fired, 1, "the handler ran");
});

Deno.test("testUI: outside test-strict mode the global listener only warns", async () => {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const g = globalThis as Record<string, unknown>;
  try {
    const App = () => {
      onMount(() => {
        g.__aioDev = false; // a test that specifically wants prod leniency
        try {
          globalThis.addEventListener("keydown", () => {});
        } finally {
          g.__aioDev = true;
        }
      });
      return h("div", null, "game");
    };
    await using ui = await testUI(App);
    await ui.settle();
    assert(
      lines.some((l) => l.includes("keydown") && l.includes("NEVER fire")),
      "prod path = observe-only warning (category a)",
    );
  } finally {
    console.warn = orig;
    g.__aioDev = true;
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
