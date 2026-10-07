// The dev server's prod-bundle judge loaded esbuild by itself, apart from the
// transpiler — and `stopEsbuild()` learned of the service only through the
// transpiler's load. A boot whose whole graph the transpile cache answered
// never made that load: the second `aio.run()` on one directory in one
// process. The judge's build started the service, close found nothing to stop
// and returned, and esbuild's native child outlived the server. Both now load
// through one loader, which records the stop.
//
// The sanitizers are the oracle: the child alive when the test returns, or
// its pending wait, fails it.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  normPath,
  stopEsbuild,
  transpileCache,
} from "../src/server/server-transpile.ts";
import { createProdGraphCheck } from "../src/server/graph-validator.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** What makes `dir` an app the judge can bundle: a deno.json and its own
 *  node_modules (the framework checkout has none of its own to fall back on). */
async function project(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "auto",
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
      imports: {
        "aio": `${spec(ROOT)}mod.ts`,
        "aio/jsx-runtime": `${spec(ROOT)}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  await fixtureNodeModules(dir);
}

/** The boot's import-graph verdict, from the server itself — `pending`
 *  until the validation (walk + prod-bundle judge) has landed. */
async function graphVerdict(
  port: number,
): Promise<{ valid: boolean }> {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/graph`);
    const g = await r.json();
    if (!g.pending) return g;
    assert(Date.now() - t0 < 30_000, "the graph verdict never landed");
    // Asked 40 times a second: the control plane takes 100.
    await new Promise((r) => setTimeout(r, 25));
  }
}

Deno.test({
  name: "two boots on one directory: close leaves no esbuild service",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-two-boots-");
    const entry = join(dir, "App.tsx");
    await project(dir);
    await Deno.writeTextFile(
      entry,
      "export default function App() { return <main>hi</main>; }\n",
    );
    // The boot lines are not this test's subject.
    const orig = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      console[k] = () => {};
    }
    try {
      for (const boot of [1, 2]) {
        // The second boot is the case: the first one's transpile is cached.
        assert(
          transpileCache.has(normPath(entry)) === (boot === 2),
          `boot ${boot}: the transpile cache is ${
            boot === 2 ? "empty" : "already filled"
          }`,
        );
        const port = freePort();
        const app = await aio.run({
          cells: [cell(`tbod${boot}`, { state: { n: 0 }, methods: {} })],
          appId: `test-two-boots-${boot}`,
          client: "browser",
          persist: false,
          libraryMode: true,
          port,
          baseDir: dir,
        });
        try {
          // The boot's validation — the walk that fills the cache, then the
          // judge's build — has RUN before the close: a close ends one still
          // running, and then neither boot would be the case.
          const verdict = await graphVerdict(port);
          assert(verdict.valid, JSON.stringify(verdict));
        } finally {
          await app.close();
        }
      }
    } finally {
      Object.assign(console, orig);
      await dropTempDir(dir);
    }
  },
});

// The judge's build is esbuild work like any transpile: a stop asked while it
// runs — another server of the same process closing — waits for it. Undeclared,
// the stop went first and the build started the service again behind it.
Deno.test({
  name: "a stop asked while the judge builds waits for the build",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("aio-judge-build-");
    try {
      await project(dir);
      await Deno.writeTextFile(
        join(dir, "App.tsx"),
        "export default function App() { return <main>hi</main>; }\n",
      );
      await stopEsbuild(); // a clean slate
      const judge = createProdGraphCheck({
        absBaseDir: dir,
        uiEntry: "App.tsx",
      });
      const judging = judge("graph-hash");
      await stopEsbuild();
      const verdict = await judging;
      // Stopped under its build, the judge refused a bundle that builds.
      assertEquals(
        verdict.errors.map((e) => e.message),
        [],
        "the judge's verdict on an app with nothing wrong",
      );
      assert(!verdict.cached, "…from a build it really ran");
    } finally {
      await dropTempDir(dir);
    }
  },
});
