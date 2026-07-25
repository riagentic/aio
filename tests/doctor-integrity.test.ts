// risoto 2026-07-24 #3 — `aio doctor` integrity sweep: structural problems no
// config check catches (reserved cell keys, duplicate imports, orphaned
// persistence) now surface as doctor FAILs, reusing aiol's error-level checks.
import { assert, assertEquals } from "@std/assert";
import { runDoctor } from "../src/server/doctor.ts";
import { join } from "@std/path";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
      imports: {
        "aio": "jsr:@riagentic/aio",
        "aio/air": "jsr:@riagentic/aio/air",
        "aio/jsx-runtime": "jsr:@riagentic/aio/jsx-runtime",
      },
    }),
  );
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, "src", name), body);
  }
  return dir;
}

const integrityChecks = (checks: { name: string; ok: boolean }[]) =>
  checks.filter((c) => c.name.includes("integrity"));

Deno.test("doctor: a clean project passes the integrity sweep", async () => {
  const dir = await project({
    "app.ts":
      `import { cell } from "aio";\nexport const counter = cell("counter", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  });
  const { checks } = await runDoctor(dir);
  const ig = integrityChecks(checks);
  assertEquals(
    ig.length,
    1,
    `expected one integrity summary; got ${ig.map((c) => c.name)}`,
  );
  assert(ig[0]!.ok, "clean project → integrity passes");
});

Deno.test("doctor: a duplicate import fails the sweep (and doctor overall)", async () => {
  const dir = await project({
    "app.ts":
      `import { cell } from "aio";\nimport { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 } });`,
  });
  const { checks, ok } = await runDoctor(dir);
  const ig = integrityChecks(checks);
  assert(
    ig.some((c) => !c.ok && c.name.includes("imports")),
    `expected an [imports] integrity FAIL; got ${ig.map((c) => c.name)}`,
  );
  assertEquals(ok, false, "a structural error must fail doctor overall");
});

Deno.test("doctor: a server-only import in a browser-bundle cell file fails the sweep (risoto #1d)", async () => {
  const dir = await project({
    "App.tsx": `export default function App() { return <div>hi</div>; }`,
    "cells.ts":
      `import { cell } from "aio";\nimport { readFileSync } from "node:fs";\nexport const c = cell("c", { state: { n: 0 }, methods: { load(s) { s.n = readFileSync ? 1 : 0; } } });`,
  });
  const { checks, ok } = await runDoctor(dir);
  const ig = integrityChecks(checks);
  assert(
    ig.some((c) => !c.ok && c.name.includes("ui")),
    `expected a [ui] boundary FAIL for the node: import; got ${
      ig.map((c) => c.name)
    }`,
  );
  assertEquals(ok, false, "a client/server boundary breach must fail doctor");
});

Deno.test("doctor: a clean project WITH tsx still passes the boundary check", async () => {
  const dir = await project({
    "App.tsx": `export default function App() { return <div>hi</div>; }`,
    "cells.ts":
      `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  });
  const { checks } = await runDoctor(dir);
  const ig = integrityChecks(checks);
  assert(
    ig.every((c) => c.ok),
    `clean tsx project → boundary passes; got ${
      ig.filter((c) => !c.ok).map((c) => c.name)
    }`,
  );
});

Deno.test("doctor: a reserved cell state key fails the sweep", async () => {
  const dir = await project({
    "app.ts":
      `import { cell } from "aio";\nexport const c = cell("c", { state: { constructor: 1, n: 0 } });`,
  });
  const { checks } = await runDoctor(dir);
  const ig = integrityChecks(checks);
  assert(
    ig.some((c) => !c.ok && c.name.includes("cells")),
    `expected a [cells] integrity FAIL; got ${ig.map((c) => c.name)}`,
  );
});
