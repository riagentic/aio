// The contrast walk must not report from a cascade that is not a browser's —
// report 9 §1.
//
// happy-dom 17.6.3 takes any selector that begins with `:root` to match,
// whatever follows it. An app with two palettes and a non-matching palette
// declared LAST therefore computes that palette's custom properties on every
// element, and the walk reported pairs the app can never paint: `#000000` ink
// (the contrast palette's) on `#4a5b78` (the contrast palette's accent),
// 3.06:1, on a root that carries neither. The same engine hides the pairs the
// app DOES paint, so a silent walk was no pass either.
//
// RE-MEASURED (happy-dom 20.14.5, what `testUI` runs on now): the cascade is
// a browser's for these selectors. So two things must hold, and both are
// pinned here: on the engine testUI creates, the walk MEASURES the palette
// the root really has; on an engine with 17's cascade (a document an app
// makes from its own happy-dom 17 import and hands to testUI) it stands
// down with ONE line and never reports a finding from it. Its own file, so
// the once-per-process line is this test's.
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { canAuditContrast } from "../src/air/contrast-audit.ts";
import { closeWindow } from "../src/testing/close-window.ts";
import { breakRootCascade } from "./root-cascade-defect-helper.ts";

// Two palettes plus a high-contrast one, the non-matching one declared last.
// In a browser the root matches only `:root`: `#1a0f0a` on `#e07a58`, 6.2:1.
const CSS = `
:root { --bg: #ffffff; --ink: #1a1a1a; --accent: #e07a58; --accent-ink: #1a0f0a }
:root[data-palette="dark"] { --bg: #0a0c11; --ink: #e6e6e6 }
:root[data-palette="contrast"] { --bg: #000000; --ink: #ffffff; --accent: #4a5b78; --accent-ink: #000000 }
body { background-color: var(--bg); color: var(--ink) }
.badge { color: var(--accent-ink); background-color: var(--accent) }
`;

const App = () =>
  h("div", { class: "app" }, [
    h("style", null, [CSS]),
    h("span", { class: "badge badge--live" }, ["live"]),
  ]);

const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};

const unreadable = () => WARNS.filter((w) => w.includes("unreadable"));
const stoodDown = () =>
  WARNS.filter((w) => w.includes("colours could not be resolved here"));

Deno.test("contrast under testUI: the cascade is a browser's — the root's own palette is measured", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  const doc = ui.document;
  const html = doc.documentElement;

  // The premise, measured — so this fails loudly the day happy-dom's cascade
  // leaks a non-matching `:root…` rule again, instead of measuring colours
  // the app cannot paint.
  assertEquals(html.matches('[data-palette="contrast"]'), false);
  assertEquals(
    doc.defaultView.getComputedStyle(html).getPropertyValue("--accent").trim(),
    "#e07a58",
    "the root carries the default palette, as in a browser",
  );
  assertEquals(canAuditContrast(doc.querySelector(".app")), true);
  // `#1a0f0a` on `#e07a58` is 6.2:1 — measured, and fine.
  assertEquals(unreadable(), []);
  assertEquals(stoodDown(), [], "nothing to stand down from");
});

Deno.test("contrast under testUI: a cascade that is not a browser's is named, not measured", async () => {
  const spec = "happy-dom";
  const hd = await import(spec);
  const win = new hd.Window({ url: "http://localhost/" });
  breakRootCascade(win);
  try {
    const ui = await testUI(App as never, { document: win.document });
    try {
      await ui.settle();
      const doc = ui.document;
      const html = doc.documentElement;
      assertEquals(
        html.matches('[data-palette="contrast"]'),
        false,
        "the root does not carry the contrast palette",
      );
      assertEquals(
        doc.defaultView.getComputedStyle(html).getPropertyValue("--accent")
          .trim(),
        "#4a5b78",
        "this engine applies the non-matching palette declared last",
      );

      const root = doc.querySelector(".app");
      assertEquals(
        canAuditContrast(root),
        false,
        "'could not look' must be distinguishable from 'no findings'",
      );
      assertEquals(
        unreadable(),
        [],
        "no finding may come from colours the app cannot paint",
      );
      const said = stoodDown();
      assertEquals(said.length, 1, WARNS.join("\n"));
      assert(said[0]!.includes("run the app to check them"), said[0]);
      assert(said[0]!.includes('[data-palette="contrast"]'), said[0]);
    } finally {
      await ui.dispose();
    }
  } finally {
    await closeWindow(win);
  }
});
