// `codeMask(src, true)` reads JSX: the text an element shows is not code.
//
// Without it, prose is lexed as code, and prose is full of things that open a
// literal or a comment: an apostrophe, the `//` of a URL, one backtick, `/*`.
// Each blanks what follows it — a callback's parameter list on the same line —
// and a reader of the mask then misses a declaration. A lint fix built on
// that mask rewrote an app's own parameter as if it were the framework's.
//
// Two contracts are pinned here:
//  - a whole element standing where an expression starts is read as JSX:
//    text 0; tags, attribute names and `{…}` containers code;
//  - everything else is lexed exactly as without the flag — so a source with
//    no JSX in it gets the same mask, byte for byte (every `.ts` file of this
//    repo, below).
import { assert, assertEquals } from "@std/assert";
import { codeMask, codeText, jsxRead } from "../src/diagnostics/code-mask.ts";

/** The code of `src` with JSX read, runs of blanks collapsed. */
const code = (src: string) =>
  codeText(src, true).replace(/[ \t]+/g, " ").trim();

Deno.test("code-mask jsx: prose that would open a literal or a comment hides nothing after it", () => {
  // Each prose, and a word of it that must not survive as code.
  for (
    const [prose, word] of [
      ["Don't forget: ", "forget"],
      ["See http://x.y for ", "http"],
      ["Run `am start`, then ` ", "start"],
      ["a /* b: ", "b:"],
      ["it&apos;s ", "apos"],
      ["the (call) hook: ", "hook"],
      ["first line\n  it's the second line ", "second"],
    ] as const
  ) {
    const src = `const V = (p) => <p>${prose}{p.fns.map((call) =>\n` +
      `  String(call({ timeout: 5 })))}</p>;\nconst after = 1;\n`;
    const text = codeText(src, true);
    // The callback's parameter and everything after the element is code…
    assert(text.includes("{p.fns.map((call) =>"), `${prose}\n${text}`);
    assert(text.includes("String(call({ timeout: 5 })))}</p>;"), prose);
    assert(text.includes("const after = 1;"), prose);
    // …the prose is not, and offsets stay 1:1.
    assert(src.split("{p.fns")[0]!.includes(word), prose);
    assert(!text.split("{p.fns")[0]!.includes(word), `${prose}: ${word}`);
    assertEquals(text.length, src.length);
    assertEquals(text.split("\n").length, src.split("\n").length);
  }
});

Deno.test("code-mask jsx: containers, attributes, fragments, nesting", () => {
  // A `{…}` container is code with its own strings — a `}` in one closes
  // nothing.
  assertEquals(
    code(`const a = <p>{'}'} don't {x}</p>; y`),
    `const a = <p>{' '} {x}</p>; y`,
  );
  // Prose before AND after a container.
  assertEquals(
    code(`const a = <p>can't {a} won't {b} shan't</p>; y`),
    `const a = <p> {a} {b} </p>; y`,
  );
  // Attribute strings have no escapes and may span lines; attribute
  // containers are code.
  assertEquals(
    code(
      `const a = <a href="//x.y" title='it"s\n ok' on={() => f('}')}>go</a>; y`,
    ),
    `const a = <a href=" " title=' \n ' on={() => f(' ')}> </a>; y`,
  );
  // A spread, a self-closing tag, a member tag, a fragment.
  assertEquals(
    code(`const a = <><A.B {...p} /><br/>it's</>; y`),
    `const a = <><A.B {...p} /><br/> </>; y`,
  );
  // An element inside a container inside an element.
  assertEquals(
    code(
      `const a = <ul>{xs.map((x) => <li key={x}>it's {x}</li>)} don't</ul>; y`,
    ),
    `const a = <ul>{xs.map((x) => <li key={x}> {x}</li>)} </ul>; y`,
  );
  // Where an expression starts: after `return`, `(`, `?`, `:`, `&&`.
  assertEquals(
    code(`{ return ok ? <b>it's</b> : no && (<i>don't</i>); }`),
    `{ return ok ? <b> </b> : no && (<i> </i>); }`,
  );
  // A comment inside a container is a comment.
  assertEquals(
    code(`const a = <p>{/* it's */}it's</p>; y`),
    `const a = <p>{/* */} </p>; y`,
  );
});

