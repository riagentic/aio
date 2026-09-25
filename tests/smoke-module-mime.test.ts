// `smoke()` must judge a module by what the BROWSER accepts, not by the status
// line: a module script served with a non-JavaScript Content-Type is refused
// (strict MIME checking) — a blank screen behind a 200.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { _isJsMime, smoke } from "../src/testing/smoke-test.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const probe = cell("smoke-mime-probe", { state: { n: 0 }, methods: {} });

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await tempDir("aio-smoke-mime-");
  for (const [name, body] of Object.entries(files)) {
    const full = `${dir}/${name}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, body);
  }
  return dir;
}

Deno.test("smoke: a module served 200 with a non-JavaScript Content-Type fails, naming the file, the type and the importer chain", async () => {
  // `.cjs` resolves and parses for the graph, but the dev server does not
  // serve it as a module — it answers 200 `application/octet-stream`, which
  // the browser refuses for a module script.
  const dir = await fixture({
    "App.tsx": `import { h } from "aio/air";
import { label } from "./lib/label.ts";
export default function App() { return h("div", null, label); }`,
    "lib/label.ts":
      `import { v } from "./legacy.cjs";\nexport const label = String(v);`,
    "lib/legacy.cjs": `export const v = 1;`,
  });
  try {
    const err = await assertRejects(
      () => smoke({ baseDir: dir, cells: [probe] }),
      Error,
    );
    assert(err.message.includes("/lib/legacy.cjs"), err.message);
    assert(err.message.includes("Content-Type"), err.message);
    assert(err.message.includes("application/octet-stream"), err.message);
    assert(
      err.message.includes("App.tsx → lib/label.ts → lib/legacy.cjs"),
      err.message,
    );
  } finally {
    await stopEsbuild();
    await dropTempDir(dir);
  }
});

Deno.test("smoke: every module shape the dev server serves as JavaScript passes (.ts .tsx .jsx .js .mjs)", async () => {
  const dir = await fixture({
    "App.tsx": `import { h } from "aio/air";
import { a } from "./a.js";
import { b } from "./b.mjs";
import { c } from "./c.jsx";
import { d } from "./d.ts";
export default function App() { return h("div", null, a + b + c + d); }`,
    "a.js": `export const a = "a";`,
    "b.mjs": `export const b = "b";`,
    "c.jsx": `export const c = String(<i/>);`,
    "d.ts": `export const d: string = "d";`,
  });
  try {
    const r = await smoke({ baseDir: dir, cells: [probe] });
    assertEquals(r.checked.sort(), [
      "/App.tsx",
      "/a.js",
      "/b.mjs",
      "/c.jsx",
      "/d.ts",
    ]);
  } finally {
    await stopEsbuild();
    await dropTempDir(dir);
  }
});

Deno.test("smoke: _isJsMime accepts every JavaScript MIME essence, parameters and case aside, and nothing else", () => {
  for (
    const t of [
      "application/javascript",
      "text/javascript; charset=utf-8",
      "Text/JavaScript",
      "application/x-javascript",
      "text/ecmascript",
    ]
  ) assert(_isJsMime(t), t);
  for (
    const t of [
      "",
      "application/octet-stream",
      "text/plain",
      "text/css",
      "application/json",
      "text/html",
    ]
  ) assert(!_isJsMime(t), t);
});
