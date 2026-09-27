// `src/diagnostics/code-mask.ts` decides, at every `/`, "regex or division?" —
// and every scanner built on it (graph-validator, graph-audit, removals, aiol,
// check-boundaries / check-lock / check-silent-catch / check-temp-dirs) is
// exactly as blind as that decision. A regex read as division scans its BODY as
// code (`return /module not found/` then "mentions" `module`; a quote in it
// blanks real code to the end of the line); a division read as a regex blanks
// real code up to the next `/`. Each case is pinned by the EXACT masked text.
import { assert, assertEquals } from "@std/assert";
import {
  codeMask,
  codeText,
  regexStart,
} from "../src/diagnostics/code-mask.ts";

/** Blank-for-blank expectation: `_` in `want` marks a blanked offset. */
function assertMasks(src: string, want: string): void {
  assertEquals(want.length, src.length, "fixture: want must match src length");
  assertEquals(codeText(src), want.replaceAll("_", " "), src);
}

Deno.test("code-mask: a regex after an expression keyword is a regex", () => {
  for (
    const kw of [
      "return",
      "typeof",
      "instanceof",
      "in",
      "of",
      "new",
      "delete",
      "void",
      "throw",
      "case",
      "do",
      "else",
      "yield",
      "await",
    ]
  ) {
    // The quote inside the regex would open a string if the regex were read
    // as division, and blank `m()` behind it.
    const src = `${kw} /R"/; m();`;
    assertMasks(src, `${kw} /__/; m();`);
    assert(regexStart(src, kw.length + 1), kw);
  }
});

Deno.test("code-mask: return /re/.test(s) — the field case", () => {
  assertMasks(
    `return /^Deno\\//i.test(ua.trim()) ? A : B;`,
    `return /_______/i.test(ua.trim()) ? A : B;`,
  );
  assertMasks(
    `return /x"(y)"/.exec(src)?.[1] ?? null;`,
    `return /______/.exec(src)?.[1] ?? null;`,
  );
});

Deno.test("code-mask: a regex after the head of if/while/for/with", () => {
  for (const kw of ["if", "while", "for", "with"]) {
    assertMasks(`${kw} (x) /R"/.test(s);`, `${kw} (x) /__/.test(s);`);
    assertMasks(`${kw}(f(a)) /R/.test(s);`, `${kw}(f(a)) /_/.test(s);`);
  }
});

Deno.test("code-mask: `)` of a call or group divides", () => {
  assertMasks(`f(x) / 2 / g(y);`, `f(x) / 2 / g(y);`);
  assertMasks(`(a + b) / c / d;`, `(a + b) / c / d;`);
  // A member named `if(...)` is a method call, not a statement head.
  assertMasks(`o.if(x) / 2 / 3;`, `o.if(x) / 2 / 3;`);
});

Deno.test("code-mask: postfix ++ / -- ends an operand, so `/` divides", () => {
  assertMasks(`a++ / 2; m(); b / 3;`, `a++ / 2; m(); b / 3;`);
  assertMasks(`a-- / 2; m(); b / 3;`, `a-- / 2; m(); b / 3;`);
});

Deno.test("code-mask: a member named like a keyword is a value", () => {
  assertMasks(`o.return / 2; m(); b / 3;`, `o.return / 2; m(); b / 3;`);
  assertMasks(`o?.return / 2; m(); b / 3;`, `o?.return / 2; m(); b / 3;`);
  assertMasks(`o.typeof / 2; m(); b / 3;`, `o.typeof / 2; m(); b / 3;`);
  // A name that merely STARTS like a keyword is a name.
  assertMasks(`returned / 2; m(); b / 3;`, `returned / 2; m(); b / 3;`);
});

Deno.test("code-mask: chained division stays code", () => {
  assertMasks(`x = y / z / w;`, `x = y / z / w;`);
  assertMasks(`x = 10 / z / w;`, `x = 10 / z / w;`);
  assertMasks(`x = this / z / w;`, `x = this / z / w;`);
});

Deno.test("code-mask: operator / line start / file start open a regex", () => {
  assertMasks(`x = /R/g;`, `x = /_/g;`);
  assertMasks(`f(/R/, [/R/]);`, `f(/_/, [/_/]);`);
  assertMasks(`/R/.test(s);`, `/_/.test(s);`);
  assertMasks(`a;\n  /R/.test(s);`, `a;\n  /_/.test(s);`);
});

Deno.test("code-mask: a JSX closing tag is not a regex", () => {
  assertMasks(`<div>{a}</div><b>{c}</b>`, `<div>{a}</div><b>{c}</b>`);
});

Deno.test("code-mask: template ${a / b} is template content; code after survives", () => {
  assertMasks("t = `x${a / b}y`; m();", "t = `__________`; m();");
});

Deno.test("code-mask: `/` and `\\/` inside a regex class or escape", () => {
  assertMasks(`x = /[/]"/; m();`, `x = /____/; m();`);
  assertMasks(`x = /a\\/b"/; m();`, `x = /_____/; m();`);
  assertMasks(`x = /[\\]/]/; m();`, `x = /_____/; m();`);
});