Deno.test("code-mask jsx: an element after a comment, with type arguments, with a comment in its tag, after a unary operator", () => {
  // A comment between the place an expression starts and the element.
  assertEquals(
    code(`const V = (\n  // it's the layout\n  <p>don't {x}</p>\n);`),
    `const V = (\n // \n <p> {x}</p>\n);`,
  );
  assertEquals(
    code(
      `{\n  return /* it's a row */ // too\n  <p>don't {x}</p>;\n}`,
    ),
    `{\n return /* */ // \n <p> {x}</p>;\n}`,
  );
  // …but a comment after a NAME changes nothing: still a comparison.
  const cmp = `const a = b /* it's */ <c>d</c>/.source; const s = "it's";`;
  assertEquals([...codeMask(cmp, true)], [...codeMask(cmp)]);
  // Type arguments on the tag.
  assertEquals(
    code(
      `const a = <List<Map<string, () => void>> items={xs}>don't {x}</List>; y`,
    ),
    `const a = <List<Map<string, () => void>> items={xs}> {x}</List>; y`,
  );
  // A comment between attributes.
  assertEquals(
    code(
      `const a = <p /* why's */ title="x" // it's\n id="y">don't {x}</p>; y`,
    ),
    `const a = <p /* */ title=" " // \n id=" "> {x}</p>; y`,
  );
  // After a unary `+` or `!`.
  assertEquals(
    code(`const a = [+<p>don't</p>, !<b>isn't</b>]; y`),
    `const a = [+<p> </p>, !<b> </b>]; y`,
  );
  // More than this reader takes: a string among a tag's type arguments. The
  // element is then lexed as without the flag — a caller that must not be
  // wrong does not rest on this reader alone.
  const hard = `const a = <List<"a" | "b"> items={xs}>it's {x}</List>; y`;
  assertEquals([...codeMask(hard, true)], [...codeMask(hard)]);
});

Deno.test("code-mask jsx: what is no whole element is lexed exactly as without the flag", () => {
  for (
    const src of [
      // comparisons
      `const a = b < c; const d = "it's"; e > f;`,
      `if (a <b || c> 2) { g('x'); }`,
      // type arguments and generic arrows
      `const a = f<T>(x); const b = "y";`,
      `const id = <T,>(x: T) => x; const s = 'it';`,
      `const id = <T extends object>(x: T): T => x; const s = 'it';`,
      `const m = new Map<string, Set<number>>(); // it's`,
      `const t = x as Y<Z>; const u = 'v';`,
      // type arguments, then a comparison with a regex: spelled like an
      // element with its closing tag, after a NAME — where none can start
      `const n = g<b>(1) + h</b>/.source.length; const s = "it's";`,
      // a regex that ends like a block comment, compared
      `const n = /a*/ <b>it's</b>/.source.length; const s = "x";`,
      // a cast in a .ts file, and a comparison after it
      `export const n = <number>useCell(c).state.n;\nexport const m = <number>n < 2;`,
      `const a = <Foo>bar; function g() { return "it's"; }`,
      // a tag that never closes, or closes as another
      `const a = <p>it's fine; const b = 1;`,
      `const a = <p>it's</q>; const b = 1;`,
      // text may hold neither `>` nor `}`
      `const a = <p>a => b</p>; const b = 'c';`,
      // a type annotation
      `const f: <T>(x: T) => T = (x) => x; const s = "it's";`,
    ]
  ) {
    assertEquals([...codeMask(src, true)], [...codeMask(src)], src);
  }
});

