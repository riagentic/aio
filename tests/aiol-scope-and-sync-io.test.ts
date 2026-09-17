// R-4 — the oversized-file warning honours the app's own excludes (deno.json
// `exclude` / `fmt.exclude`, `.gitignore`), at BOTH scan sites (a directory
// walk and the project root): a generated bundle the app declares is not its
// code is silent on purpose, not an unexplained skip.
// R-5 — the sync-I/O perf warning takes `// aio-ok: <why>` like every rule.
// h8 F8 — amui maps every aio entry it imports (the rule stays strict: an
// inherited mapping only resolves while the app sits inside the package).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkImports, checkPerformance } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CELL = `import { cell } from "aio";
export const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
`;
const BIG = "export const blob = `" + "x".repeat(600 * 1024) + "`;\n";

async function project(
  files: Record<string, string>,
  denoJson: Record<string, unknown> = {},
): Promise<string> {
  const dir = await tempDir("aiol-scope-");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { aio: "jsr:@riagentic/aio@1.0.0" },
      ...denoJson,
    }),
  );
  for (const [rel, body] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), body);
  }
  return dir;
}

Deno.test("aiol: an oversized file the app excludes is not reported as skipped (R-4)", async () => {
  const dir = await project({
    "src/cell.ts": CELL,
    "src/gen/bundle.ts": BIG,
    "vendor.ts": BIG,
    "src/big.ts": BIG,
  }, { fmt: { exclude: ["src/gen/", "vendor.ts"] } });
  try {
    const { ctx } = await buildContext(dir);
    assertEquals(ctx.skipped.map((s) => s.path), ["src/big.ts"]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("aiol: .gitignore'd oversized files are silent too (R-4)", async () => {
  const dir = await project({
    "src/cell.ts": CELL,
    "src/out.gen.ts": BIG,
    ".gitignore": "*.gen.ts\n",
  });
  try {
    const { ctx } = await buildContext(dir);
    assertEquals(ctx.skipped, []);
  } finally {
    await dropTempDir(dir);
  }
});

async function syncIo(src: string): Promise<number[]> {
  const dir = await project({ "src/cell.ts": CELL, "src/boot.ts": src });
  try {
    const { ctx, report } = await buildContext(dir);
    await checkPerformance(ctx);
    return report.issues
      .filter((i) => i.message.includes("sync I/O"))
      .map((i) => i.line ?? -1);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: sync I/O fires unsuppressed and is silenced by aio-ok (R-5)", async () => {
  assertEquals(
    await syncIo(`export const cfg = Deno.readTextFileSync("cfg.json");\n`),
    [1],
  );
  assertEquals(
    await syncIo(
      `// aio-ok: boot-once config read, before any client connects\nexport const cfg = Deno.readTextFileSync("cfg.json");\n`,
    ),
    [],
  );
  assertEquals(
    await syncIo(
      `export const cfg = Deno.readTextFileSync("cfg.json"); // aio-ok: boot-once read\n`,
    ),
    [],
  );
  // A suppressed site does not hide a second, unacknowledged one.
  assertEquals(
    await syncIo(
      `export const a = Deno.readTextFileSync("a"); // aio-ok: boot-once read\n\nexport const b = () => Deno.readTextFileSync("b");\n`,
    ),
    [3],
  );
});

Deno.test("aiol: amui maps every aio entry it imports (h8 F8)", async () => {
  const { ctx, report } = await buildContext(
    new URL("../amui", import.meta.url).pathname,
  );
  await checkImports(ctx);
  assertEquals(
    report.issues.filter((i) => i.severity === "error").map((i) => i.message),
    [],
  );
});
