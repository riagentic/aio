// Hydration's server/client divergence warning must fire ONLY on a real
// divergence.
//
// `_hydrateProps` re-applies every prop through `_writeProp` and, in dev,
// compares the element's attributes before and after: anything that changed is
// reported as "server markup that disagrees with the component", pointing the
// author at a `Date`/`random`/`window` in their render. That is the renderer's
// loudest dev warning and it is the right one to have — but it was measured
// firing on correct code:
//
//   * every element with an inline `style` (the SSR writer joins declarations
//     by hand, `_writeProp` goes through the CSSOM, which re-serializes them);
//   * every `<input readOnly>` (the SSR boolean-attribute table was keyed by
//     the JSX name `readOnly` while the lookup held the ATTRIBUTE name
//     `readonly`, so it shipped `readonly="true"` where mount builds
//     `readonly=""`);
//   * every `style={cond ? {…} : null}` in its false state (`cssText = ""`
//     materialized an empty `style=""` the server never emitted).
//
// A warning channel that cries wolf on the three most ordinary prop shapes
// there are is worse than no channel: it trains people to ignore the real ones.
// Nothing tested the warning's own claim, so this file does — as a MATRIX, so
// the next prop whose two spellings drift is caught by construction rather than
// by someone happening to look at a dev console.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h, renderToString, setDevMode, type VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  return { win, doc, cleanup: () => win.happyDOM.close() };
}

/** Run `fn` in dev mode, returning every `[aio-dev]` line it printed. */
function devWarnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  // A fresh dev-mode arm: `_devWarn` dedupes by id for the life of the mode,
  // so a matrix that armed once would only ever see its first case.
  setDevMode(false);
  setDevMode(true);
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[aio-dev]")) out.push(line);
    else orig(...a);
  };
  try {
    fn();
  } finally {
    console.warn = orig;
    setDevMode(false);
  }
  return out;
}

/** Every prop shape whose server spelling and client spelling could drift. */
const CASES: Array<[string, Record<string, unknown>]> = [
  ["div", { style: "color:red" }],
  ["div", { style: { color: "red", marginTop: 4 } }],
  ["div", { style: { opacity: 0.5, zIndex: 3 } }],
  ["div", { style: null }],
  ["div", { style: false }],
  ["div", { className: "a b" }],
  ["div", { className: ["a", "b"] }],
  ["div", { className: { a: true, b: false } }],
  ["div", { className: "" }],
  ["div", { id: "x", title: "t", "data-x": "1", "aria-label": "al" }],
  ["div", { tabIndex: 0 }],
  ["div", { hidden: true }],
  ["div", { role: "dialog" }],
  ["input", { readOnly: true }],
  ["input", { readOnly: false }],
  ["input", { disabled: true }],
  ["input", { value: "v" }],
  ["input", { value: "" }],
  ["input", { type: "checkbox", checked: true }],
  ["input", { type: "checkbox", checked: false }],
  ["input", { type: "checkbox", defaultChecked: true }],
  ["input", { defaultValue: "dv" }],
  ["input", { multiple: true }],
  ["input", { placeholder: "p", name: "n", required: true }],
  ["textarea", { readOnly: true }],
  ["textarea", { disabled: true }],
  ["select", { multiple: true, disabled: true }],
  ["button", { disabled: true, style: "color:red" }],
  ["a", { href: "/x", style: { color: "red" } }],
  ["img", { src: "/i.png", alt: "a", style: "width:2px" }],
  ["label", { htmlFor: "z" }],
  ["svg", { viewBox: "0 0 1 1" }],
  ["circle", { strokeWidth: 2, stopColor: "red" }],
];

Deno.test("hydrate: matching server markup produces NO divergence warning", () => {
  const { doc, cleanup } = env();
  try {
    for (const [tag, props] of CASES) {
      const App = () => h(tag, { ...props }) as VNode;
      const host = doc.createElement("main");
      doc.body.appendChild(host);
      host.innerHTML = renderToString(h(App, null));
      const before = host.innerHTML;
      const warns = devWarnings(() => {
        const handle = hydrate(host, App);
        _unmount(handle);
      });
      assertEquals(
        warns,
        [],
        `<${tag}> ${
          JSON.stringify(props)
        } hydrated its OWN server markup and ` +
          `was reported as a server/client divergence.\n  server: ${before}` +
          `\n  client: ${host.innerHTML}`,
      );
      host.remove();
    }
  } finally {
    cleanup();
  }
});

Deno.test("hydrate: a REAL divergence still warns (the control)", () => {
  const { doc, cleanup } = env();
  try {
    const App = () => h("div", { className: "client", style: "color:red" });
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    // Server said something else — exactly what the warning exists to report.
    host.innerHTML = `<div class="server" style="color:blue"></div>`;
    const warns = devWarnings(() => {
      const handle = hydrate(host, App);
      _unmount(handle);
    });
    assertEquals(warns.length, 1, warns.join("\n"));
    assert(
      warns[0]!.includes("class") && warns[0]!.includes("style"),
      `both diverged attributes must be named: ${warns[0]}`,
    );
  } finally {
    cleanup();
  }
});

Deno.test("SSR writes a boolean form attribute as the bare token, like mount", () => {
  const { doc, cleanup } = env();
  try {
    // The bug this pins: `readOnly` is the one `_DOM_PROPS` entry whose
    // attribute name differs from its JSX name, and the SSR boolean table was
    // keyed by the JSX name while the lookup held the attribute name.
    const bools: Array<[string, string, string]> = [
      ["input", "readOnly", "readonly"],
      ["textarea", "readOnly", "readonly"],
      ["input", "disabled", "disabled"],
      ["input", "checked", "checked"],
      ["input", "defaultChecked", "checked"],
      ["select", "multiple", "multiple"],
      ["option", "selected", "selected"],
    ];
    for (const [tag, prop, attr] of bools) {
      const html = renderToString(h(tag, { [prop]: true }));
      assert(
        new RegExp(`[ ]${attr}(?=[ />])`).test(html),
        `<${tag} ${prop}> must serialize as the bare boolean attribute ` +
          `\`${attr}\`, not \`${attr}="true"\` — got ${html}`,
      );
    }
  } finally {
    cleanup();
  }
});

Deno.test("a cleared style leaves no empty style attribute (mount == SSR)", () => {
  const { doc, cleanup } = env();
  try {
    for (const v of [null, false, undefined]) {
      const App = () => h("div", { style: v });
      const host = doc.createElement("main");
      doc.body.appendChild(host);
      const handle = mount(host, App);
      assertEquals(
        host.innerHTML,
        renderToString(h(App, null)),
        `style={${String(v)}} must build the same element on the client as ` +
          `the server writes`,
      );
      _unmount(handle);
      host.remove();
    }
  } finally {
    cleanup();
  }
});
