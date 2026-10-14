// `check:placeholders` reads source character by character to tell a
// template literal (where `${…}` interpolates) from a quoted string (where it
// is printed as written). It reported three TRUE templates in
// src/server/server.ts: a template above them held, inside a `${…}`, a quoted
// string with a backtick and a brace in it — the scanner took that brace for
// the expression's end and that backtick for the template's, and read the
// rest of the file inside-out.
import { assertEquals } from "@std/assert";
import { scanText } from "../scripts/check-placeholders.ts";

const lines = (src: string) => scanText(src).map((h) => h.line);

Deno.test("placeholders scanner: a quoted ${…} is a hit, a template's is not", () => {
  assertEquals(lines('const a = "route ${pattern}";'), [1]);
  assertEquals(lines("const a = `route ${pattern}`;"), []);
  assertEquals(lines("const a = 'x ${y}'; // aio-ok: shown as source"), []);
});

Deno.test("placeholders scanner: code inside ${…} is read as code — a string's backtick or brace, an object's braces and a nested template end nothing", () => {
  for (
    const tpl of [
      // the shape that was misread, laid out as it stood
      '`a ${\n  x === undefined\n    ? "declare `auth: { publicDir }`"\n    : `under /${x}/`\n}; keep ` +\n  `b`',
      "`a ${f({ k: 1 })} b`",
      "`a ${g('}')} ${h(\"`\")} b`",
      "`a ${`b ${`c ${d}`}`} e`",
    ]
  ) {
    const src = `const t = ${tpl};\n` +
      'log(`route "${p}" threw — ${e}`);\n' +
      'const hit = "left ${as} written";';
    // Only the quoted one, on ITS line: nothing after the template is read
    // inside-out (the true template above it was the false report).
    assertEquals(lines(src), [src.split("\n").length], tpl);
  }
});
