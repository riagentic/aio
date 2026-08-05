// An `aio/<entry>` import that the app's deno.json doesn't map cannot resolve —
// and Deno's message ("not a dependency and not in import map") reads like the
// entry doesn't exist, so the app author blames the docs. The scaffold now maps
// every public entry, and aiol catches (and fixes) the apps scaffolded before.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkImports } from "../aiol/checks.ts";
import { AIO_LIBRARY_ENTRIES } from "../src/entries.ts";
import { frameworkSpecs } from "../src/am/am-cmd-create.ts";

async function project(
  imports: Record<string, string>,
  source: string,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports }));
  await Deno.writeTextFile(join(dir, "src", "cell.ts"), source);
  return dir;
}

async function importIssues(dir: string) {
  const { ctx, report } = await buildContext(dir);
  await checkImports(ctx);
  return report.issues.filter((i) => i.area === "imports");
}

const SCAFFOLD_4 = {
  "aio": "./dep/aio/mod.ts",
  "aio/air": "./dep/aio/src/air.ts",
  "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
  "aio/testing": "./dep/aio/src/cell-test.ts",
};

Deno.test("aiol imports: an unmapped aio entry is an ERROR, with the mapping as the fix", async () => {
  const dir = await project(
    SCAFFOLD_4,
    `import { Markdown } from "aio/ui";\nexport const M = Markdown;\n`,
  );
  try {
    const issues = await importIssues(dir);
    assertEquals(issues.length, 1);
    assertEquals(
      issues[0]!.severity,
      "error",
      "an unresolvable import is fatal",
    );
    assert(issues[0]!.message.includes("aio/ui"), issues[0]!.message);

    assertEquals(await issues[0]!.safeFix!(dir), true);
    const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(
      dj.imports["aio/ui"],
      "./dep/aio/src/ui/mod.ts",
      "the fix derives the path from how the app already maps bare `aio`",
    );
    assertEquals(await importIssues(dir), [], "and the project lints clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol imports: a JSR-pinned app gets a sub-path export, not a file path", async () => {
  const dir = await project(
    { "aio": "jsr:@riagentic/aio@1.0.0-alpha35" },
    `import { createDB } from "aio/db";\nexport const d = createDB;\n`,
  );
  try {
    const issues = await importIssues(dir);
    assertEquals(issues.length, 1);
    assertEquals(await issues[0]!.safeFix!(dir), true);
    const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(dj.imports["aio/db"], "jsr:@riagentic/aio@1.0.0-alpha35/db");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol imports: a mapped entry, and a non-aio specifier, are left alone", async () => {
  const dir = await project(
    { ...SCAFFOLD_4, "aio/ui": "./dep/aio/src/ui/mod.ts" },
    `import { Markdown } from "aio/ui";
import { assertEquals } from "@std/assert";
// "aio/db" in a comment is not an import
export const M = [Markdown, assertEquals];
`,
  );
  try {
    assertEquals(await importIssues(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold: `am create` maps every public aio entry point", async () => {
  // The generated deno.json must cover the whole documented surface — this is
  // the regression that made `import { createDB } from "aio/db"` fail in an app
  // scaffolded straight from `am create`.
  //
  // This test used to GREP src/am/am-cmd-create.ts for the literal string
  // `"aio/db"`, with a hand-written exclusion list that named `aio/build` a
  // "tooling entry an app runs as a task, not imports" — so it asserted the
  // defect: two doc pages import dbWorkerInclude / compileArgs / assetIncludes
  // from `aio/build`, and the scaffold mapping it was the thing being excused.
  // It also proved nothing about behaviour; a source file containing a string
  // is not an import map. Now it calls the generator, and the
  // library-vs-run-only split comes from THE entry list.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: frameworkSpecs(true).imports }),
    );
    // Every importable entry, imported at once from a scaffolded app: the
    // linter must find nothing to say about any of them.
    await Deno.writeTextFile(
      join(dir, "src", "cell.ts"),
      Object.keys(AIO_LIBRARY_ENTRIES)
        .map((s, i) => `import * as _e${i} from "${s}";\nexport { _e${i} };`)
        .join("\n"),
    );
    assertEquals(
      await importIssues(dir),
      [],
      "an app scaffolded by `am create` must resolve every entry the docs " +
        "tell it to import",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
