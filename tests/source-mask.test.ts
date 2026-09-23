// `scripts/source-mask.ts` decides, at every `/`, "regex or division?" — and
// the gates built on it (the am sink gate, check-dead-wiring,
// check-persist-decider) are exactly as blind as that decision. A regex read
// as division scans its BODY as code (a backtick in it then blanks the rest of
// the file); a division read as a regex blanks real code up to the next `/`.
// Each case is pinned by what survives the mask: a marker call `m()` that is
// CODE must still be there, text inside a regex must not.
import { assertEquals } from "@std/assert";
import { mask } from "../scripts/source-mask.ts";

/** Does the code `m()` survive, and does the regex text `R` vanish? */
function seen(src: string): { code: boolean; regexText: boolean } {
  const m = mask(src);
  return { code: /\bm\(\)/.test(m), regexText: /R/.test(m) };
}

Deno.test("source-mask: a regex after an expression keyword is a regex", () => {
  for (
    const kw of [
      "return",
      "typeof",
      "void",
      "delete",
      "throw",
      "case",
      "else",
      "in",
      "of",
      "yield",
      "await",
      "new",
      "do",
      "instanceof",
    ]
  ) {
    // The backtick inside the regex would open a template if the regex were
    // read as division, and blank `m()` on the next line with it.
    const src = `function f(){ ${kw} /R\`/;\nm();\n}`;
    assertEquals(seen(src), { code: true, regexText: false }, kw);
  }
});

Deno.test("source-mask: a regex after the head of if/while/for/with is a regex", () => {
  for (const head of ["if (x)", "while (a(b))", "for (;;)", "with (o)"]) {
    const src = `${head} /R\`/.test(s);\nm();`;
    assertEquals(seen(src), { code: true, regexText: false }, head);
  }
});

Deno.test("source-mask: division stays division — values, calls, postfix, members", () => {
  for (
    const lhs of [
      "b++",
      "b--",
      "a",
      "f(x)",
      "(a + b)",
      "arr[0]",
      "10",
      "this",
      "o.return", // a MEMBER named like a keyword is a value
      "o.if(x)", // …and so is a call of one
    ]
  ) {
    // Read as a regex, `/ 2 + m() / 3` would be blanked and `m()` lost.
    const src = `const v = ${lhs} / 2 + m() / 3;`;
    assertEquals(seen(src).code, true, lhs);
  }
});

Deno.test("source-mask: the older positions still hold", () => {
  for (
    const src of [
      "const r = /R`/;\nm();",
      "f(/R`/, 1);\nm();",
      "x = a ? /R`/ : /R`/;\nm();",
      "const g = () => /R`/;\nm();",
      "/R`/.test(s);\nm();", // start of file
      "x = 1;\n/R`/.test(s);\nm();", // start of line
    ]
  ) assertEquals(seen(src), { code: true, regexText: false }, src);
  // A closing TAG in TSX is not a regex.
  assertEquals(seen("<a>x</a>; m(); <b>y</b>").code, true);
});
