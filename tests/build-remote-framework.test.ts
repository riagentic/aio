// The build path a JSR-installed app takes — the one the local suite never runs.
//
// Every other build test consumes the framework as LOCAL FILES (a `dep/aio`
// symlink), so `BuildConfig.isRemote` is false and esbuild resolves `aio*`
// through a file: import map. An app scaffolded with `am create --jsr` (and
// every deno.json in docs/examples) pins `jsr:@riagentic/aio@…` instead: the
// build module itself runs from the registry, `isRemote` is true, and the
// framework is fetched over HTTP by `makeHttpPlugin`.
//
// That path was untested and BROKEN END TO END. esbuild cannot resolve `jsr:`
// or `npm:` specifiers, so build-bundle drops every one of them from its alias
// — which is ALL of a JSR app's `aio*` mappings. The http plugin put back
// exactly one specifier (`aio`), while the build's own generated entry imports
// `aio/air` AND `aio/renderer`; and files the plugin loaded carried no
// resolveDir, so the framework's own `import { produce } from "immer"` could
// not be resolved either. `deno task compile` died with
// `Could not resolve "aio/renderer"` before writing a byte, and nothing an app
// author could change would fix it.
//
// The fixture serves THIS repo over loopback HTTP as the "registry" — the same
// fetch+integrity code path, no network, no publish needed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { VERSION } from "../src/server/aio-cli.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Serve the repo read-only over loopback — stands in for the JSR registry. */
function serveFramework(): { base: string; stop: () => Promise<void> } {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname);
      if (p.includes("..")) return new Response("no", { status: 400 });
      try {
        return new Response(await Deno.readFile(join(REPO, p)), {
          headers: { "content-type": "application/typescript" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  );
  return {
    base: `http://127.0.0.1:${port}/`,
    stop: () => server.shutdown(),
  };
}

/** A JSR-SHAPED app: every `aio*` specifier is a `jsr:` pin, so esbuild's alias
 *  is left with nothing — exactly what `am create --jsr` writes. */
async function makeJsrApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-jsr-build-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "jsrapp",
      version: "0.1.0",
      compilerOptions: {
        lib: ["deno.ns", "dom"],
        jsx: "react-jsx",
        jsxImportSource: "aio",
      },
      imports: {
        "aio": "jsr:@riagentic/aio@1.0.0",
        "aio/air": "jsr:@riagentic/aio@1.0.0/air",
        "aio/jsx-runtime": "jsr:@riagentic/aio@1.0.0/jsx-runtime",
        "aio/ui": "jsr:@riagentic/aio@1.0.0/ui",
      },
    }),
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src", "cell.ts"),
    `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { inc(s: { count: number }) { s.count++; } },
});
`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    `import { counter } from "./cell.ts";
export default function App() {
  return <div onClick={() => counter.inc()}>JSR_APP_MARKER {counter.count}</div>;
}
`,
  );
  // deno materializes a JSR package's transitive npm deps as top-level
  // node_modules links (verified against the published package), which is what
  // the plugin's resolveDir points esbuild at.
  await Deno.mkdir(join(dir, "node_modules"));
  await Deno.symlink(
    join(REPO, "node_modules", "immer"),
    join(dir, "node_modules", "immer"),
  );
  return dir;
}

/** Drive `runBundle` with a REMOTE framework, in a subprocess — the real build
 *  calls `Deno.exit(1)` when the bundle fails, which would take the test with
 *  it (and hide the very failure being asserted). */
const DRIVER = `
import { runBundle } from "${REPO}/src/build/build-bundle.ts";
import type { BuildConfig } from "${REPO}/src/build/build-config.ts";
import { join } from "@std/path";

const [root, base] = Deno.args as [string, string];
const cfg: BuildConfig = {
  root,
  dist: join(root, "dist"),
  out: join(root, "dist", "app.js"),
  frameworkSrcDir: "",            // isRemote ⇒ the framework has no local files
  doElectron: false, doAndroid: false, doClient: false, doCli: false,
  doRemote: false, doCompile: false, doForce: true, doRelease: false,
  doService: false, doHeadless: false,
  androidDevUrl: undefined,
  binaryName: "jsrapp", appTitle: "jsrapp",
  configEntry: "src/app.ts", appDir: join(root, "src"),
  entryOverride: undefined, rendererMode: "aio",
  os: Deno.build.os, arch: "x86_64", archStr: "x64",
  platform: "linux", targetTriple: undefined, exeExt: "",
  isRemote: true,
  frameworkBase: new URL("src/", base),
};
Deno.chdir(root);
await runBundle(cfg, JSON.parse(await Deno.readTextFile(join(root, "deno.json"))));
console.log("BUNDLE_OK");
`;

Deno.test("build (JSR framework): the remote path bundles a real browser app", async () => {
  const fw = serveFramework();
  const dir = await makeJsrApp();
  const driver = join(dir, "driver.ts");
  await Deno.writeTextFile(driver, DRIVER);
  try {
    const p = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        driver,
        dir,
        fw.base,
      ],
      // The integrity ledger (.aio-integrity.json) is written to the cwd the
      // build module LOADS in — run in the fixture so it lands there.
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(p.stdout) +
      new TextDecoder().decode(p.stderr);

    // Every `aio*` the BUILD ITSELF emits must resolve. These are not the app's
    // to declare: `aio/renderer` is not even a published export.
    for (const spec of ["aio", "aio/air", "aio/renderer", "aio/jsx-runtime"]) {
      assert(
        !out.includes(`Could not resolve "${spec}"`),
        `the remote build cannot resolve ${spec}:\n${out}`,
      );
    }
    // …and so must the framework's own npm deps, which live on the filesystem.
    assert(
      !out.includes(`Could not resolve "immer"`),
      `plugin-loaded framework files got no resolveDir:\n${out}`,
    );
    assertEquals(p.code, 0, `remote bundle failed:\n${out}`);
    assertStringIncludes(out, "BUNDLE_OK");

    // The artifact is a REAL browser bundle of THIS app, not an empty success.
    const js = await Deno.readTextFile(join(dir, "dist", "app.js"));
    assertStringIncludes(js, "JSR_APP_MARKER", "the app's own UI is missing");
    assertStringIncludes(
      js,
      `globalThis.__aioVersion = ${JSON.stringify(VERSION)}`,
    );
    assertStringIncludes(js, `globalThis.__aioBundleTarget = "browser"`);
    assertStringIncludes(
      js,
      "mount2 as mount",
      "the ESM shell must export mount()",
    );
    // The browser substitution has to hold over HTTP too: `aio` resolves to the
    // browser entry, never to mod.ts, so no server module reaches the bundle.
    assertEquals(
      js.split("\n").filter((l) => /^\/\/ .*\/src\/server\//.test(l)),
      [],
      "server modules leaked into the browser bundle",
    );
  } finally {
    await fw.stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
