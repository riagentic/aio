// `"build": { "minify": true }` — the compiled binary ships no comments and no
// local names of the server code (build/minify-server.ts). The real build of a
// scaffolded app is in build-e2e-minify.test.ts (AIO_BUILD_E2E=1).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import {
  MINIFY_STAGE,
  minifyDeclared,
  minifyModule,
  stageMinified,
} from "../src/build/minify-server.ts";
import { BUNDLE_MAP } from "../src/server/app-files.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const write = async (p: string, s: string) => {
  await Deno.mkdir(join(p, ".."), { recursive: true });
  await Deno.writeTextFile(p, s);
};

Deno.test("minify: build.minify is off by default, on only for a real true, and a string is refused", async () => {
  const dir = await tempDir("minify-cfg-");
  try {
    const cfg = (build: unknown) =>
      Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ build }));
    await cfg({});
    assertEquals(await minifyDeclared(dir), false);
    await cfg({ minify: true });
    assertEquals(await minifyDeclared(dir), true);
    await cfg({ minify: false });
    assertEquals(await minifyDeclared(dir), false);
    await cfg({ minify: "true" });
    await assertRejects(
      () => minifyDeclared(dir),
      Error,
      'build.minify is "true" — it must be true or false',
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("minify: a module loses its comments and local names, keeps function names and JSX", async () => {
  try {
    const out = await minifyModule(
      esbuild,
      "/x/App.tsx",
      `// DESIGN-NOTE: why the vault works this way
/** doc: also secret */
export function sealVault(secretLocalInput: number): number {
  const secretLocalName = secretLocalInput * 2; /* inline note */
  return secretLocalName;
}
export const View = () => <div class="x">hi</div>;
`,
    );
    for (const gone of ["DESIGN-NOTE", "doc: also", "inline note"]) {
      assert(!out.includes(gone), `${gone} survived:\n${out}`);
    }
    assert(!out.includes("secretLocalName"), out);
    assert(!out.includes("secretLocalInput"), out);
    assert(out.includes("sealVault"), "an exported name is the module's API");
    assert(out.includes("<div"), `JSX is left to Deno's own transform: ${out}`);
    // keepNames: `.name` is what it was.
    const mod = await import(
      "data:text/javascript," +
        encodeURIComponent(
          await minifyModule(
            esbuild,
            "/x/n.ts",
            "function helperWithAName(){}\nexport const n = helperWithAName.name;",
          ),
        )
    );
    assertEquals(mod.n, "helperWithAName");
  } finally {
    await stopEsbuildService(() => esbuild.stop());
  }
});

/** A tiny project: an entry that imports a module through a SYMLINKED dir
 *  (the `dep/aio` layout), a worker reached only by `--include` under its
 *  REAL path, dist/ with the client map, and a node_modules dir. */
async function project(base: string) {
  const root = join(base, "app");
  const lib = join(base, "lib-real");
  await write(
    join(lib, "shared.ts"),
    "// LIB-COMMENT\nexport const shared = (libLocal: number) => libLocal + 1;\n",
  );
  await write(
    join(lib, "worker.ts"),
    "// WORKER-COMMENT\nimport { shared } from './shared.ts';\nself.postMessage(shared(1));\n",
  );
  await write(join(root, "deno.json"), JSON.stringify({ imports: {} }));
  await Deno.mkdir(join(root, "dep"), { recursive: true });
  await Deno.symlink(lib, join(root, "dep", "lib"));
  await write(
    join(root, "src", "app.ts"),
    "// APP-COMMENT\nimport { shared } from '../dep/lib/shared.ts';\nconst appLocal: number = shared(1);\nconsole.log(appLocal);\n",
  );
  await write(join(root, "dist", "app.js"), "x");
  await write(join(root, "dist", BUNDLE_MAP), "{}");
  await Deno.mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  return { root, lib };
}

Deno.test("minify: the stage keeps the layout, follows the app's symlinked path, drops the client map", async () => {
  const base = await tempDir("minify-stage-");
  try {
    const { root, lib } = await project(base);
    const argv = [
      "compile",
      "-q",
      "-A",
      "--include",
      "dist/",
      "--include",
      join(lib, "worker.ts"), // the REAL path, as the builder hands it
      "-o",
      join(base, "out-bin"),
      "src/app.ts",
      "--client=browser",
    ];
    const st = await stageMinified(esbuild, root, argv);
    try {
      // Everything the entry reaches is inside the project (dep/lib through
      // its symlink), so the project IS the staged root.
      assertEquals(st.cwd, join(root, MINIFY_STAGE));
      assertEquals(st.argv[1], "--no-check", "the ORIGINAL was type-checked");
      // The worker sits where the entry's own path space puts it — beside
      // the module that resolves it — never under its real path.
      const worker = st.argv[st.argv.indexOf(join(base, "out-bin")) - 2];
      assertEquals(worker, join(st.cwd, "dep", "lib", "worker.ts"));
      assertEquals(st.argv.at(-1), "--client=browser", "runtime args kept");
      assertEquals(st.argv.at(-2), join(st.cwd, "src", "app.ts"));
      assertEquals(st.argv[st.argv.indexOf("-o") + 1], join(base, "out-bin"));
      for (
        const [f, comment, local] of [
          ["src/app.ts", "APP-COMMENT", "appLocal"],
          ["dep/lib/shared.ts", "LIB-COMMENT", "libLocal"],
          ["dep/lib/worker.ts", "WORKER-COMMENT", ""],
        ]
      ) {
        const text = await Deno.readTextFile(join(st.cwd, f!));
        assert(!text.includes(comment!), `${f}: ${text}`);
        if (local) assert(!text.includes(local), `${f}: ${text}`);
      }
      assert((await Deno.lstat(join(st.cwd, "dep", "lib"))).isDirectory);
      assert((await Deno.lstat(join(st.cwd, "node_modules"))).isSymlink);
      assertEquals(
        await Deno.readTextFile(join(st.cwd, "dist", "app.js")),
        "x",
      );
      await assertRejects(() => Deno.stat(join(st.cwd, "dist", BUNDLE_MAP)));
      assert((await Deno.stat(join(st.cwd, "deno.json"))).isFile);
    } finally {
      await st.dispose();
    }
    await assertRejects(() => Deno.stat(join(root, MINIFY_STAGE)));
  } finally {
    await stopEsbuildService(() => esbuild.stop());
    await dropTempDir(base);
  }
});

Deno.test("minify: a type error in the ORIGINAL still fails the build, and no stage is left", async () => {
  const base = await tempDir("minify-typeerr-");
  try {
    const { root } = await project(base);
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      "const n: number = 'not a number';\nconsole.log(n);\n",
    );
    await assertRejects(
      () =>
        stageMinified(esbuild, root, [
          "compile",
          "-o",
          join(base, "out-bin"),
          "src/app.ts",
        ]),
      Error,
      "type check failed",
    );
    await assertRejects(() => Deno.stat(join(root, MINIFY_STAGE)));
  } finally {
    await stopEsbuildService(() => esbuild.stop());
    await dropTempDir(base);
  }
});

Deno.test("minify: every compile path (app, Electron, Windows exe, cli) runs through runCompile with build.minify", async () => {
  // One decider: a path that compiles with its own `new Deno.Command("deno")`
  // ships the readable tree while deno.json says minify.
  for (const f of ["build-compile.ts", "build-cli.ts"]) {
    const src = await Deno.readTextFile(
      new URL(`../src/build/${f}`, import.meta.url),
    );
    assert(
      src.includes("const minify = await minifyDeclared(root);"),
      `${f} never reads build.minify`,
    );
    assert(
      /await runCompile\(\s*root,[\s\S]*?\),\s*minify,\s*\);/.test(src),
      f,
    );
    assert(
      !/new Deno\.Command\("deno", \{\s*args: (?:_compileArgv|cliCompileArgs)/
        .test(src),
      `${f} compiles around runCompile`,
    );
  }
});
