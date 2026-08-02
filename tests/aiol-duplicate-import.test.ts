// a field report: `import { sync }` twice was a runtime SyntaxError
// that `deno check` passed. aiol's checkImports flags a duplicate top-level
// import binding — without false-firing on `import type`, aliases, namespaces,
// or `import … from` text buried in a template literal (code generators).
import { assert, assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkImports } from "../aiol/checks.ts";
import { join } from "@std/path";

async function importIssues(dir: string, files: Record<string, string>) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
  );
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, "src", name), body);
  }
  const { ctx, report } = await buildContext(dir);
  await checkImports(ctx);
  return report.issues.filter((i) =>
    i.severity === "error" && i.area === "imports"
  );
}

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkImports: a duplicate top-level binding is an error", async () => {
  await withTmpDir(async (dir) => {
    const issues = await importIssues(dir, {
      "app.ts": `
import { sync } from "./sync.ts";
import { sync } from "aio";
export const x = sync;
`,
    });
    assertEquals(issues.length, 1, `got: ${issues.map((i) => i.message)}`);
    assert(issues[0]!.message.includes("sync"), "names the duplicate binding");
  });
});

Deno.test("checkImports: type imports, aliases, namespaces, generator strings — no false positive", async () => {
  await withTmpDir(async (dir) => {
    const issues = await importIssues(dir, {
      "clean.ts": `
import { cell } from "aio";
import type { CellDef } from "aio";
import { foo as bar } from "./a.ts";
import { foo as baz } from "./b.ts";
import * as path from "@std/path";

// A code generator that emits an app — the imports inside this template must
// NOT be mistaken for real top-level imports.
export const scaffold = () => \`
import { cell } from "aio";
import { cell } from "aio";
\`;
export const y = { cell, bar, baz, path };
export type D = CellDef;
`,
    });
    assertEquals(
      issues,
      [],
      `expected no dup-import errors; got: ${issues.map((i) => i.message)}`,
    );
  });
});
