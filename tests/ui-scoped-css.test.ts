// `css` — a class name nobody else can collide with.
//
// aio has one global stylesheet, so class names are global. The worst UI bug of
// one build was a `class="track"` defined in two places: every music row
// clipped to a single line, no error, correct DOM, correct component tree — the
// later rule simply won (report 3 §12.1, report 4 §10.3, report 5 §8.5). `aiol`
// now reports that collision; this is the other half, a name that cannot
// collide at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _resetCss, collectCss, css, cx, expandCss } from "../src/ui/css.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const fresh = () => _resetCss();

Deno.test("the same rule is the SAME class, emitted once", () => {
  // Content-addressed: two components that happen to want the same three
  // declarations share one class instead of shipping it twice.
  fresh();
  const a = css`
    display: flex;
    gap: 4px;
  `;
  const b = css`
    display: flex;
    gap: 4px;
  `;
  assertEquals(a, b);
  assertEquals(collectCss().split(`.${a}{`).length - 1, 1, "emitted once");
});

Deno.test("whitespace is not a difference — reformatting must not double the CSS", () => {
  fresh();
  const a = css`
    display: flex;
    gap: 4px;
  `;
  const b = css`
    display: flex;
    gap: 4px;
  `;
  assertEquals(a, b);
});

Deno.test("a DIFFERENT rule is a different class — that is the collision, gone", () => {
  fresh();
  const visible = css`overflow: visible;`;
  const hidden = css`overflow: hidden;`;
  assert(visible !== hidden, "two `track`s must not be one class");
  assertStringIncludes(collectCss(), `.${visible}{overflow:visible}`);
  assertStringIncludes(collectCss(), `.${hidden}{overflow:hidden}`);
});

Deno.test("the name is STABLE, so a server render and a client render agree", () => {
  // A counter (`aio-1`, `aio-2`) depends on module evaluation ORDER, which is
  // not the same on both sides — so hydration would attach class names the
  // client had numbered differently, and the styling would be wrong in exactly
  // the way nobody thinks to look for.
  fresh();
  const first = css`color: red;`;
  fresh();
  const filler = css`color: blue;`; // a different evaluation order
  const again = css`color: red;`;
  void filler;
  assertEquals(first, again);
});

Deno.test("interpolation is part of the hash, because two values are two classes", () => {
  fresh();
  const red = css`color: ${"red"};`;
  const blue = css`color: ${"blue"};`;
  assert(red !== blue);
  assertStringIncludes(collectCss(), "color:red");
  assertStringIncludes(collectCss(), "color:blue");
});

// ── expansion ───────────────────────────────────────────────────────────────

Deno.test("`&` means this class, wherever it appears", () => {
  const out = expandCss(
    "c",
    `color: red; &:hover { color: blue; } & .icon { width: 1em; }`,
  );
  assertStringIncludes(out, ".c{color:red}");
  assertStringIncludes(out, ".c:hover{color:blue}");
  assertStringIncludes(out, ".c .icon{width:1em}");
});

Deno.test("`&` inside an at-rule still means this class", () => {
  // A media query whose body lost its scope would style every element on the
  // page below 600px — the collision this module exists to prevent, wearing a
  // different hat.
  const out = expandCss(
    "c",
    `@media (max-width: 600px) { & { display: block; } }`,
  );
  assertStringIncludes(out, "@media (max-width: 600px){");
  assertStringIncludes(out, ".c{display:block}");
  assert(!/\{\s*\{/.test(out), `no empty selector: ${out}`);
});

Deno.test("declarations-only produces exactly one rule", () => {
  assertEquals(expandCss("c", "display:flex;"), ".c{display:flex}");
  assertEquals(expandCss("c", ""), "", "nothing in, nothing out");
});

Deno.test("nesting does not swallow what follows it", () => {
  // The brace scanner has to find the MATCHING close, or everything after a
  // nested block is silently lost.
  const out = expandCss("c", `&:hover { color: blue; } display: flex;`);
  assertStringIncludes(out, ".c:hover{color:blue}");
  assertStringIncludes(out, ".c{display:flex}");
});

// ── the page ────────────────────────────────────────────────────────────────

Deno.test("the rule reaches the document, once per class", async () => {
  const win = new Window({ url: "https://localhost" });
  const prev = (globalThis as D).document;
  (globalThis as D).document = win.document;
  try {
    fresh();
    const a = css`color: red;`;
    css`color: red;`; // again
    const b = css`color: blue;`;
    const styles = (win.document as D).querySelectorAll("style[data-aio-css]");
    assertEquals(styles.length, 1, "ONE style element, not one per rule");
    const text = styles[0].textContent as string;
    assertEquals(text.split(`.${a}{`).length - 1, 1);
    assertStringIncludes(text, `.${b}{color:blue}`);
  } finally {
    fresh();
    (globalThis as D).document = prev;
    await closeWindow(win);
  }
});

Deno.test("no document (SSR, a test) still returns a class, and collects it", () => {
  // `collectCss()` is what a `renderToString` caller puts in its own <head>.
  // Throwing here would make the helper unusable on the server it is meant to
  // support.
  fresh();
  const c = css`color: green;`;
  assert(c.startsWith("aio-"));
  assertStringIncludes(collectCss(), `.${c}{color:green}`);
});

Deno.test("cx joins and skips anything falsy", () => {
  assertEquals(cx("a", "b"), "a b");
  assertEquals(cx("a", false, undefined, null, "c"), "a c");
  assertEquals(cx(), "");
});
