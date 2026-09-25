// <Markdown> must render a WIDE document — many siblings under one parent —
// not just a deep or a long one. Every block and inline run used to be handed
// on as spread arguments (`h("p", …, ...inline)`, `out.push(...parseInline())`),
// and V8 caps a call's argument count: past ~120k arguments the call throws
// `RangeError: Maximum call stack size exceeded`. A pasted 130 KB log of
// 65 000 short lines (each line a text node plus a <br>) threw out of the SSR
// render — a user-supplied comment taking the page down.
import { assert, assertEquals } from "@std/assert";
import { renderToString } from "../src/air/vdom.ts";
import { Markdown } from "../src/ui/markdown.ts";

const md = (source: string): string => renderToString(Markdown({ source }));
const count = (html: string, s: string): number => html.split(s).length - 1;

Deno.test("md wide: 100k siblings in one paragraph, list, link or document all render", () => {
  const N = 100_000;
  const cases: [string, string, string][] = [
    ["soft-wrapped lines", "a\n".repeat(N), "<br>"],
    ["inline runs", "`a` ".repeat(N), "<code"],
    ["list items", "- a\n".repeat(N), "<li>"],
    ["headings", "# a\n".repeat(N), "<h1>"],
    ["link label", "[" + "**a** ".repeat(N) + "](https://x)", "<strong>"],
  ];
  assertEquals(cases.length, 5);
  for (const [name, source, tag] of cases) {
    let html = "";
    try {
      html = md(source);
    } catch (e) {
      throw new Error(`${name}: render threw ${String(e)}`);
    }
    const n = count(html, tag);
    // Soft wraps: one <br> between each pair of lines.
    assert(n >= N - 1, `${name}: expected ~${N} ${tag}, got ${n}`);
  }
});

Deno.test("md wide: a chunked wide render is the same markup as a narrow one", () => {
  // The chunking must be invisible: the N-line document's HTML is the 1-line
  // document's HTML with the middle repeated.
  const one = md("a");
  const many = md("a\n".repeat(20_000).trimEnd());
  assertEquals(
    many,
    one.replace(">a<", ">" + Array(20_000).fill("a").join("<br>") + "<"),
  );
});
