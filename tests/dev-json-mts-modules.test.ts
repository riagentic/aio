/**
 * Dev loads a JSON module and a `.mts` module the way the bundle does.
 *
 * - `import data from "./data.json" with { type: "json" }` — the graph
 *   validator fed the JSON to the TS transpiler, got "Expected ';'", and the
 *   whole page became the diagnostic page. The bundle loads it fine.
 * - `import { m } from "./util.mts"` — `.mts` is TypeScript the bundle
 *   compiles; dev served it raw as `application/octet-stream`, which a browser
 *   refuses to run as a module.
 */
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { stopEsbuild, transpile } from "../src/server/server-transpile.ts";
import { validateGraph } from "../src/server/graph-validator.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

async function project(): Promise<string> {
  const p = await tempDir("aio-json-mts-");
  await Deno.writeTextFile(
    join(p, "App.tsx"),
    `import data from "./data.json" with { type: "json" };\n` +
      `import { m } from "./util.mts";\n` +
      `export default function App() { return <div>{data.name} {m}</div>; }\n`,
  );
  await Deno.writeTextFile(join(p, "data.json"), `{"name": "JSON_OK"}\n`);
  await Deno.writeTextFile(
    join(p, "util.mts"),
    `export const m: string = "MTS_OK";\n`,
  );
  return p;
}

Deno.test("dev modules: a JSON module import is valid in the graph, and invalid JSON is named as JSON", async () => {
  const p = await project();
  try {
    const ok = await validateGraph(join(p, "App.tsx"), {}, transpile);
    assertEquals(ok.errors, [], JSON.stringify(ok.errors));
    assert(ok.valid);

    await Deno.writeTextFile(join(p, "data.json"), `{"name": broken\n`);
    const bad = await validateGraph(join(p, "App.tsx"), {}, transpile);
    const hit = bad.errors.find((e) => e.file === join(p, "data.json"));
    assert(hit, JSON.stringify(bad.errors));
    assertStringIncludes(hit.message, "Invalid JSON");
  } finally {
    await stopEsbuild();
    await dropTempDir(p);
  }
});

Deno.test("dev modules: a .mts module is compiled and served as JavaScript", async () => {
  const p = await project();
  try {
    const { serveStatic } = createStaticHandler(deps({ absBaseDir: p }));
    const r = await serveStatic("/util.mts");
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("content-type"), "application/javascript");
    const code = await r.text();
    assertStringIncludes(code, "MTS_OK");
    assert(!code.includes(": string"), `types left in: ${code}`);
  } finally {
    await stopEsbuild();
    await dropTempDir(p);
  }
});
