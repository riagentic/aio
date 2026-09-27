// The chain rule ("App.tsx → cell.ts → disk.ts:5", checkUI Check 3) walked
// two fixed levels from App.tsx, and:
//   (1) the level-1 file was never probed — only the level-2 file was. A plain
//       helper App.tsx imports directly, with a static `@std/fs` import, was
//       reported by nothing (it is neither a .tsx nor a cell file);
//   (2) `resolveFile` did `relPath.replace("./", "")`, which turns
//       `../lib/mid.ts` into `.lib/mid.ts` — every parent-relative hop was
//       unresolved, so an App.tsx in a subfolder was never followed;
//   (3) it knew `@std/`/`node:` but not `jsr:@std/` or `aio/server`.
// It now probes the whole static browser graph Check 4 walks, at any depth.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lintProject } from "../aiol/mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CELL =
  `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`;
const DISK =
  `import { ensureDir } from "@std/fs";\nexport const x = 1;\nexport { ensureDir };\n`;

async function errors(files: Record<string, string>): Promise<string[]> {
  const dir = await tempDir("aiol-chain-");
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
      "src/cell.ts": CELL,
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

Deno.test("aiol chain: App.tsx → disk.ts (one hop) with @std/fs is reported", async () => {
  // Control that the rule works: App.tsx → mid.ts → disk.ts IS reported today.
  const two = await errors({
    "src/App.tsx":
      `import { x } from "./mid.ts";\nexport default function App() { return <div>{x}</div>; }\n`,
    "src/mid.ts": `export { x } from "./disk.ts";\n`,
    "src/disk.ts": DISK,
  });
  assert(
    two.some((m) => m.includes("@std/fs")),
    "control: two-hop chain must be reported",
  );

  const one = await errors({
    "src/App.tsx":
      `import { x } from "./disk.ts";\nexport default function App() { return <div>{x}</div>; }\n`,
    "src/disk.ts": DISK,
  });
  assert(
    one.some((m) => m.includes("@std/fs")),
    `a DIRECT import of a server-only helper from App.tsx is reported by no rule; errors: ${
      JSON.stringify(one)
    }`,
  );
});

Deno.test("aiol chain: a ../ hop is followed", async () => {
  const msgs = await errors({
    "src/ui/App.tsx":
      `import { x } from "../lib/mid.ts";\nexport default function App() { return <div>{x}</div>; }\n`,
    "src/lib/mid.ts": `export { x } from "../disk.ts";\n`,
    "src/disk.ts": DISK,
  });
  assert(
    msgs.some((m) => m.includes("@std/fs") && m.includes("import chain")),
    `the same two-hop chain spelled with ../ is not followed; errors: ${
      JSON.stringify(msgs)
    }`,
  );
});

Deno.test("aiol chain: any depth, printed as the full chain", async () => {
  const msgs = await errors({
    "src/App.tsx":
      `import { x } from "./a.ts";\nexport default function App() { return <div>{x}</div>; }\n`,
    "src/a.ts": `export { x } from "./b.ts";\n`,
    "src/b.ts": `export { x } from "./c.ts";\n`,
    "src/c.ts": `export { x } from "./disk.ts";\n`,
    "src/disk.ts": DISK,
  });
  assert(
    msgs.includes(
      'src/App.tsx → src/a.ts → src/b.ts → src/c.ts → src/disk.ts:1 — transitive server-only import "@std/fs" reaches browser bundle via import chain',
    ),
    JSON.stringify(msgs),
  );
});

Deno.test("aiol chain: the jsr: spelling and aio/server are server-only too", async () => {
  for (const spec of ["jsr:@std/fs@1", "aio/server"]) {
    const msgs = await errors({
      "src/App.tsx":
        `import { x } from "./disk.ts";\nexport default function App() { return <div>{x}</div>; }\n`,
      "src/disk.ts": `import { y } from "${spec}";\nexport const x = y;\n`,
    });
    assert(
      msgs.some((m) => m.includes(`"${spec}"`) && m.includes("import chain")),
      `${spec}: ${JSON.stringify(msgs)}`,
    );
  }
});

Deno.test("aiol chain: a type-only hop or import is not an edge", async () => {
  const msgs = await errors({
    "src/App.tsx":
      `import type { X } from "./disk.ts";\nimport { y } from "./types.ts";\nexport default function App(): X { return <div>{y}</div>; }\n`,
    "src/types.ts":
      `import type { WalkEntry } from "@std/fs";\nexport type W = WalkEntry;\nexport const y = 1;\n`,
    "src/disk.ts": DISK,
  });
  assertEquals(msgs.filter((m) => m.includes("import chain")), []);
});
