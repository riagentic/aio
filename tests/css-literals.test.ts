// `css``` and the two things it read as structure when they were text.
//
// The generated stylesheet is ONE `<style>` element shared by the whole page,
// so anything that can close a rule can write a rule. Two ways in:
//
//  • A QUOTED STRING. `content: ", "` normalised to `content:","` and lost its
//    space — silent, visual, and the exact "correct code, wrong pixels" class
//    the module was written to end — while a `{` or `}` inside a string or a
//    comment derailed the brace scanner, threw the component's own rule away
//    and appended an unbalanced `}` to the shared sheet.
//  • An INTERPOLATED VALUE. `` css`color: ${c}` `` is the spelling the
//    docstring advertises, and with `c` coming from state a brace in it closed
//    the rule and opened another: global CSS an app never wrote.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _resetCss, collectCss, css } from "../src/ui/css.ts";

function withDev<T>(on: boolean, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const before = g.__aioDev;
  g.__aioDev = on;
  try {
    return fn();
  } finally {
    g.__aioDev = before;
  }
}

Deno.test("css: a quoted string keeps its spaces", () => {
  _resetCss();
  css`
    display: inline;
    &:not(:last-child)::after {
      content: ", ";
    }
  `;
  css`
    &::before {
      content: "Name: ";
    }
  `;
  const sheet = collectCss();
  assertStringIncludes(sheet, 'content:", "');
  assertStringIncludes(sheet, 'content:"Name: "');
  _resetCss();
});

Deno.test("css: a brace inside a string is text, not structure", () => {
  _resetCss();
  const cls = css`
    content: "{";
    color: red;
  `;
  const sheet = collectCss();
  assertStringIncludes(sheet, `.${cls}{`, "the component keeps its own rule");
  assertStringIncludes(sheet, 'content:"{"');
  assertEquals(
    (sheet.match(/\{/g) ?? []).length,
    (sheet.match(/\}/g) ?? []).length + 1,
    "the only unmatched brace is the one inside the string",
  );
  _resetCss();
});

Deno.test("css: a comment is dropped, braces inside it included", () => {
  _resetCss();
  const a = css`color: red;`;
  _resetCss();
  const b = css`
    /* } not a block */
    color: red;
  `;
  assertEquals(b, a, "a comment does not change the rule, so not the hash");
  assertStringIncludes(collectCss(), `.${b}{color:red}`);
  _resetCss();
});

Deno.test("css: two rules differing only INSIDE a string are two classes", () => {
  _resetCss();
  const a = css`content: "a";`;
  const b = css`content: "b";`;
  assert(a !== b, "the literal is part of the rule, so part of the hash");
  _resetCss();
});

Deno.test("css: an interpolated brace throws in dev", () => {
  _resetCss();
  const evil = "red} .secret{display:none";
  let threw = "";
  withDev(true, () => {
    try {
      css`color: ${evil};`;
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
  });
  assertStringIncludes(threw, "interpolated value contains a brace");
  assertEquals(collectCss(), "", "and nothing reached the stylesheet");
  _resetCss();
});

Deno.test("css: outside dev the braces are stripped, loudly — never a new rule", () => {
  _resetCss();
  const realError = console.error;
  const said: string[] = [];
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  let cls = "";
  try {
    withDev(false, () => {
      cls = css`color: ${"red} .secret{display:none"};`;
    });
  } finally {
    console.error = realError;
  }
  const sheet = collectCss();
  assertEquals(said.length, 1, "it degrades LOUDLY");
  // The whole sheet is ONE rule, for this class, with no brace inside it: the
  // value is a broken declaration the browser drops, which is the degradation
  // this path promises. What must never appear is a second selector.
  assert(
    new RegExp(`^\\.${cls}\\{[^{}]*\\}$`).test(sheet),
    `something escaped the generated rule: ${sheet}`,
  );
  _resetCss();
});

Deno.test("css: an interpolated value cannot close the <style> element", () => {
  // One level out from the brace: the generated sheet is SERVED inside a
  // `<style>`, whose content is raw text — nothing in CSS escapes a closing
  // tag. Measured before the guard: `content: "${v}"` with
  // v = `</style><img src=x onerror=…>` put a working <img> in the page.
  _resetCss();
  let threw = "";
  withDev(true, () => {
    try {
      css`content: "${"</style><img src=x onerror=alert(1)>"}";`;
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
  });
  assertStringIncludes(threw, "</");
  assertEquals(collectCss(), "");
  _resetCss();
});

Deno.test("css: a rule can never end the <style> it is served in", () => {
  // The quiet half: written DIRECTLY in the template, no interpolation, so
  // the guard above never sees it. The emitted rule must still be inert.
  _resetCss();
  css`content: "</style><b>x</b>";`;
  const sheet = collectCss();
  assert(
    !/<\/\s*style/i.test(sheet),
    `the sheet can close its own element: ${sheet}`,
  );
  // …and it still MEANS the same thing: \00003c is the CSS escape for `<`.
  assert(
    sheet.includes("00003c /style>"),
    `the < was not CSS-escaped: ${sheet}`,
  );
  _resetCss();
});

Deno.test("css: an ordinary interpolation still works", () => {
  _resetCss();
  const cls = css`
    color: ${"rebeccapurple"};
    padding: ${4}px;
  `;
  assertStringIncludes(
    collectCss(),
    `.${cls}{color:rebeccapurple;padding:4px}`,
  );
  _resetCss();
});

Deno.test("css: nested blocks and at-rules still expand", () => {
  _resetCss();
  const cls = css`
    display: flex;
    &:hover {
      background: red;
    }
    @media (max-width: 600px) {
      & {
        display: block;
      }
    }
  `;
  const sheet = collectCss();
  assertStringIncludes(sheet, `.${cls}{display:flex}`);
  assertStringIncludes(sheet, `.${cls}:hover{background:red}`);
  // The at-rule PRELUDE is not normalised — it is copied through verbatim, so
  // the space after the colon in a media feature survives.
  assertStringIncludes(
    sheet,
    `@media (max-width: 600px){.${cls}{display:block}}`,
  );
  _resetCss();
});
