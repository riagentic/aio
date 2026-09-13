// The contrast walk must not report from a cascade that is not a browser's —
// report 9 §1.
//
// happy-dom 17.6.3, which `testUI` runs on, takes any selector that begins with
// `:root` to match, whatever follows it. An app with two palettes and a
// non-matching palette declared LAST therefore computes that palette's custom
// properties on every element, and the walk reported pairs the app can never
// paint: `#000000` ink (the contrast palette's) on `#4a5b78` (the contrast
// palette's accent), 3.06:1, on a root that carries neither. The same engine
// hides the pairs the app DOES paint, so a silent walk was no pass either.
//
// What must hold: under testUI the walk stands down with ONE line saying
// colours could not be resolved here, and never reports a finding from the
// broken cascade. Its own file, so the once-per-process line is this test's.
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { canAuditContrast } from "../src/air/contrast-audit.ts";

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

Deno.test("contrast under testUI: a cascade that is not a browser's is named, not measured", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();
  const doc = ui.document;
  const html = doc.documentElement;

  // The premise, measured — so this fails loudly the day happy-dom cascades
  // correctly, instead of passing on a guard that no longer guards anything.
  assertEquals(
    html.matches('[data-palette="contrast"]'),
    false,
    "the root does not carry the contrast palette",
  );
  assertEquals(
    doc.defaultView.getComputedStyle(html).getPropertyValue("--accent").trim(),
    "#4a5b78",
    "happy-dom applies the non-matching palette declared last",
  );

  const root = doc.querySelector(".app");
  assertEquals(
    canAuditContrast(root),
    false,
    "'could not look' must be distinguishable from 'no findings'",
  );
  const unreadable = WARNS.filter((w) => w.includes("unreadable"));
  assertEquals(
    unreadable,
    [],
    "no finding may come from colours the app cannot paint",
  );
  const said = WARNS.filter((w) =>
    w.includes("colours could not be resolved here")
  );
  assertEquals(said.length, 1, WARNS.join("\n"));
  assert(said[0]!.includes("run the app to check them"), said[0]);
  assert(said[0]!.includes('[data-palette="contrast"]'), said[0]);
});
