// A browser module's `new URL("./x.wasm", import.meta.url)` works in dev and
// 404s from every artifact (field report: JotWord §1). One decider
// (src/build/asset-urls.ts) read by the build and by aiol (check-assets.ts).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  mountsOf,
  unmountedAssetUrlMessage,
  unmountedAssetUrls,
} from "../src/build/asset-urls.ts";
import { buildContext } from "../aiol/context.ts";
import { checkAssetUrls, runAssetMounts } from "../aiol/check-assets.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

const files = new Set([
  "src/core/xcore_bg.wasm",
  "assets/xcore_bg.wasm",
  "assets/model.bin",
]);
const isFile = (rel: string) => files.has(rel);

Deno.test("unmountedAssetUrls: a file beside the module is flagged; a module, a remote URL, a missing file and a mount-served URL are not", () => {
  const src = [
    `const a = new URL("./xcore_bg.wasm", import.meta.url);`, // flagged
    `const b = new URL("./other.ts", import.meta.url);`, // a module
    `const c = new URL("https://cdn/x.wasm", import.meta.url);`, // remote
    `const d = new URL("./typo.wasm", import.meta.url);`, // no such file
    `// new URL("./xcore_bg.wasm", import.meta.url)`, // a comment
  ].join("\n");
  const got = unmountedAssetUrls({
    module: "src/core/glue.ts",
    src,
    mounts: [],
    isFile,
  });
  assertEquals(got, [{
    line: 1,
    spec: "./xcore_bg.wasm",
    file: "src/core/xcore_bg.wasm",
    url: "/xcore_bg.wasm",
  }]);
  const [headline, fix] = unmountedAssetUrlMessage("src/core/glue.ts", got[0]!);
  assertStringIncludes(headline, "404 in the packaged app");
  assertStringIncludes(fix, `"assets": { "/assets": "./assets" }`);
});

Deno.test("unmountedAssetUrls: a URL the bundle resolves into a mount passes; a file in a mount reached by the wrong URL is told its mount URL", () => {
  const mounts = mountsOf({ "/assets": "./assets" });
  assertEquals(mounts, [{ prefix: "/assets", rel: "assets" }]);
  // From src/x.ts, "../assets/model.bin" is /assets/model.bin from /app.js too.
  assertEquals(
    unmountedAssetUrls({
      module: "src/x.ts",
      src: `new URL("../assets/model.bin", import.meta.url)`,
      mounts,
      isFile,
    }),
    [],
  );
  // Two levels down, the same file: dev resolves it, the bundle does not.
  const got = unmountedAssetUrls({
    module: "src/core/glue.ts",
    src: `new URL("../../assets/xcore_bg.wasm", import.meta.url)`,
    mounts: mountsOf({ "/static": "./assets" }),
    isFile,
  });
  assertEquals(got.length, 1);
  assertEquals(got[0]!.mountUrl, "/static/xcore_bg.wasm");
  assertStringIncludes(
    unmountedAssetUrlMessage("src/core/glue.ts", got[0]!)[1],
    `new URL("static/xcore_bg.wasm", document.baseURI)`,
  );
});

Deno.test("runAssetMounts: the literal mounts inside aio.run(…)", () => {
  assertEquals(
    runAssetMounts(
      `import { aio } from "aio";\nawait aio.run({\n  assets: { "/assets": "./assets", '/m': './media' },\n});\n`,
    ),
    [
      { prefix: "/assets", dir: "./assets", line: 3 },
      { prefix: "/m", dir: "./media", line: 3 },
    ],
  );
  assertEquals(runAssetMounts(`const assets = { "/x": "./y" };`), []);
});

async function lint(files: Record<string, string>) {
  const dir = await tempDir("aiol-assets-");
  try {
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), body);
    }
    const { ctx, report } = await buildContext(dir);
    await checkAssetUrls(ctx);
    return report.issues.filter((i) => i.area === "build");
  } finally {
    await dropTempDir(dir);
  }
}

const APP_TSX = `import { glue } from "./core/glue.ts";\n` +
  `export default function App() { glue(); return <div>hi</div>; }\n`;
const GLUE = `export function glue() {\n` +
  `  return fetch(new URL("./xcore_bg.wasm", import.meta.url));\n}\n`;

