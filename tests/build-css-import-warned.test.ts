// `import "./widget.css"` in a component: esbuild bundles it to dist/app.css,
// the dist sweep drops it, and the page links only style.css — the rules never
// ship. The build must say so (a warning, exit 0), naming the file and the fix,
// on a fresh build AND a cached one.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
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
    "build: a CSS file a component imports is warned by name with the fix (exit 0), fresh and cached; none imported → silent",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-css-import-build-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(join(dir, "src/widget.css"), ".w{color:red}\n");
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          appId: "css-import-build",
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
await runBundle({ ...cfg, doForce: Deno.args[0] === "force", doCompile: true }, JSON.parse(await Deno.readTextFile("deno.json")));
`,
      );
      const build = async (mode: string) => {
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", runner, mode],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(out.stderr) +
          new TextDecoder().decode(out.stdout);
        assertEquals(out.code, 0, said);
        return said.replace(/\s+/g, " ");
      };
      const app = (css: boolean) =>
        Deno.writeTextFile(
          join(dir, "src/App.tsx"),
          (css ? `import "./widget.css";\n` : "") +
            `export default function App() { return <div class="w">hi</div>; }\n`,
        );
      await app(true);
      for (const mode of ["force", "cached"]) {
        const said = await build(mode);
        if (mode === "cached") assertStringIncludes(said, "cached");
        assertStringIncludes(said, "src/widget.css");
        assertStringIncludes(said, "never reaches the page");
        assertStringIncludes(said, "@import");
      }
      await app(false);
      const fine = await build("force");
      assert(!fine.includes("never reaches the page"), fine);
    } finally {
      await dropTempDir(dir);
    }
  },
});
