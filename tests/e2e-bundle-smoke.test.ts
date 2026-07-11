// Bundle-smoke gate — the AIO-404 class, captured in advance. Compiled
// targets broke TWICE from refactors (folderization killed module paths;
// android needed iife + registry boot, not esm) and nothing in CI noticed:
// bundling was only exercised by hand. This gate runs the REAL esbuild
// bundle step (src/build/build-bundle.ts, the exact fragile code) for both
// shapes on a scaffolded-style app and asserts the invariants that broke:
//   browser → ESM with an exported mount()
//   android → IIFE (classic <script> — `export` would throw) + registry boot
import { assert, assertStringIncludes } from "@std/assert";

// Coverage profiles from spawned deno processes go to a throwaway temp dir.
const _childCovDir = Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

const ROOT = new URL("..", import.meta.url).pathname;

async function makeApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-bundle-" });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Bundle Probe",
      nodeModulesDir: "auto",
      unstable: ["kv"],
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  // reuse the framework repo's node_modules for npm resolution (immer)
  await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
  await Deno.writeTextFile(
    `${dir}/src/cell.ts`,
    `import { cell } from "aio";
export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  );
  await Deno.writeTextFile(
    `${dir}/src/App.tsx`,
    `import { c } from "./cell.ts";
export default function App() {
  return <button onClick={() => c.inc()}>{c.n}</button>;
}`,
  );
  return dir;
}

/** Run the real bundle step in a subprocess (it exits the process on
 *  failure) and return the produced dist/app.js. */
async function bundle(dir: string, android: boolean): Promise<string> {
  const runner = `${dir}/_runner.ts`;
  await Deno.writeTextFile(
    runner,
    `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
await runBundle({
  root,
  dist: root + "/dist",
  out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  isRemote: false,
  doAndroid: ${android},
  doForce: true,
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["run", "-A", "--unstable-kv", runner],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `bundle (android=${android}) failed:\n${
        new TextDecoder().decode(out.stderr)
      }${new TextDecoder().decode(out.stdout)}`,
    );
  }
  return await Deno.readTextFile(`${dir}/dist/app.js`);
}

Deno.test({
  name: "bundle smoke: browser bundle is ESM with mount(), deps inlined",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp();
    try {
      const js = await bundle(dir, false);
      assertStringIncludes(js, "export {"); // ESM — importer calls mount()
      assertStringIncludes(js, "mount");
      assertStringIncludes(js, "ensureConnected"); // registry boot wired
      assert(!js.includes('from "npm:'), "npm specifiers must be inlined");
      assert(js.length > 50_000, "framework must actually be bundled in");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "bundle smoke: android bundle is IIFE with registry boot (AIO-404)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp();
    try {
      const js = await bundle(dir, true);
      // classic <script> in the WebView — a top-level `export` throws
      assert(!/^export /m.test(js), "android bundle must not be ESM");
      assert(!js.includes("\nexport {"), "android bundle must not export");
      assertStringIncludes(js, "ensureConnected"); // boots from the registry
      assertStringIncludes(js, "DOMContentLoaded"); // auto-mount wiring
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
