// A module the minifier cannot hand back with its meaning intact ships AS
// WRITTEN, and the build names it — never a build that stops, never a binary
// that runs differently from dev.
//
// The shape that named the class: the minified JS is written to a `.ts` path,
// esbuild drops the author's parentheses from `[(a < b), c > (d ?? 0)]`, and
// `a<b,c>(d??0)` in a `.ts` file is a generic CALL of `a`. Dev returned
// `[true, true]`; the compiled build threw `a is not a function`.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, normalize, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import {
  KEEP_NAME,
  minifyModule,
  stageMinified,
  Unminifiable,
} from "../src/build/minify-server.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import { HEY } from "../src/diagnostics/fmt.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LIST = `// LIST-COMMENT
export function both(min: number, value: number, max: number, limit?: number) {
  return [(min < value), max > (limit ?? 0)];
}
`;
const CMP = `// CMP-COMMENT
export const cmp = (a: number, b: number, c: number, d: number, e: number) =>
  (a < b) > (c ? d : e);
`;
const OWN = `// OWN-COMMENT
const ${KEEP_NAME} = () => "mine";
function f() {}
export const own = [${KEEP_NAME}(), f.name];
`;
const PLAIN = `// PLAIN-COMMENT
export function plain(plainLocalInput: number) {
  const plainLocalName = plainLocalInput < 2;
  return plainLocalName;
}
`;
// A decorator is HANDED names: the class's, a private member's.
const DECO = `// DECO-COMMENT
const seen: string[] = [];
const tag = (_v: unknown, ctx: { kind: string; name?: string | symbol }) => {
  seen.push(ctx.kind + ":" + String(ctx.name));
};
@tag class Kept {
  @tag #secret = 1;
  @tag method() { return this.#secret; }
}
export const deco = [seen, Kept.name, new Kept().method.name];
`;
// esbuild reads \`o<r,t>{}\` as the comparison it is; deno's TypeScript parser
// takes \`o<r,t>\` for type arguments and stops at the brace.
const BRACE = `// BRACE-COMMENT
// deno-lint-ignore no-explicit-any
export const brace = (a: number, b: number, c: any) => [(a < b), c > {}];
`;
// Minified, neither esbuild nor deno can read this one as TypeScript at all.
const REGEX = `// REGEX-COMMENT
// deno-lint-ignore no-explicit-any
export const rx = (a: number, b: number, c: any, s: string) => [(a < b), c > /x/.test(s)];
`;
const APP = `import { both } from "./list.ts";
import { cmp } from "./cmp.ts";
import { own } from "./own.ts";
import { plain } from "./plain.ts";
import { deco } from "./deco.ts";
import { brace } from "./brace.ts";
import { rx } from "./regex.ts";
export const result = [both(1, 2, 3), both(2, 1, 0, 5), cmp(1, 2, 0, 0, 0), cmp(2, 1, 1, 1, 0), own, plain(1), deco, brace(1, 2, 3), rx(1, 2, 3, "x")];
`;
const RESULT = [
  [true, true],
  [false, false],
  true,
  false,
  ["mine", "f"],
  true,
  [["method:method", "field:#secret", "class:Kept"], "Kept", "method"],
  [true, false],
  [true, true],
];

