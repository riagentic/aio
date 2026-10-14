// A standalone APK's worker bundles, as the build stages them.
//
// WebView 133 and later loads no script for a worker that a WORKER starts when
// the page is served by `shouldInterceptRequest` (measured on an API 36
// emulator: `net::ERR_ABORTED` for every URL, the interceptor never asked —
// while the same worker's `fetch`, `import` and `importScripts` are answered).
// So each bundle staged in an APK starts its own workers from a Blob that
// loads the real script. Held here without a phone; the emulator lane
// (`android-emulator-e2e.test.ts`) holds the WebView.
//
// And the build's own sentence for a worker it could NOT bundle is printed by
// an Android build as by every other.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  _apkWorkerPrelude,
  _apkWorkers,
  APK_ASSETS,
} from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const SELF = APK_ASSETS + "worker-a-0a1b2c3d.js";

/** Run the prelude in a worker scope whose `Worker` records what it is given. */
function scope(): {
  Worker: new (u: string | URL, o?: WorkerOptions) => unknown;
  made: { script: unknown; opts: unknown }[];
} {
  const made: { script: unknown; opts: unknown }[] = [];
  const self = {
    Worker: class {
      constructor(script: unknown, opts: unknown) {
        made.push({ script, opts });
      }
    } as unknown as new (u: string | URL, o?: WorkerOptions) => unknown,
    made,
  };
  new Function("self", _apkWorkerPrelude(SELF))(self);
  return self;
}

/** What a Blob URL holds. */
async function blobText(u: unknown): Promise<string> {
  assert(String(u).startsWith("blob:"), `not started from a Blob: ${u}`);
  const text = await (await fetch(String(u))).text();
  URL.revokeObjectURL(String(u));
  return text;
}

Deno.test("APK worker prelude: the asset origin is the one MainActivity serves", () => {
  const kt = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
  const host = /const val ASSET_HOST = "([^"]+)"/.exec(kt)?.[1];
  assertEquals(APK_ASSETS, `https://${host}/assets/`);
  assertStringIncludes(kt, `addPathHandler("/assets/"`);
});

Deno.test("APK worker prelude: a worker a worker starts is a Blob that loads the real script — a module by import, a classic one by importScripts, a plain path against the bundle's own URL", async () => {
  const s = scope();
  const moduleOpts = { type: "module" as const, name: "m" };
  new s.Worker(new URL("./worker-b-99999999.js", SELF), moduleOpts);
  new s.Worker(new URL("./worker-c-11111111.js", SELF));
  new s.Worker("workers/w.js");
  assertEquals(
    await blobText(s.made[0]!.script),
    `import "${APK_ASSETS}worker-b-99999999.js"`,
  );
  // The caller's options reach the real constructor as given.
  assert(s.made[0]!.opts === moduleOpts);
  assertEquals(
    await blobText(s.made[1]!.script),
    `importScripts("${APK_ASSETS}worker-c-11111111.js")`,
  );
  assertEquals(
    await blobText(s.made[2]!.script),
    `importScripts("${APK_ASSETS}workers/w.js")`,
  );
});

Deno.test("APK worker prelude: a blob: or data: script starts as it always did; a scope with no Worker is left alone", () => {
  const s = scope();
  const blob = `blob:${new URL(APK_ASSETS).origin}/0000`;
  const data = "data:text/javascript,postMessage(1)";
  new s.Worker(blob);
  new s.Worker(data, { type: "module" });
  assertEquals(s.made.map((m) => m.script), [blob, data]);
  const none: { Worker?: unknown } = {};
  new Function("self", _apkWorkerPrelude(SELF))(none);
  assertEquals(none.Worker, undefined);
});

Deno.test("APK staging: each worker bundle gets the prelude and its own URL where a classic one reads import.meta.url — code only, never a string that spells it", async () => {
  const dir = await tempDir("aio-apk-workers-");
  try {
    const name = "worker-a-0a1b2c3d.js";
    // What a classic worker's bundle is: `import.meta.url` is
    // `self.location.href` there (client-bundle.ts WORKER_IIFE_DEFINE).
    await Deno.writeTextFile(
      join(dir, name),
      `(()=>{var e=new Worker(new URL("./worker-b-99999999.js",self.location.href));` +
        `e.postMessage("self.location.href")})();`,
    );
    await Deno.writeTextFile(join(dir, "other.js"), "self.location.href;");
    await _apkWorkers(dir, [name]);
    const out = await Deno.readTextFile(join(dir, name));
    assert(out.startsWith(_apkWorkerPrelude(SELF)), out);
    assertStringIncludes(out, `new URL("./worker-b-99999999.js","${SELF}")`);
    assertStringIncludes(out, `postMessage("self.location.href")`);
    // Only the files it was given.
    assertEquals(
      await Deno.readTextFile(join(dir, "other.js")),
      "self.location.href;",
    );
    // No worker, no work (and no esbuild).
    await _apkWorkers(dir, []);
  } finally {
    await dropTempDir(dir);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("android build: a worker that cannot be bundled is said in the build's one sentence — the build green, its literal left as written", async () => {
  const dir = await tempDir("aio-apk-skipped-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "Skipped Probe",
        nodeModulesDir: "auto",
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
        imports: {
          "aio": `${spec(REPO)}mod.ts`,
          "aio/jsx-runtime": `${spec(REPO)}src/jsx-runtime.ts`,
          "immer": "npm:immer@10.2.0",
        },
      }),
    );
    await fixtureNodeModules(dir);
    await Deno.writeTextFile(
      join(dir, "src/w.ts"),
      `import { nope } from "./not-there.ts";\npostMessage(nope);`,
    );
    await Deno.writeTextFile(
      join(dir, "src/App.tsx"),
      `let w: Worker | undefined;
export default function App() {
  w ??= new Worker(new URL("./w.ts", import.meta.url), { type: "module" });
  return <b onClick={() => w!.postMessage(1)}>x</b>;
}`,
    );
    const runner = join(dir, ".aio-build", "runner.ts");
    await Deno.mkdir(join(dir, ".aio-build"));
    await Deno.writeTextFile(
      runner,
      `import { runBundle } from "${spec(REPO)}src/build/build-bundle.ts";
import { resolveAppDir } from "${spec(REPO)}src/build/build-config.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
await runBundle({
  root, dist: root + "/dist", out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(join(REPO, "src"))},
  isRemote: false, doAndroid: true, standalone: true, doForce: true,
  configEntry: "src/app.ts", appDir: resolveAppDir(root, "src/app.ts"), uiEntry: "App.tsx",
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: childCoverageDir() },
      args: ["run", "-A", runner],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const said = (new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr)).replace(/\s+/g, " ");
    assertEquals(r.code, 0, said);
    assertEquals(
      said.split("the worker src/w.ts cannot be bundled").length - 1,
      1,
      `the sentence, once:\n${said}`,
    );
    assertStringIncludes(said, "does not run in the built app");
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "dist", "app.js")),
      `new URL("./w.ts"`,
    );
    assertEquals(
      [...Deno.readDirSync(join(dir, "dist"))].filter((e) =>
        e.name.startsWith("worker-")
      ),
      [],
    );
  } finally {
    await dropTempDir(dir);
  }
});
