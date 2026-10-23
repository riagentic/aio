// An app that declares `appId` and no `title` is built by the fleet with
// `--name=<its folder>` — the binary is named after the folder, but it RUNS as
// the appId (its embedded deno.json), so its runtime theme and dev window icon
// hash the appId. The packaged icon hashed the folder name: one app, two
// colours (and two letters). Every generated icon now keys on the declared
// appId; the file name is unchanged.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { appIconLabel, appIconSvg } from "../src/build/app-icon.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("build icon: a declared appId keys the monogram, not the folder-named binary", async () => {
  const dir = await tempDir("aio-appid-icon-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        appId: "notes-pro",
        nodeModulesDir: "manual",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
        imports: {
          "aio": `${spec(ROOT)}mod.ts`,
          "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
          "aio/server": `${ROOT}src/server.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@^1",
        },
      }),
    );
    await fixtureNodeModules(dir);
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `export default function App() { return <p>hi</p>; }`,
    );
    const runner = join(dir, "runner.ts");
    await Deno.writeTextFile(
      runner,
      `import { runBundle } from "${spec(ROOT)}src/build/build-bundle.ts";
import { loadBuildConfig } from "${spec(ROOT)}src/build/build-config.ts";
const cfg = await loadBuildConfig();
if (cfg.binaryName !== "foldy") throw new Error("binary renamed: " + cfg.binaryName);
await runBundle(cfg, JSON.parse(await Deno.readTextFile("deno.json")));
`,
    );
    // Exactly the argv build-all passes for a title-less project in `foldy/`.
    const out = await new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: childCoverageDir() },
      args: ["run", "-A", runner, "--name=foldy"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    const built = await Deno.readTextFile(join(dir, "dist", "icon.svg"));
    // What the dev window / `/__aio/icon` draws for this app.
    const dev = appIconSvg(
      appIconLabel(undefined, "notes-pro"),
      512,
      "notes-pro",
    );
    assertEquals(built, dev, "the packaged icon is not the app's colour");
    assert(built !== appIconSvg("foldy", 512, "foldy"));
  } finally {
    await dropTempDir(dir);
  }
});
