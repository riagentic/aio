/**
 * Live reload follows the SERVED module graph, not an extension list.
 *
 * 1. The watcher reloaded on `.ts/.tsx/.css/.html/.svg` only, so editing a
 *    `.js`/`.mjs`/`.jsx` module the dev server serves never reloaded the page
 *    — while build output (`dist/app.js`) must still never reload it.
 * 2. A module served from a `serveDirs` (or `share`) root outside the app was
 *    not watched at all: editing it left a stale page. It is watched exactly
 *    (its folder, non-recursive, that file only), honouring `watch: false` /
 *    `watch: [...]`, and closed on shutdown (the sanitizers check that).
 */
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";

type Cfg = Parameters<typeof createServer>[0];

function boot(
  baseDir: string,
  reloads: string[],
  extra: Record<string, unknown> = {},
): { port: number; server: ReturnType<typeof createServer> } {
  const port = freePort();
  const server = createServer(
    {
      port,
      title: "served-reload",
      appId: "served-reload",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir,
      debug: () => {},
      prod: false,
      onReload: (s: string) => reloads.push(s),
      ...extra,
    } as unknown as Cfg,
  );
  return { port, server };
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Past the debounce ceiling (DEBOUNCE_MAX_MS) and the graph check. */
const settle = () => new Promise((r) => setTimeout(r, 900));

async function get(port: number, path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  assertEquals(res.status, 200, path);
  return await res.text();
}

Deno.test("dev reload: an edit to a served .js/.mjs/.jsx module reloads the page, unserved build output does not", async () => {
  const p = await tempDir("aio-served-reload-");
  await Deno.mkdir(join(p, "dist"));
  await Deno.mkdir(join(p, "node_modules", "pkg"), { recursive: true });
  await Deno.writeTextFile(
    join(p, "App.tsx"),
    `import { a } from "./a.js";\nimport { b } from "./b.mjs";\n` +
      `import { C } from "./c.jsx";\n` +
      `export default function App() { return <C>{a}{b}</C>; }\n`,
  );
  await Deno.writeTextFile(join(p, "a.js"), `export const a = "A1";\n`);
  await Deno.writeTextFile(join(p, "b.mjs"), `export const b = "B1";\n`);
  await Deno.writeTextFile(
    join(p, "c.jsx"),
    `export function C(p) { return <i>{p.children}</i>; }\n`,
  );
  await Deno.writeTextFile(join(p, "dist", "app.js"), `/* bundle */\n`);
  const reloads: string[] = [];
  const { port, server } = boot(p, reloads);
  try {
    for (const f of ["/App.tsx", "/a.js", "/b.mjs", "/c.jsx"]) {
      await get(port, f);
    }
    await settle();
    reloads.length = 0;

    // Build output and a dependency tree the page never loaded: no reload.
    await Deno.writeTextFile(join(p, "dist", "app.js"), `/* rebuilt */\n`);
    await Deno.writeTextFile(join(p, "dist", "chunk.mjs"), `export {};\n`);
    await Deno.writeTextFile(
      join(p, "node_modules", "pkg", "index.js"),
      `export {};\n`,
    );
    await settle();
    assertEquals(reloads, [], "unserved build output reloaded the page");

    for (
      const [file, body, marker] of [
        ["a.js", `export const a = "A2";\n`, "A2"],
        ["b.mjs", `export const b = "B2";\n`, "B2"],
        ["c.jsx", `export function C() { return <b>C2</b>; }\n`, "C2"],
      ] as const
    ) {
      await Deno.writeTextFile(join(p, file), body);
      await until(`${file} edit reloads`, () => reloads.includes("reload"));
      assertStringIncludes(await get(port, `/${file}`), marker);
      await settle();
      reloads.length = 0;
    }
  } finally {
    await server.shutdown();
    await stopEsbuild();
    await dropTempDir(p);
  }
});

/** An app, and a library OUTSIDE it served through `serveDirs`. */
async function appWithLib(): Promise<
  { root: string; app: string; lib: string }
> {
  const root = await tempDir("aio-served-lib-");
  const app = join(root, "app");
  const lib = join(root, "lib");
  await Deno.mkdir(app);
  await Deno.mkdir(lib);
  await Deno.writeTextFile(
    join(app, "App.tsx"),
    `export default function App() { return <div/>; }\n`,
  );
  await Deno.writeTextFile(join(lib, "fmt.ts"), `export const f = "F1";\n`);
  await Deno.writeTextFile(join(lib, "raw.js"), `export const r = "R1";\n`);
  await Deno.writeTextFile(join(lib, "other.ts"), `export const o = 1;\n`);
  return { root, app, lib };
}

Deno.test("dev reload: a module served from a serveDirs root outside the app reloads the page on edit", async () => {
  const { root, app, lib } = await appWithLib();
  const reloads: string[] = [];
  const { port, server } = boot(app, reloads, { serveDirs: { "/lib": lib } });
  try {
    await get(port, "/lib/fmt.ts");
    await get(port, "/lib/raw.js");
    await settle();
    reloads.length = 0;

    // A file in the same folder the page never loaded: not watched.
    await Deno.writeTextFile(join(lib, "other.ts"), `export const o = 2;\n`);
    await settle();
    assertEquals(reloads, [], "an unserved sibling reloaded the page");

    await Deno.writeTextFile(join(lib, "fmt.ts"), `export const f = "F2";\n`);
    await until("lib/fmt.ts edit reloads", () => reloads.includes("reload"));
    assertStringIncludes(await get(port, "/lib/fmt.ts"), "F2");
    await settle();
    reloads.length = 0;

    await Deno.writeTextFile(join(lib, "raw.js"), `export const r = "R2";\n`);
    await until("lib/raw.js edit reloads", () => reloads.includes("reload"));
  } finally {
    await server.shutdown();
    await stopEsbuild();
    await dropTempDir(root);
  }
});

Deno.test("dev reload: watch:false and watch:[...] add no watch over a served serveDirs module", async () => {
  for (const watch of [false, ["."]] as const) {
    const { root, app, lib } = await appWithLib();
    const reloads: string[] = [];
    const { port, server } = boot(app, reloads, {
      serveDirs: { "/lib": lib },
      watch,
    });
    try {
      await get(port, "/lib/fmt.ts");
      await settle();
      reloads.length = 0;
      await Deno.writeTextFile(join(lib, "fmt.ts"), `export const f = "F2";\n`);
      await settle();
      assertEquals(reloads, [], `watch: ${JSON.stringify(watch)} was widened`);
    } finally {
      await server.shutdown();
      await stopEsbuild();
      await dropTempDir(root);
    }
  }
});