Deno.test("code-mask jsx: the default is unchanged — JSX text is lexed as code", () => {
  const src = `const V = () => <p>See http://x.y for {f((call) => 1)}</p>;`;
  // Without the flag the URL's `//` is a comment to the end of the line.
  assert(!codeText(src).includes("(call)"));
  assert(codeText(src, true).includes("(call)"));
});

// THE proof that the flag is safe to hand any file: over every `.ts` file of
// this repo the two masks are identical, and over every `.tsx` file they
// differ only where the JSX reading has text — never outside an element.
Deno.test("code-mask jsx: every .ts file of the repo masks the same; every .tsx differs only in an element", async () => {
  const root = new URL("../", import.meta.url);
  const changed: string[] = [];
  const outside: string[] = [];
  let ts = 0;
  let tsx = 0;
  let regions = 0;
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
      const name = file.pathname.slice(root.pathname.length);
      const src = await Deno.readTextFile(file);
      const plain = codeMask(src);
      const jsx = codeMask(src, true);
      const first = plain.findIndex((v, i) => v !== jsx[i]);
      if (e.name.endsWith(".ts")) {
        ts++;
        if (first !== -1) {
          changed.push(`${name}:${src.slice(0, first).split("\n").length}`);
        }
        continue;
      }
      tsx++;
      if (first === -1) continue;
      regions++;
      // Every difference lies after the file's first `<` in code: no element,
      // no difference.
      const open = [...src].findIndex((c, i) => c === "<" && plain[i] === 1);
      if (open === -1 || first < open) outside.push(name);
    }
  };
  for (const d of ["src", "tests", "examples", "amui", "aiol", "scripts"]) {
    await walk(new URL(`${d}/`, root));
  }
  assertEquals(changed, []);
  assertEquals(outside, []);
  assert(ts > 1000 && tsx > 50 && regions > 20, `${ts} ${tsx} ${regions}`);
});

// The JSX reading must leave every file's code brackets balanced, as the
// plain one does: text taken for code (or code for text) breaks the balance.
Deno.test("code-mask jsx: every repo .tsx file balances its code brackets", async () => {
  const root = new URL("../", import.meta.url);
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const bad: string[] = [];
  let files = 0;
  const walk = async (dir: URL): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && e.name !== "dist") {
          await walk(new URL(`${e.name}/`, dir));
        }
        continue;
      }
      if (!e.name.endsWith(".tsx")) continue;
      files++;
      const file = new URL(e.name, dir);
      const text = codeText(await Deno.readTextFile(file), true);
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
  assert(files > 50, String(files));
});

// `jsxRead` says which closing tags closed an element it read — so a caller
// can tell one that did not: the sign of an element the reader did not take.
Deno.test("code-mask jsx: jsxRead names the closing tag of every element it read, and of no other", () => {
  const at = (src: string) =>
    jsxRead(src).closed.map((i) => src.slice(i, src.indexOf(">", i) + 1));
  const src =
    `const a = <p>it's {x ? <b>y</b> : "</i>"}<u>z</u></p>; const c = <br />;`;
  assertEquals([...jsxRead(src).mask], [...codeMask(src, true)]);
  // The element in the container, the child, the outer one — not the string.
  assertEquals(at(src), ["</b>", "</u>", "</p>"]);
  assertEquals(at(`const f = <>a</>;`), ["</>"]);
  // An element that fails takes what closed inside it along: its text was
  // lexed as code after all.
  assertEquals(at(`const a = <Foo>bar <b>y</b>; x`), []);
  // A tag is named like an identifier — in any script.
  assertEquals(at(`const a = <Élément>c'est ça</Élément>;`), ["</Élément>"]);
  assertEquals(
    codeText(`const a = <日本 título="it's">don't</日本>; y`, true)
      .replace(/ +/g, " "),
    `const a = <日本 título=" "> </日本>; y`,
  );
  // A `<` where no element can start closes nothing.
  assertEquals(at(`const a = b <c>d</c>; x`), []);
});
