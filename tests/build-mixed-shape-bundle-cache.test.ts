// One dist/app.js serves every target, so a fleet mixing bundle shapes (a
// browser target and a web or android one) re-ran esbuild for BOTH on every
// build: each found the other's bundle. A bundle of another shape now waits
// in its own slot (.aio/bundle-shapes/) and comes back for its target — and
// the freshness check still decides.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  BUNDLE_INPUTS,
  BUNDLE_SHAPES,
  parkOtherShape,
} from "../src/build/dist-staging.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

Deno.test({
  name:
    "build: browser and web bundles alternate in one dist/ — the second round reuses both, an edit rebuilds",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-mixed-shapes-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await fixtureNodeModules(dir);
      const app = join(dir, "src/App.tsx");
      await Deno.writeTextFile(
        app,
        `export default function App() { return <p>hi</p>; }\n`,
      );
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          appId: "mixed-shapes",
          nodeModulesDir: "manual",
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
          imports: {
            "aio": `${spec(REPO)}mod.ts`,
            "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
            "aio/server": `${REPO}src/server.ts`,
            "immer": "npm:immer@10.2.0",
            "@std/path": "jsr:@std/path@^1",
          },
        }),
      );
      const runner = join(dir, "runner.ts");
      await Deno.writeTextFile(
        runner,
        `import { runBundle } from "${spec(REPO)}src/build/build-bundle.ts";
import { loadBuildConfig } from "${spec(REPO)}src/build/build-config.ts";
const cfg = await loadBuildConfig();
await runBundle(
  { ...cfg, ...JSON.parse(Deno.args[0]) },
  JSON.parse(await Deno.readTextFile("deno.json")),
);
`,
      );
      const build = async (over: Record<string, unknown>) => {
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", runner, JSON.stringify(over)],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(out.stderr) +
          new TextDecoder().decode(out.stdout);
        assertEquals(out.code, 0, said);
        return said.replace(/\s+/g, " ");
      };
      const browser = { doCompile: true };
      const web = { doWeb: true, standalone: true };
      const cached = (s: string) => s.includes("dist/app.js cached");
      assert(!cached(await build(browser)), "first browser build cached");
      assert(!cached(await build(web)), "first web build cached");
      const b2 = await build(browser);
      assert(cached(b2), b2);
      const w2 = await build(web);
      assert(cached(w2), w2);
      // dist/ holds the shape last built, stamped as such.
      assertStringIncludes(
        await Deno.readTextFile(join(dir, "dist/app.js")),
        `__aioBundleTarget = "android"`,
      );
      // An edit: the parked bundle is restored, found stale, and rebuilt.
      await new Promise((r) => setTimeout(r, 20));
      await Deno.writeTextFile(
        app,
        `export default function App() { return <p>edited</p>; }\n`,
      );
      const b3 = await build(browser);
      assert(!cached(b3), b3);
      assertStringIncludes(
        await Deno.readTextFile(join(dir, "dist/app.js")),
        "edited",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("parkOtherShape: same slot is a no-op; nothing is restored over a bundle that could not be parked", async () => {
  const dir = await tempDir("aio-park-shape-");
  const dist = join(dir, "dist");
  const want = { target: "browser", ui: "App.tsx" };
  try {
    await Deno.mkdir(dist);
    await Deno.mkdir(join(dir, ".aio"));
    await Deno.writeTextFile(join(dist, "app.js"), "android-js");
    // Same shape + entry: left alone.
    assert(
      !await parkOtherShape(
        dir,
        dist,
        { target: "browser", ui: "App.tsx" },
        want,
      ),
    );
    assertEquals(await Deno.readTextFile(join(dist, "app.js")), "android-js");
    // A browser slot waits, but the bundle in dist/ has no record: not parked,
    // so nothing comes back over it.
    const slot = join(dir, BUNDLE_SHAPES, "browser-App.tsx");
    await Deno.mkdir(slot, { recursive: true });
    await Deno.writeTextFile(join(slot, "app.js"), "browser-js");
    await Deno.writeTextFile(join(slot, "bundle-inputs.json"), "rec");
    assert(
      !await parkOtherShape(
        dir,
        dist,
        { target: "android", ui: "App.tsx" },
        want,
      ),
    );
    assertEquals(await Deno.readTextFile(join(dist, "app.js")), "android-js");
    // With its record it is parked, and the browser slot comes back.
    await Deno.writeTextFile(join(dir, BUNDLE_INPUTS), "android-rec");
    assert(
      await parkOtherShape(
        dir,
        dist,
        { target: "android", ui: "App.tsx" },
        want,
      ),
    );
    assertEquals(await Deno.readTextFile(join(dist, "app.js")), "browser-js");
    assertEquals(await Deno.readTextFile(join(dir, BUNDLE_INPUTS)), "rec");
    assertEquals(
      await Deno.readTextFile(
        join(dir, BUNDLE_SHAPES, "android-App.tsx", "app.js"),
      ),
      "android-js",
    );
  } finally {
    await dropTempDir(dir);
  }
});
