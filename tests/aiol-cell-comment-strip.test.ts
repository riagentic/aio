// aiol checkCells — comments in a cell config must not be mis-parsed as real
// state keys, methods or actions. A phrase like "// constructor: builds it" or
// "// value lives in state (…)" would otherwise phantom-match a reserved key
// and emit a spurious `reserved`/`collides` error on valid code.
import { assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkCells } from "../aiol/checks.ts";
import { join } from "@std/path";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function reservedIssues(dir: string, cellSource: string) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
  );
  await Deno.writeTextFile(join(dir, "src", "widget.ts"), cellSource);
  const { ctx, report } = await buildContext(dir);
  await checkCells(ctx);
  return report.issues.filter((i) =>
    i.severity === "error" && /reserved|collides/i.test(i.message)
  );
}

Deno.test("aiol: comments in a cell config don't phantom-match reserved keys", async () => {
  await withTmpDir(async (dir) => {
    const issues = await reservedIssues(
      dir,
      `
import { cell } from "aio";
export const widget = cell("widget", {
  state: {
    // constructor: the builder wires this up (must NOT be a phantom key)
    count: 0,
  },
  methods: {
    // the running total lives in state (fx handling is elsewhere)
    inc(s) { s.count++; },
  },
});
`,
    );
    assertEquals(
      issues.map((i) => i.message),
      [],
      "a reserved word inside a comment must not be reported as a real key/method",
    );
  });
});

Deno.test("aiol: a genuinely reserved state key is STILL reported", async () => {
  // Guards the fix from over-stripping: real code must keep tripping the rule.
  await withTmpDir(async (dir) => {
    const issues = await reservedIssues(
      dir,
      `
import { cell } from "aio";
export const widget = cell("widget", {
  state: { constructor: 1, count: 0 },
});
`,
    );
    assertEquals(
      issues.length >= 1,
      true,
      "real reserved key must still error",
    );
  });
});
