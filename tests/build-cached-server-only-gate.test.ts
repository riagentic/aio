// The standalone server-only refusal ran only when esbuild ran. A bundle
// cached by a build EXEMPT from it (`--android --remote`, or
// `--allow-server-only`) was reused, unjudged, by a standalone build that is
// not (`--web`, local `--android`): "dist/app.js cached", exit 0 — the
// buttons-do-nothing app the refusal exists to stop. The findings now ride in
// the input record and the cached path applies the same decider.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { serverOnlyRefusal } from "../src/build/build-bundle.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

Deno.test("serverOnlyRefusal: one decider — standalone refuses, exempt builds ship", () => {
  const found = { "node:child_process": ["/app/src/App.tsx"] };
  const web = { doWeb: true, doRemote: false, allowServerOnly: false };
  const refused = serverOnlyRefusal(web, true, "/app", found);
  assertStringIncludes(refused?.join("\n") ?? "", "reaches server-only code");
  assertStringIncludes(
    refused?.join("\n") ?? "",
    "src/App.tsx → node:child_process",
  );
  assertEquals(serverOnlyRefusal(web, true, "/app", {}), null, "nothing found");
  assertEquals(serverOnlyRefusal(web, false, "/app", found), null, "browser");
  assertEquals(
    serverOnlyRefusal({ ...web, doRemote: true }, true, "/app", found),
    null,
    "--remote",
  );
  assertEquals(
    serverOnlyRefusal({ ...web, allowServerOnly: true }, true, "/app", found),
    null,
    "--allow-server-only",
  );
});

Deno.test({
  name:
    "build: a standalone build reusing a bundle cached by an exempt build still refuses server-only code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await tempDir("aio-gate-cache-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(
        join(dir, "src/App.tsx"),
        `export default function App() {
  const go = async () => { const cp = await import("node:child_process"); console.log(cp); };
  return <button onClick={go}>go</button>;
}\n`,
      );
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          appId: "gate-cache",
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
await runBundle({ ...cfg, ...JSON.parse(Deno.args[0]) }, JSON.parse(await Deno.readTextFile("deno.json")));
`,
      );
      const build = async (over: Record<string, unknown>) => {
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", "--no-lock", runner, JSON.stringify(over)],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(out.stderr) +
          new TextDecoder().decode(out.stdout);
        return { code: out.code, said: said.replace(/\s+/g, " ") };
      };
      // Control: a fresh local web build refuses.
      const control = await build({ doWeb: true, standalone: true });
      assertEquals(control.code, 1, control.said);
      assertStringIncludes(control.said, "reaches server-only code");
      // Exempt builds, each leaving a bundle (and its record) behind.
      for (
        const exempt of [
          { doAndroid: true, standalone: true, doRemote: true },
          { doWeb: true, standalone: true, allowServerOnly: true },
        ]
      ) {
        const ok = await build(exempt);
        assertEquals(ok.code, 0, ok.said);
        // Same sources, a standalone web build: refused exactly as the
        // control was — and from the cache, not by rebuilding.
        const web = await build({ doWeb: true, standalone: true });
        assertEquals(
          web.code,
          1,
          `${JSON.stringify(exempt)} then --web shipped unjudged: ${web.said}`,
        );
        assertStringIncludes(web.said, "cached");
        assertStringIncludes(web.said, "reaches server-only code");
        assertStringIncludes(web.said, "src/App.tsx → node:child_process");
        // …and the refusal left nothing for a third run to reuse.
        const again = await build({ doWeb: true, standalone: true });
        assertEquals(again.code, 1, again.said);
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