Deno.test("minify fallback: a comparison TypeScript would re-read as a generic call is refused by minifyModule", async () => {
  try {
    for (const src of [LIST, CMP]) {
      await assertRejects(
        () => minifyModule(esbuild, "/app/mod.ts", src),
        Unminifiable,
        "reads differently as TypeScript",
      );
      // The same text in a `.js` module is read as JavaScript: nothing to fear.
      const js = src.replace(/: number|\?: number/g, "");
      assert((await minifyModule(esbuild, "/app/mod.js", js)).length > 0);
      // …and every TypeScript extension is read as TypeScript.
      for (const ext of ["tsx", "mts", "cts"]) {
        await assertRejects(
          () => minifyModule(esbuild, `/app/mod.${ext}`, src),
          Unminifiable,
          "reads differently as TypeScript",
        );
      }
    }
    // A minified text TypeScript cannot read at all is the same finding —
    // never a build that stops with esbuild's parse error.
    await assertRejects(
      () => minifyModule(esbuild, "/app/mod.ts", REGEX),
      Unminifiable,
      "reads differently as TypeScript",
    );
  } finally {
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("minify fallback: a module with a decorator is refused — in either dialect, and never for an @ in a string", async () => {
  const d = "const d = (..._a: unknown[]) => {};\n";
  try {
    for (
      const [path, src] of [
        ["/app/mod.ts", DECO],
        ["/app/mod.ts", d + "@d export class K {}"],
        ["/app/mod.ts", d + "export const K = @d class {};"],
        ["/app/mod.tsx", d + "export class K { @d m() {} }"],
        ["/app/mod.js", "const d = () => {};\n@d class K {}\nexport { K };"],
        // Legacy: a parameter decorator is not even TC39 syntax.
        ["/app/mod.ts", d + "export class K { m(@d x: number) { return x; } }"],
      ] as const
    ) {
      await assertRejects(
        () => minifyModule(esbuild, path, src),
        Unminifiable,
        "it uses decorators",
        src,
      );
    }
    // Text that only looks like one: a CSS template, a string, a comment.
    const css = "// @d class K {}\nexport class K {}\n" +
      'export const s = ["@d class K {}", `\n@media print {}\n@d class K {}\n`];';
    const min = await minifyModule(esbuild, "/app/mod.ts", css);
    assert(!min.includes("//"), min);
    assert(min.includes("@media print {}"), min);
    // A line that looks like esbuild's decorator helper but is the module's
    // own: only a helper that lowering ADDED says "decorator".
    for (
      const [path, src] of [
        [
          "/app/own.ts",
          "// OWN\nvar __decorate = (a: unknown) => a;\nexport class K { m() { return __decorate(1); } }",
        ],
        [
          "/app/own.js",
          "// OWN\nvar __decorateClass = function (decorators, target) { return target; };\nexport class K {}\nexport const x = __decorateClass([], K);",
        ],
        [
          "/app/emitted.js",
          "// OWN\nvar __decorate = (this && this.__decorate) || function (decorators, target) {\n  return target;\n};\nexport class K {}\n__decorate([], K.prototype, 'm', null);",
        ],
        [
          "/app/template.ts",
          "// OWN\nexport const s = `\nvar __decorateClass = 1;\n`; export class K {}",
        ],
        [
          "/app/list.js",
          "// OWN\nvar __decorations = [];\nexport class K { d = __decorations }",
        ],
      ] as const
    ) {
      const out = await minifyModule(esbuild, path, src);
      assert(!out.includes("OWN"), `${path}: ${out}`);
    }
    // …and a real decorator beside such a line is still seen.
    await assertRejects(
      () =>
        minifyModule(
          esbuild,
          "/app/both.ts",
          d +
            "var __decorateClass = 1;\n@d export class K { v = __decorateClass; }",
        ),
      Unminifiable,
      "it uses decorators",
    );
  } finally {
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("minify fallback: such a module ships as written with one warning naming it, and the staged app computes what the source computes", async () => {
  const base = await tempDir("minify-fallback-");
  const warns: string[] = [];
  const warn = console.warn;
  try {
    const root = join(base, "app");
    const files: Record<string, string> = {
      "src/app.ts": APP,
      "src/list.ts": LIST,
      "src/cmp.ts": CMP,
      "src/own.ts": OWN,
      "src/plain.ts": PLAIN,
      "src/deco.ts": DECO,
      "src/brace.ts": BRACE,
      "src/regex.ts": REGEX,
      // Not imported by the app: a worker the build embeds with --include.
      "src/worker.ts": BRACE.replace("BRACE-COMMENT", "WORKER-COMMENT"),
      "deno.json": "{}",
    };
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(join(root, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, rel), text);
    }
    const load = async (dir: string) =>
      (await import(toFileUrl(join(dir, "src", "app.ts")).href)).result;
    assertEquals(await load(root), RESULT, "the source's own answer");

    console.warn = (...a: unknown[]) => warns.push(a.join(" "));
    const st = await stageMinified(esbuild, root, [
      "compile",
      "--no-check",
      "--include",
      join(root, "src", "worker.ts"),
      "-o",
      join(base, "out-bin"),
      "src/app.ts",
    ]);
    console.warn = warn;
    try {
      const staged = (rel: string) => Deno.readTextFile(join(st.cwd, rel));
      // One warning per module kept as written, each naming its file and why.
      assertEquals(warns.length, 7, warns.join("\n"));
      for (const w of warns) assert(w.startsWith(HEY), w);
      for (
        const [rel, why] of [
          ["src/list.ts", "reads differently as TypeScript"],
          ["src/cmp.ts", "reads differently as TypeScript"],
          ["src/own.ts", `uses the name ${KEEP_NAME} itself`],
          ["src/deco.ts", "it uses decorators"],
          ["src/regex.ts", "reads differently as TypeScript"],
          // esbuild's check passes this one; deno's own reading does not.
          ["src/brace.ts", "deno cannot read its minified form (SyntaxError"],
          // deno reads every root it will compile, not only the entry.
          ["src/worker.ts", "deno cannot read its minified form (SyntaxError"],
        ]
      ) {
        const said = warns.filter((w) =>
          // The warning names the file as this OS spells its path.
          w.includes(`${normalize(rel!)} ships UN-minified`)
        );
        assertEquals(said.length, 1, `${rel}:\n${warns.join("\n")}`);
        assert(said[0]!.includes(why!), said[0]);
        assertEquals(await staged(rel!), files[rel!]);
      }
      // Every other module is minified as before.
      const plain = await staged("src/plain.ts");
      assert(!plain.includes("PLAIN-COMMENT"), plain);
      assert(!plain.includes("plainLocalName"), plain);
      // What the binary would run, run.
      assertEquals(await load(st.cwd), RESULT);
    } finally {
      await st.dispose();
    }
  } finally {
    console.warn = warn;
    await stopEsbuildService(() => esbuild.stop());
    await dropTempDir(base);
  }
});
