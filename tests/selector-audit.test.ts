// The `#root` contract, made loud.
//
// aio mounts into `<div id="root">` and nothing said so. An app's stylesheet
// did what any web developer's would — `html, body, #app { height: 100% }`,
// where `#app` was the author's own wrapper name — and the height chain broke
// at the top. The grid fell back to min-content, a long list stretched the page
// to 6 886 px, and the canvas inside it sized its own drawing buffer to
// 1824 × 13772. The 3D view was stretched tenfold for HOURS, while FPS and
// triangle counts stayed healthy and every `am` command reported fine. The
// author "fixed" their camera maths twice before reading a screenshot's pixel
// dimensions.
//
// Their verdict is why this test exists: "The framework's stated first
// principle is fail loud, never silent. This is a silent, detectable
// divergence." Detectable in one line.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  _resetSelectorAudit,
  auditIdSelectors,
  idsInStyleSheets,
} from "../src/air/selector-audit.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";

async function withDoc(
  html: string,
  fn: (doc: Document, warns: string[]) => void,
): Promise<void> {
  const win = new Window({ url: "https://x.test" });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = html;
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => warns.push(String(m));
  try {
    setDevModeOverride(true);
    _resetSelectorAudit();
    fn(doc, warns);
  } finally {
    console.warn = real;
    await closeWindow(win);
  }
}

Deno.test("selectors: a styled id that exists nowhere is named, with the real root", () =>
  withDoc(
    `<style>html, body, #app { height: 100% }</style><div id="root"><p>hi</p></div>`,
    (doc, warns) => {
      assertEquals(auditIdSelectors(doc, "root"), 1, warns.join("\n"));
      assert(warns[0]!.includes("#app"), warns[0]);
      assert(
        warns[0]!.includes("#root"),
        `"#app matches nothing" is a puzzle; "#app matches nothing — aio ` +
          `mounts into #root" is a one-line fix: ${warns[0]}`,
      );
    },
  ));

Deno.test("selectors: styling the real root is silent", () =>
  withDoc(
    `<style>html, body, #root { height: 100% }</style><div id="root"><p>hi</p></div>`,
    (doc, warns) => {
      assertEquals(auditIdSelectors(doc, "root"), 0, warns.join("\n"));
    },
  ));

Deno.test("selectors: an id that DOES exist is silent", () =>
  withDoc(
    `<style>#sidebar { width: 200px }</style><div id="root"><nav id="sidebar"></nav></div>`,
    (doc, warns) => {
      assertEquals(auditIdSelectors(doc, "root"), 0, warns.join("\n"));
    },
  ));

Deno.test("selectors: it warns ONCE per id, however many times it renders", () =>
  withDoc(
    `<style>#app { height: 100% }</style><div id="root"></div>`,
    (doc, warns) => {
      assertEquals(auditIdSelectors(doc, "root"), 1);
      assertEquals(auditIdSelectors(doc, "root"), 0);
      assertEquals(auditIdSelectors(doc, "root"), 0);
      assertEquals(
        warns.length,
        1,
        "a per-render warning is noise, not signal",
      );
    },
  ));

Deno.test("selectors: ids inside @media are found too", () =>
  withDoc(
    `<style>@media (min-width: 100px) { #panel { display: grid } }</style><div id="root"></div>`,
    (doc) => {
      assert(
        idsInStyleSheets(doc).has("panel"),
        "a responsive layout is exactly where a root-id rule lives",
      );
    },
  ));

Deno.test("selectors: production is untouched", () =>
  withDoc(
    `<style>#app { height: 100% }</style><div id="root"></div>`,
    (doc, warns) => {
      setDevModeOverride(false);
      _resetSelectorAudit();
      assertEquals(auditIdSelectors(doc, "root"), 0);
      assertEquals(warns.length, 0);
      setDevModeOverride(true);
    },
  ));
