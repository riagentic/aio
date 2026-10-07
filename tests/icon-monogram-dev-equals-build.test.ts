// The generated monogram draws the SAME letter in dev as in the build.
//
// The build labels it `--display-name`, else deno.json `title`, else the
// appId; the dev `/__aio/icon` route drew the appId's own initial. So
// `appId: "notes-app"` with `title: "My Notes"` was an "N" in the dev tab and
// an "M" in every built target. The shipped artifact is what users see —
// dev now follows it (appIconLabel).
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { appIconSvg } from "../src/build/app-icon.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test({
  name: "monogram: dev and build draw the same icon for notes-app / My Notes",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const dir = await tempDir("aio-monogram-");
    let app: { close(): Promise<void> } | undefined;
    try {
      await Deno.mkdir(join(dir, "src"));
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          appId: "notes-app",
          title: "My Notes",
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

      // The build: the real config decider + bundle step (icon staging).
      const runner = join(dir, "runner.ts");
      await Deno.writeTextFile(
        runner,
        `import { runBundle } from "${spec(ROOT)}src/build/build-bundle.ts";
import { loadBuildConfig } from "${spec(ROOT)}src/build/build-config.ts";
const cfg = await loadBuildConfig();
await runBundle(cfg, JSON.parse(await Deno.readTextFile("deno.json")));
`,
      );
      const out = await new Deno.Command(Deno.execPath(), {
        env: { DENO_COVERAGE_DIR: childCoverageDir() },
        args: ["run", "-A", runner],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      const built = await Deno.readTextFile(join(dir, "dist", "icon.svg"));

      // Dev: the same app, served.
      const c = cell("notesmono", { state: { n: 0 }, methods: {} });
      const port = freePort();
      app = await aio.run({
        cells: [c],
        appId: "notes-app",
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port,
        baseDir: join(dir, "src"),
        // deno-lint-ignore no-explicit-any
      } as any);
      const dev = await (await fetch(`http://127.0.0.1:${port}/__aio/icon`))
        .text();

      assertEquals(dev, built, "dev and build draw different monograms");
      assertEquals(built, appIconSvg("My Notes", 512, "notes-app"));
      assert(
        built !== appIconSvg("notes-app", 512, "notes-app"),
        "not the appId's letter",
      );
    } finally {
      await app?.close();
      await dropTempDir(dir);
    }
  },
});