Deno.test("code-mask: an unterminated `/` on its line is division after all", () => {
  assertMasks(`a = b /\nc; m();`, `a = b /\nc; m();`);
  // A `/` in regex position with no close on ITS line does not reach the
  // next line for one: `m()` below stays code.
  assertMasks(`x = /\nm(); a / b;`, `x = /\nm(); a / b;`);
});

Deno.test("code-mask: offsets and newlines are preserved, 1:1", () => {
  const src =
    `// c\n/* a\n b */ return /x\\//.test(s) ? "q\\"" : 'r';\nif (a) /y/.x(\`t\${a/b}\n\`);\n</div>`;
  const text = codeText(src);
  assertEquals(text.length, src.length);
  assertEquals(codeMask(src).length, src.length);
  for (let i = 0; i < src.length; i++) {
    assertEquals(text[i] === "\n", src[i] === "\n", `newline at ${i}`);
    if (text[i] !== " ") assertEquals(text[i], src[i], `kept char at ${i}`);
  }
});

// A template nested in an interpolation: the inner backtick is not the outer
// literal's close. It was, so the inner body (`}` here) read as CODE — and
// every brace-counting scanner closed its block one `}` early.
Deno.test("code-mask: a template nested in `${…}` is one literal", () => {
  assertMasks(
    "a(`${o ? `}` : '{'}`); b {",
    "a(`________________`); b {",
  );
  // Strings, and deeper templates, inside the interpolation don't close it.
  assertMasks(
    "x = `${'`'}${`${`}`}`}`; y",
    "x = `_________________`; y",
  );
  // A lone `${` with no close stays the old bail: blank to end of line.
  assertMasks("t = `${a\nb()", "t = `___\nb()");
});

/** `pre` + `body` + `post` where the whole `body` (a template's contents) is
 *  masked and everything around it stays code. */
function assertBody(pre: string, body: string, post: string): void {
  assertMasks(pre + body + post, pre + body.replace(/[^\n]/g, "_") + post);
}

// The interpolation body is CODE: a quote inside a regex or a comment there is
// not a string. Read as one, the interpolation "never closed", the template
// was cut at its first newline, and the rest of the file desynced — template
// text read as code, real code masked. Each shape is one this repo has.
Deno.test("code-mask: a regex or comment inside `${…}` holds no string", () => {
  // src/server/sql.ts — the SQL-escape idiom.
  assertBody("p(`", `DEFAULT '\${d.replace(/'/g, "''")}'`, "`);\nb { c(x) }");
  // src/server/server-html-gen.ts — a `"` in the regex.
  assertBody("x(`", `<script nonce="\${n.replace(/"/g, "")}"`, "`);\nb(y);");
  // tests/am-detached-spawn.test.ts — a multi-line interpolation.
  assertBody(
    "[`",
    `\${c} \${\n  a.map((a) => "'" + a.replace(/'/g, "'\\\\''")).join(" ")\n}; sleep 20`,
    "`];\nb(z);",
  );
  // src/electron/electron-scripts.ts — an apostrophe in a `//` comment; and a
  // block comment holding a brace and a backtick.
  assertBody(
    "t = `",
    `f(\${\n  // it's the route\n  u /* } \` */\n})`,
    "`;\nb(w);",
  );
});

Deno.test("code-mask: an unclosable `${` falls back to the next backtick", () => {
  // Never the first-newline cut: the template's second line stays masked.
  assertBody("t = `", "${'\n}x", "`;\nb(v);");
});

// The property that makes the desync class unshippable: in real source every
// bracket that is CODE has its partner in code. A mask that reads template or
// comment text as code — or blanks real code — breaks that balance, so every
// .ts/.tsx file in the repo must balance under `codeText`. No allowlist: a file
// that trips this is a masking bug, or a shape worth a fixture above.
Deno.test("code-mask: every repo source file balances its code brackets", async () => {
  const root = new URL("../", import.meta.url);
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const bad: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && e.name !== "dist") {
          await walk(new URL(`${e.name}/`, dir));
        }
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      const file = new URL(e.name, dir);
      const text = codeText(await Deno.readTextFile(file));
      const stack: string[] = [];
      let at = -1;
      for (let i = 0; i < text.length && at < 0; i++) {
        const c = text[i]!;
        if (c === "(" || c === "[" || c === "{") stack.push(c);
        else if (c in pair && stack.pop() !== pair[c]) at = i;
      }
      if (at >= 0 || stack.length > 0) {
        const line = at < 0 ? "EOF" : text.slice(0, at).split("\n").length;
        bad.push(`${file.pathname.slice(root.pathname.length)}:${line}`);
      }
    }
  };
  for (const d of ["src", "tests", "examples", "amui", "aiol", "scripts"]) {
    await walk(new URL(`${d}/`, root));
  }
  assertEquals(bad, []);
});
