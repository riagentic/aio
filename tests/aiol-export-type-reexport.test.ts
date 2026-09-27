// The cell-file server-only import rule exempted a type-only import by
// `m[0].startsWith("import type ")`, so the equally-erased type-only
// RE-EXPORT `export type { WalkEntry } from "@std/fs"` was a gate-failing
// ERROR ("import ... is server-only") on a file that cannot leak anything —
// esbuild drops `export type` entirely. The chain rule already knew this
// (`(?!type\s)`, "a TYPE-only hop is not an edge in the runtime graph").
// The value re-export stays an error: it is a real edge.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkUI } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CELL_BODY =
  `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { inc: (s) => { s.count++ } },\n});\n`;

/** The error messages naming `@std/fs` that checkUI reports for a project
 *  with these files under src/. */
async function stdFsErrors(files: Record<string, string>): Promise<string[]> {
  const dir = await tempDir("aiol-exptype-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, "src", rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkUI(ctx);
    return report.issues.filter((i) =>
      i.severity === "error" && i.message.includes("@std/fs")
    ).map((i) => i.message);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test('aiol: `export type {…} from "@std/fs"` in a cell file is not an error', async () => {
  assertEquals(
    await stdFsErrors({
      "App.tsx": "export default function App() { return <div/> }",
      "counter.ts": `export type { WalkEntry } from "@std/fs";\n${CELL_BODY}`,
    }),
    [],
    "a type-only re-export is erased and cannot reach the bundle",
  );
});

Deno.test('aiol: `export type {…} from "@std/fs"` in a component is not an error', async () => {
  assertEquals(
    await stdFsErrors({
      "App.tsx": `export type { WalkEntry } from "@std/fs";\n` +
        "export default function App() { return <div/> }",
      "counter.ts": CELL_BODY,
    }),
    [],
  );
});

Deno.test('aiol: a VALUE re-export `export { ensureDir } from "@std/fs"` is still an error', async () => {
  const hits = await stdFsErrors({
    "App.tsx": "export default function App() { return <div/> }",
    "counter.ts": `export { ensureDir } from "@std/fs";\n${CELL_BODY}`,
  });
  assertEquals(hits.length, 1, JSON.stringify(hits));
  assertStringIncludes(hits[0]!, "server-only");
});
