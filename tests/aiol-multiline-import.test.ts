// The server-only import rules read imports with
// `(?:import|export)\s+.*?\s+from` — `.` never crosses a newline, so the
// multi-line form `deno fmt` itself produces for a long specifier list was
// invisible: the same `@std/fs` import was an ERROR on one line and silence on
// three, in a .tsx (literally the browser bundle) and in a cell file alike.
// Every site now reads statements through ONE scanner, `moduleStatements`.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lintProject } from "../aiol/mod.ts";
import { moduleStatements } from "../aiol/scan.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CELL =
  `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`;
const APP =
  `import { counter } from "./cell.ts";\nexport default function App() { return <div>{counter.count}</div>; }\n`;
const MULTI = `import {\n  ensureDir,\n  exists,\n} from "@std/fs";\n`;

async function uiMessages(files: Record<string, string>): Promise<string[]> {
  const dir = await tempDir("aiol-r6-ml-");
  try {
    const all: Record<string, string> = {
      "deno.json": JSON.stringify({
        nodeModulesDir: "auto",
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
        imports: {
          aio: "jsr:@riagentic/aio@1.0.0",
          "@std/fs": "jsr:@std/fs@1",
        },
        tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
      }),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", cells: { counter } });\n`,
      ...files,
    };
    for (const [rel, src] of Object.entries(all)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    const r = await lintProject(dir);
    return r.issues.filter((i) => i.severity === "error").map((i) => i.message);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: a multi-line @std/fs import in App.tsx is reported", async () => {
  const msgs = await uiMessages({
    "src/cell.ts": CELL,
    "src/App.tsx": MULTI + APP,
  });
  assert(
    msgs.some((m) => m.includes("@std/fs") && m.includes("server-only")),
    `no server-only finding for a multi-line import in App.tsx; errors: ${
      JSON.stringify(msgs)
    }`,
  );
});

Deno.test("aiol: a multi-line @std/fs import in a cell file is reported", async () => {
  const msgs = await uiMessages({
    "src/cell.ts": MULTI + CELL,
    "src/App.tsx": APP,
  });
  assert(
    msgs.some((m) => m.includes("@std/fs") && m.includes("server-only")),
    `no server-only finding for a multi-line import in a cell file; errors: ${
      JSON.stringify(msgs)
    }`,
  );
});

Deno.test("aiol: a server-only aio symbol in a commented multi-line list is reported", async () => {
  const msgs = await uiMessages({
    "src/cell.ts":
      `import {\n  cell, // the cell factory\n  createDB, // the store\n} from "aio";\n` +
      CELL.replace(`import { cell } from "aio";\n`, ""),
    "src/App.tsx": APP,
  });
  assert(
    msgs.some((m) => m.includes("'createDB'") && m.includes("server-only")),
    `no finding for createDB in a multi-line list; errors: ${
      JSON.stringify(msgs)
    }`,
  );
});

Deno.test("moduleStatements: multi-line, comment-aware, code-only", () => {
  const src =
    `import {\n  cell,\n  schedule, // the "scheduler", x\n} from "aio";\n` +
    `export type { W } from "@std/fs";\n` +
    `import * as ns from 'node:fs';\n` +
    `import "./side.ts";\n` +
    `import D, { a as b } from "x";\n` +
    `// import { z } from "in-a-comment";\n` +
    'const t = `import { q } from "in-a-template"`;\n' +
    `export * from "./y.ts";\n` +
    `import type{A}from"t";\n` +
    `const d = await import("dyn");\n`;
  const got = moduleStatements(src).map((s) => ({
    kind: s.kind,
    typeOnly: s.typeOnly,
    clause: s.clause,
    spec: s.spec,
    names: s.list?.entries.map((e) => e.text) ?? null,
  }));
  assertEquals(got, [
    {
      kind: "import",
      typeOnly: false,
      clause: "{ cell, schedule, }",
      spec: "aio",
      names: ["cell", "schedule", ""],
    },
    {
      kind: "export",
      typeOnly: true,
      clause: "{ W }",
      spec: "@std/fs",
      names: ["W"],
    },
    {
      kind: "import",
      typeOnly: false,
      clause: "* as ns",
      spec: "node:fs",
      names: null,
    },
    {
      kind: "import",
      typeOnly: false,
      clause: "",
      spec: "./side.ts",
      names: null,
    },
    {
      kind: "import",
      typeOnly: false,
      clause: "D, { a as b }",
      spec: "x",
      names: ["a as b"],
    },
    {
      kind: "export",
      typeOnly: false,
      clause: "*",
      spec: "./y.ts",
      names: null,
    },
    { kind: "import", typeOnly: true, clause: "{A}", spec: "t", names: ["A"] },
  ]);
});
