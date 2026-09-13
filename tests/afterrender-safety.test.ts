// afterRender safety: a lifecycle hook that reaches for global
// `document` where there's none (testUI/SSR) must NOT silently collapse the
// rendered surface — the error is caught, logged with an actionable hint, and
// the rest of the UI renders normally.
import { assertStringIncludes } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { onMount } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";

Deno.test("afterRender: a throwing hook does not collapse the surface", async () => {
  function Panel() {
    // Simulate one app's bug: reach for a global that isn't there in testUI.
    onMount(() => {
      (globalThis as { document?: unknown }).document;
      throw new Error("document is not defined");
    });
    return h("div", { class: "panel" }, "panel-content");
  }
  const App = () =>
    h(
      "div",
      null,
      h("h1", null, "Title"),
      h(Panel, null),
      h("footer", null, "foot"),
    );

  // The throw IS the subject here, so it stays contained. Without this,
  // `settle()` now raises it — a hook that throws is reported by testUI
  // rather than only logged, because an `onClick` TypeError reported as a
  // PASS is exactly what the harness exists to prevent.
  const ui = await testUI(App, { allowContainedErrors: true });
  await ui.settle();
  const html = ui.html();
  // The whole tree still rendered — NOT collapsed to just <App/>.
  assertStringIncludes(html, "Title");
  assertStringIncludes(html, "panel-content");
  assertStringIncludes(html, "foot");
  await ui.dispose();
});
