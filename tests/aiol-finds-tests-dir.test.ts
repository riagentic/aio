// a field report, second update #3: `aiol` reported `Tests: 0` and "cell X has no test
// file" for an app with 271 passing tests. Cause: it scanned `src/`, `cells/` and
// the project root — never `tests/`, which is the layout aio's OWN convention
// mandates ("tests all live in tests/, never beside their source").
//
// 8 of that app's 14 hints were this one false positive. The cost isn't the wrong
// number: "a linter which is confidently wrong about 8 items trains you to skim
// the other 6 — I nearly missed a genuine post-await hint in the noise."
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";

async function project(files: Record<string, string>) {
  const dir = await Deno.makeTempDir({ prefix: "aiol-tests-dir-" });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return dir;
}

const CELL = `import { cell } from "aio";
export const hw = cell("hw", {
  state: { gpus: [] as string[] },
  methods: { scan(s: { gpus: string[] }) { s.gpus = ["a"]; } },
});
`;

Deno.test("aiol: counts tests in tests/, the layout aio mandates", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/hw.ts": CELL,
    "tests/hardware.test.ts":
      `import { hw } from "../src/hw.ts";\nDeno.test("scan", () => { hw; });\n`,
  });
  try {
    const { ctx } = await buildContext(dir);
    assertEquals(ctx.testFiles.length, 1, "the tests/ directory must be seen");
    assertEquals(ctx.cells.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol: a cell tested from tests/ is not reported untested", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/hw.ts": CELL,
    // Deliberately NOT named hw.test.ts — real suites name tests by behaviour.
    "tests/hardware-telemetry.test.ts":
      `import { hw } from "../src/hw.ts";\nDeno.test("scan", () => { hw; });\n`,
  });
  try {
    const { ctx, report } = await buildContext(dir);
    const { checkTesting } = await import("../aiol/checks.ts");
    await checkTesting(ctx);
    const untested = report.issues.filter((i) =>
      i.message.includes("has no test file")
    );
    assertEquals(
      untested,
      [],
      "a cell exercised by a differently-named file in tests/ IS tested",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol: a cell defined inside a test is a fixture, not app surface", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/hw.ts": CELL,
    // A fixture cell declared in a test must not be counted as an app cell —
    // it would then be reported as untested, forever.
    "tests/fixtures.test.tsx":
      `import { cell } from "aio";\nconst probe = cell("probe-only", { state: {}, methods: {} });\nDeno.test("x", () => { probe; });\n`,
  });
  try {
    const { ctx } = await buildContext(dir);
    assertEquals(
      ctx.cells.map((c) => c.name),
      ["hw"],
      "only src/ declares app cells",
    );
    assert(ctx.testFiles.some((f) => f.name.endsWith(".test.tsx")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol: app-code checks still ignore test files", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/hw.ts": CELL,
    // setTimeout in a TEST is normal; flagging it would trade one false positive
    // class for another, which is why tests are collected separately from
    // tsFiles/tsxFiles.
    "tests/slow.test.ts":
      `import { hw } from "../src/hw.ts";\nDeno.test("waits", async () => { await new Promise((r) => setTimeout(r, 50)); hw; });\n`,
  });
  try {
    const { ctx, report } = await buildContext(dir);
    const { checkPerformance } = await import("../aiol/checks.ts");
    await checkPerformance(ctx);
    assertEquals(
      report.issues.filter((i) => i.message.includes("setTimeout")),
      [],
      "a timer in a test is not a cell-code timer",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The other direction, and the quieter one: "is this cell tested?" ended in a
// bare `content.includes(f.name)` — a SUBSTRING test. A cell named `app` or
// `view` matched the word inside `src/app.ts`, `snapshot`, `viewer`… in any
// test file that existed, so it was permanently "tested" and the rule could
// never fire for it. A rule that cannot fire looks exactly like a rule that
// found nothing.
Deno.test("aiol: an untested cell named `app` is not 'tested' by a substring", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/app-cell.ts":
      `import { cell } from "aio";\nexport const appCell = cell("app", { state: { n: 0 }, methods: { go(s: { n: number }) { s.n++; } } });\n`,
    // Names `src/app.ts` and `snapshot` — neither is a use of the cell `app`.
    "tests/other.test.ts":
      `import { hw } from "../src/hw.ts";\nDeno.test("boots src/app.ts and takes a snapshot", () => { hw; });\n`,
    "src/hw.ts": CELL,
  });
  try {
    const { ctx, report } = await buildContext(dir);
    const { checkTesting } = await import("../aiol/checks.ts");
    await checkTesting(ctx);
    const untested = report.issues.filter((i) =>
      i.message.includes("has no test file")
    ).map((i) => i.message);
    assert(
      untested.some((m) => m.includes('cell "app"')),
      `the cell "app" has no test and must be reported:\n${
        untested.join("\n")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol: a cell named as a whole word IS counted as tested", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/app-cell.ts":
      `import { cell } from "aio";\nexport const appCell = cell("app", { state: { n: 0 }, methods: { go(s: { n: number }) { s.n++; } } });\n`,
    "tests/app.test.ts":
      `import { appCell } from "../src/app-cell.ts";\nDeno.test("app", () => { appCell; });\n`,
  });
  try {
    const { ctx, report } = await buildContext(dir);
    const { checkTesting } = await import("../aiol/checks.ts");
    await checkTesting(ctx);
    assertEquals(
      report.issues.filter((i) => i.message.includes("has no test file"))
        .length,
      0,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