Deno.test("aiol checkAssetUrls: the JotWord shape is flagged in the client graph, with the mount fix", async () => {
  const issues = await lint({
    "deno.json": JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1" } }),
    "src/app.ts": `import { aio } from "aio";\nawait aio.run({});\n`,
    "src/App.tsx": APP_TSX,
    "src/core/glue.ts": GLUE,
    "src/core/xcore_bg.wasm": "\0asm",
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertEquals(issues[0]!.file, "src/core/glue.ts");
  assertEquals(issues[0]!.line, 2);
  assertStringIncludes(issues[0]!.message, "xcore_bg.wasm");
});

Deno.test("aiol checkAssetUrls: server code is not the browser's; a src/ fetch and an aio.run-only mount are flagged; a mount in both is clean", async () => {
  const issues = await lint({
    "deno.json": JSON.stringify({
      imports: { aio: "jsr:@riagentic/aio@1" },
      assets: { "/media": "./media" },
    }),
    "src/app.ts": `import { aio } from "aio";\n` +
      `await aio.run({ assets: { "/media": "./media", "/extra": "./extra" } });\n`,
    "src/App.tsx": `export default function App() {\n` +
      `  fetch("/src/data/table.json");\n  return <div/>;\n}\n`,
    "src/io.server.ts":
      `export const w = new URL("./x.wasm", import.meta.url);\n`,
    "src/x.wasm": "\0asm",
    "src/data/table.json": "{}",
  });
  const msgs = issues.map((i) => i.message);
  assertEquals(issues.length, 2, msgs.join("\n"));
  assert(msgs.some((m) => m.includes(`fetch("/src/data/table.json")`)));
  assert(msgs.some((m) => m.includes(`"/extra" → "./extra"`)));
  assert(!msgs.some((m) => m.includes(`"/media"`)), "declared in both: fine");
});

Deno.test({
  name:
    "build: the client graph's unmounted wasm URL is a warning (exit 0); one the bundle's URL finds in a mount is silent",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-asset-url-build-");
    try {
      await Deno.mkdir(join(dir, "src/core"), { recursive: true });
      await Deno.mkdir(join(dir, "assets"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(join(dir, "src/core/xcore_bg.wasm"), "\0asm");
      await Deno.writeTextFile(join(dir, "assets/xcore_bg.wasm"), "\0asm");
      await Deno.writeTextFile(join(dir, "src/App.tsx"), APP_TSX);
      const runner = join(dir, "runner.ts");
      await Deno.writeTextFile(
        runner,
        `import { runBundle } from "${spec(REPO)}src/build/build-bundle.ts";
import { loadBuildConfig } from "${spec(REPO)}src/build/build-config.ts";
const cfg = await loadBuildConfig();
await runBundle({ ...cfg, doForce: true, doCompile: true }, JSON.parse(await Deno.readTextFile("deno.json")));
`,
      );
      const build = async (glue: string) => {
        await Deno.writeTextFile(join(dir, "src/core/glue.ts"), glue);
        await Deno.writeTextFile(
          join(dir, "deno.json"),
          JSON.stringify({
            appId: "asset-url-build",
            nodeModulesDir: "manual",
            compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
            imports: {
              "aio": `${spec(REPO)}mod.ts`,
              "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
              "aio/server": `${REPO}src/server.ts`,
              "immer": "npm:immer@10.2.0",
              "@std/path": "jsr:@std/path@^1",
            },
            assets: { "/assets": "./assets" },
          }),
        );
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", runner],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(out.stderr) +
          new TextDecoder().decode(out.stdout);
        assertEquals(out.code, 0, said);
        return said.replace(/\s+/g, " ");
      };
      const flagged = await build(GLUE);
      assertStringIncludes(
        flagged,
        `src/core/glue.ts:2 — new URL("./xcore_bg.wasm", import.meta.url)`,
      );
      const fine = await build(
        `export function glue() {\n  return fetch(new URL("../../assets/xcore_bg.wasm", import.meta.url));\n}\n`,
      );
      assert(!fine.includes("import.meta.url) loads"), fine);
    } finally {
      await dropTempDir(dir);
    }
  },
});
