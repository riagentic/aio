// aiol reported a missing `test` task twice — once from the config rule and
// once from the testing rule — each [fixable] and each counted, so one gap
// read as two hints and `--safe-fix` listed two fixes for the same edit.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { ALL_CHECKS } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({
    title: "probe",
    version: "0.1.0",
    nodeModulesDir: "auto",
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
    imports: { aio: "jsr:@riagentic/aio@1.0.0" },
    tasks: { dev: "deno run -A src/app.ts", build: "deno run -A build.ts" },
  }),
  "src/app.ts":
    `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "probe", cells: { counter } });\n`,
  "src/cell.ts":
    `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`,
  "tests/cell.test.ts":
    `import { testCell } from "aio/testing";\nimport { counter } from "../src/cell.ts";\nDeno.test("c", async () => { await testCell(counter, async (c) => { await c.increment(); }); });\n`,
};

Deno.test("aiol: a missing test task is reported once, not once per area", async () => {
  const dir = await tempDir("aiol-test-task-");
  try {
    for (const [rel, src] of Object.entries(FILES)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    const { ctx, report } = await buildContext(dir);
    for (const check of ALL_CHECKS) await check(ctx);
    const hits = report.issues.filter((i) =>
      i.message.includes('no "test" task')
    );
    assertEquals(hits.length, 1, JSON.stringify(hits));
    assertEquals(typeof hits[0]!.safeFix, "function", "still [fixable]");
  } finally {
    await dropTempDir(dir);
  }
});
