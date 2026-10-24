// Under the fleet, a bundle step's staging lines said "goes into the binary;
// not in the final dist/" for the web target too — which has no binary: its
// files go into the web app's folder. The line names what the target makes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { BUILD_VERSION_ENV } from "../src/server/app-version.ts";
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
    "build: a web build's staging lines say they go into the web app, a binary's into the binary",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-staged-into-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(
        join(dir, "src/App.tsx"),
        `export default function App() { return <p>hi</p>; }\n`,
      );
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          appId: "staged-into",
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
  { ...cfg, doForce: true, ...JSON.parse(Deno.args[0]) },
  JSON.parse(await Deno.readTextFile("deno.json")),
);
`,
      );
      const build = async (over: Record<string, unknown>) => {
        const out = await new Deno.Command(Deno.execPath(), {
          env: {
            DENO_COVERAGE_DIR: childCoverageDir(),
            NO_COLOR: "1",
            [BUILD_VERSION_ENV]: JSON.stringify({
              version: "1.0.0",
              base: "1.0",
              build: 0,
              commit: null,
              dirty: false,
              source: "nogit",
            }),
          },
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
      const web = await build({ doWeb: true, standalone: true });
      assertStringIncludes(web, "built dist/app.js");
      assertStringIncludes(
        web,
        "goes into the web app; not in the final dist/",
      );
      assert(!web.includes("goes into the binary"), web);
      const binary = await build({ doCompile: true });
      assertStringIncludes(
        binary,
        "goes into the binary; not in the final dist/",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
