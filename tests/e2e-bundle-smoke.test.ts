// Bundle-smoke gate — the AIO-404 class, captured in advance. Compiled
// targets broke TWICE from refactors (folderization killed module paths;
// android needed iife + registry boot, not esm) and nothing in CI noticed:
// bundling was only exercised by hand. This gate runs the REAL esbuild
// bundle step (src/build/build-bundle.ts, the exact fragile code) for both
// shapes on a scaffolded-style app and asserts the invariants that broke:
//   browser → ESM with an exported mount()
//   android → IIFE (classic <script> — `export` would throw) + registry boot
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// Coverage profiles from spawned deno processes go to a throwaway temp dir.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

const ROOT = new URL("..", import.meta.url).pathname;

/** `flat: true` builds the OTHER sanctioned layout — entry, App.tsx and a
 *  nested component at the project root (`examples/counter`) instead of under
 *  `src/`. Both are legal; the app dir is the entry's directory either way. */
async function makeApp(opts: { flat?: boolean } = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-bundle-" });
  const appSub = opts.flat ? "" : "/src";
  if (!opts.flat) await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Bundle Probe",
      ...(opts.flat ? { entry: "app.ts" } : {}),
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
    `${dir}${appSub}/cell.ts`,
    `import { cell } from "aio";
export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  );
  if (opts.flat) {
    // A component one level BELOW the app dir — the input a shallow freshness
    // check misses.
    await Deno.mkdir(`${dir}/components`);
    await Deno.writeTextFile(
      `${dir}/components/Btn.tsx`,
      `import { c } from "../cell.ts";
export function Btn() { return <button onClick={() => c.inc()}>MARKER_BEFORE {c.n}</button>; }`,
    );
    await Deno.writeTextFile(
      `${dir}/App.tsx`,
      `import { Btn } from "./components/Btn.tsx";
export default function App() { return <Btn />; }`,
    );
    // The stylesheet lives beside the entry, which for a flat app is the
    // project root — NOT `src/`. The whole "white border" report was the build
    // looking for it in the wrong one of those two places.
    await Deno.writeTextFile(`${dir}/style.css`, "body{margin:0}");
    return dir;
  }
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
async function bundle(
  dir: string,
  android: boolean,
  force = true,
  uiEntry?: string,
): Promise<string> {
  // In a DOT-DIR: for a flat-layout app the project root IS the app dir, so a
  // stray `.ts` written beside App.tsx would itself count as an edited input
  // and bust the freshness cache the tests below measure.
  const runner = `${dir}/.aio-build/runner.ts`;
  await Deno.mkdir(`${dir}/.aio-build`, { recursive: true });
  await Deno.writeTextFile(
    runner,
    `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
import { resolveAppDir } from "${ROOT}src/build/build-config.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
// The app dir comes from THE decider, never a literal — a hand-rolled path
// here would be exactly the second decider WYSIDIWYSIP exists to forbid.
const configEntry = mainConfig.entry ?? "src/app.ts";
await runBundle({
  root,
  dist: root + "/dist",
  out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  isRemote: false,
  doAndroid: ${android},
  doForce: ${force},
  configEntry,
  appDir: resolveAppDir(root, configEntry),
  uiEntry: ${JSON.stringify(uiEntry ?? "App.tsx")},
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

// ── Freshness: a cached bundle may never hide an edit ───────────────────
//
// `dist/app.js` is reused when it is newer than every input, and the walk that
// decides "every input" used to be `src/` only. A FLAT app — entry, App.tsx
// and components at the project root, the `examples/counter` layout — was then
// checked one level deep at best, so editing `components/Btn.tsx` and running
// the build again silently re-shipped the previous bundle. That is the
// cached-stale-build class: the source says one thing, the artifact another,
// and nothing warns. The walk is now recursive from THE app dir, skipping only
// build output and vendored trees.
Deno.test({
  name: "bundle freshness: an edit in a nested component busts the cache",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp({ flat: true });
    try {
      const first = await bundle(dir, false);
      assertStringIncludes(first, "MARKER_BEFORE");

      // Same second, different bytes: mtime granularity must not be what
      // saves us, so push the file's mtime forward explicitly.
      const nested = `${dir}/components/Btn.tsx`;
      await Deno.writeTextFile(
        nested,
        (await Deno.readTextFile(nested)).replace(
          "MARKER_BEFORE",
          "MARKER_AFTER",
        ),
      );
      const future = new Date(Date.now() + 2000);
      await Deno.utime(nested, future, future);

      const second = await bundle(dir, false, /* force */ false);
      assertStringIncludes(
        second,
        "MARKER_AFTER",
        "a nested component edit must invalidate the cached bundle — a build " +
          "that silently re-ships the previous artifact is the worst kind",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// The other half of the same rule: the cache must still WORK. A walk that
// wandered into dist/ would see its own freshly written output and rebuild
// forever — slow, and it would make the assertion above meaningless.
Deno.test({
  name: "bundle freshness: an untouched app reuses the cached bundle",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp({ flat: true });
    try {
      await bundle(dir, false);
      const built = (await Deno.stat(`${dir}/dist/app.js`)).mtime!.getTime();
      await bundle(dir, false, /* force */ false);
      assertEquals(
        (await Deno.stat(`${dir}/dist/app.js`)).mtime!.getTime(),
        built,
        "nothing changed — the bundle must be reused, not rewritten",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// Every target writes the SAME dist/app.js, and the two shapes are not
// interchangeable: browser is ESM exporting mount(), android is an IIFE that
// auto-mounts. Nothing in an mtime can tell them apart, so the freshness check
// reads the shape back out of the artifact. Without that, `--android` right
// after a browser build reuses a bundle that cannot boot in a WebView — a
// blank app, no error anywhere.
Deno.test({
  name: "bundle freshness: switching target never reuses the other shape",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp();
    try {
      const browser = await bundle(dir, false);
      assertStringIncludes(browser, "export {");

      const android = await bundle(dir, true, /* force */ false);
      assert(
        !android.includes("\nexport {"),
        "an android build must not reuse the cached ESM browser bundle",
      );
      assertStringIncludes(android, "DOMContentLoaded");

      // …and back, so the guard is symmetric rather than one-directional.
      const again = await bundle(dir, false, /* force */ false);
      assertStringIncludes(
        again,
        "export {",
        "a browser build must not reuse the cached android IIFE bundle",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// The "white border" report itself, at the build. Dev serves `style.css` from
// the app dir; the build used to copy it from a hardcoded `src/`. For a flat
// app those are different directories, so the prod artifact silently shipped
// with no CSS at all — a default 8px body margin around an app that looked
// right in dev. Nothing failed. One decider, and a real build proves it.
Deno.test({
  name: "bundle assets: a flat app's style.css reaches dist/",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp({ flat: true });
    try {
      await bundle(dir, false);
      assertEquals(
        await Deno.readTextFile(`${dir}/dist/style.css`),
        "body{margin:0}",
        "the stylesheet dev serves must be the one the build packages",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// `ui.entry` / `build.ui` must reach the BUNDLE, not just the dev server
// (rimote R-2). Before this the bundler hardcoded App.tsx, so an app that set
// it rendered one component in dev and another once compiled — and the bundle
// carried nothing that could reveal the swap.
Deno.test({
  name:
    "ui entry: the bundle is built from the configured component and says so",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await makeApp();
    try {
      await Deno.writeTextFile(
        `${dir}/src/Status.tsx`,
        `export default function Status() { return <p>MARKER_STATUS_UI</p>; }`,
      );
      const js = await bundle(dir, false, true, "Status.tsx");
      assertStringIncludes(js, "MARKER_STATUS_UI");
      // The stamp is what lets the SERVER refuse a bundle built from a
      // different component than the one it is configured to serve.
      assertStringIncludes(js, 'globalThis.__aioBundleUi = "Status.tsx"');

      // Switching the UI entry must invalidate the cache: same version, same
      // target shape, same mtimes — only the component differs, and reusing
      // the old bundle is the divergence in a new costume.
      const back = await bundle(dir, false, /* force */ false, "App.tsx");
      assert(
        !back.includes("MARKER_STATUS_UI"),
        "a bundle built from another UI entry must not be reused",
      );
      assertStringIncludes(back, 'globalThis.__aioBundleUi = "App.tsx"');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
