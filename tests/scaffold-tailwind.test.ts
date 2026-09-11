// `am create --css=tailwind` — the wiring nobody ever ran.
//
// Two field reports said the same thing: for a large share of new projects
// Tailwind is not a preference, it is the assumed default, and its total
// absence reads as "unsupported". The answer aio shipped is good — one
// `build.css` key, run by the dev watcher AND the build — but the SCAFFOLD
// that writes that key had no test at all, and it is the surface every new
// project meets first.
//
// What makes it worth a file of its own: the tailwind path touches FIVE places
// in one deno.json, and every one of them has to agree with the others.
// A `-i` naming a file the scaffold does not write, an `-o` that is not the
// gitignored one, a missing `tailwindcss` import (Tailwind v4's CLI resolves it
// as a node package and fails with "Can't resolve 'tailwindcss'"), or
// `nodeModulesDir` off — each produces a project that scaffolds cleanly and
// fails on first run, at a distance from the cause.
import { assert, assertEquals } from "@std/assert";
import { scaffold } from "../src/am/am-cmd-create.ts";

function tw(): { files: Record<string, string>; json: Record<string, any> } {
  const files = scaffold("twapp", "counter", true, "browser", "tailwind");
  return { files, json: JSON.parse(files["deno.json"]!) };
}

Deno.test("the CSS command's INPUT is a file the scaffold actually writes", () => {
  const { files, json } = tw();
  const cmd = String(json.build?.css ?? "");
  assert(cmd, "build.css must be set for --css=tailwind");
  const input = /-i\s+(\S+)/.exec(cmd)?.[1];
  assert(input, `the command must name an input: ${cmd}`);
  assert(
    files[input] !== undefined,
    `build.css reads "${input}", which the scaffold does not write. ` +
      `Files: ${Object.keys(files).join(", ")}`,
  );
  assert(
    files[input]!.includes('@import "tailwindcss"'),
    "the source sheet must actually import tailwind",
  );
});

Deno.test("the CSS command's OUTPUT is the stylesheet aio reads, and is gitignored", () => {
  const { files, json } = tw();
  const cmd = String(json.build?.css ?? "");
  const output = /-o\s+(\S+)/.exec(cmd)?.[1];
  assert(output, `the command must name an output: ${cmd}`);
  // THE contract that makes Tailwind need no adapter: the generated theme steps
  // aside the moment this file exists, so the output must be exactly the path
  // aio looks for — beside the app entry, named style.css.
  assertEquals(
    output,
    "src/style.css",
    "the generated theme steps aside for src/style.css and nothing else",
  );
  assert(
    files[output] === undefined,
    "src/style.css is a BUILD PRODUCT — scaffolding one means the first " +
      "`git status` is a diff of generated CSS",
  );
  assert(
    files[".gitignore"]!.includes(output),
    `${output} is generated on every build and must be gitignored`,
  );
});

Deno.test("Tailwind v4's CLI can resolve `tailwindcss` from the project", () => {
  const { json } = tw();
  // Measured: without the mapping the CLI fails with "Can't resolve
  // 'tailwindcss'" and nothing points at the cause.
  assert(
    typeof json.imports?.tailwindcss === "string",
    `imports.tailwindcss is missing: ${JSON.stringify(json.imports)}`,
  );
  assert(
    String(json.imports.tailwindcss).startsWith("npm:tailwindcss"),
    "it has to be the npm package the CLI looks for",
  );
  assertEquals(
    json.nodeModulesDir,
    "auto",
    "the CLI resolves it as a NODE package, so node_modules has to be real",
  );
});

Deno.test("without --css, none of it is there", () => {
  // The other half of the contract: an app that did not ask for a CSS
  // toolchain must carry no trace of one — no build.css to run, no import to
  // fetch, no ignored path that looks like a mistake.
  const files = scaffold("plain", "counter", true, "browser");
  const json = JSON.parse(files["deno.json"]!);
  assertEquals(json.build?.css, undefined);
  assertEquals(json.imports?.tailwindcss, undefined);
  assertEquals(files["src/app.css"], undefined);
  assert(!files[".gitignore"]!.includes("src/style.css"));
});

Deno.test("the Tailwind app is written in TAILWIND, not against the theme it replaced", () => {
  // THE trap this catches. aio's generated theme steps fully aside the moment
  // `src/style.css` exists — that contract is exactly what lets Tailwind need
  // no adapter — and `--css=tailwind` WRITES that file. Scaffolding the
  // default markup alongside it gives an app whose `card` / `row` / `primary`
  // classes no longer exist, under a Tailwind preflight that has also reset
  // the semantic HTML beneath them. It runs, it is correct, and the first
  // `deno task dev` looks broken.
  const { files } = tw();
  const ui = files["src/App.tsx"]!;
  for (
    const themeClass of ['"card', '"row"', '"primary"', '"muted"', '"ghost"']
  ) {
    assert(
      !ui.includes(themeClass),
      `the Tailwind UI uses ${themeClass}, a class the generated theme owns — ` +
        `and that theme is exactly what src/style.css turns off`,
    );
  }
  // …and it really is Tailwind, so the example doubles as documentation.
  for (const util of ["flex", "rounded-", "text-", "dark:", "focus-visible:"]) {
    assert(ui.includes(util), `expected a Tailwind ${util}… utility`);
  }
  // The semantic test hooks survive the restyle: `am trigger` and `testUI`
  // find these, and a restyle that drops them breaks every test silently.
  assert(ui.includes('t="plus"') && ui.includes('t="minus"'));

  // The DEFAULT app keeps using the theme, for the same reason in reverse.
  const plain = scaffold("plain", "counter", true, "browser")["src/App.tsx"]!;
  assert(
    plain.includes('class="card') || plain.includes('class="row"'),
    "without a stylesheet the generated theme is what styles the app",
  );
});

Deno.test({
  name: "every scaffolded source file PARSES",
  // These are TypeScript inside a TypeScript template literal; a mis-escaped
  // backtick or a stray `${` produces a file that is syntactically broken and
  // still ships — the scaffold reports success and the author's first command
  // fails on a file they did not write. It has happened here before; parse the
  // output rather than trusting the escaping.
  //
  // esbuild runs through a native child SHARED by every test file in this
  // process, so `esbuild.stop()` would tear it down under whichever other file
  // is mid-build. Measured: four tests in three files failed exactly that way
  // in the full suite and passed alone. The child is left running and the
  // sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const esbuild = await import("esbuild");
    for (const css of [undefined, "tailwind" as const]) {
      for (const template of ["counter", "todo", "cli"] as const) {
        const files = scaffold(`p-${template}`, template, true, "browser", css);
        for (const [name, text] of Object.entries(files)) {
          if (!/\.tsx?$/.test(name)) continue;
          await esbuild.transform(text, {
            loader: name.endsWith(".tsx") ? "tsx" : "ts",
            jsx: "automatic",
          }).catch((e) => {
            throw new Error(`${css ?? "plain"}/${template} ${name}: ${e}`);
          });
        }
      }
    }
  },
});
