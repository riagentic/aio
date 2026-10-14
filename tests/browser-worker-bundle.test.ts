// A browser `Worker` named by a URL literal is BUNDLED — in a build beside
// `app.js`, in dev on request — and carried by every target.
//
// `new Worker(new URL("./w.ts", import.meta.url))` ran in dev and failed in
// every build (the Worker's `error` event, no message), and with a bare
// import in the worker it failed in dev too. The pieces, each held here
// without a browser (`browser-worker-mount-chromium.test.ts` and
// `build-e2e-worker.test.ts` hold the page):
//   the decider    which constructor calls aio follows, and which it warns of
//   the build      one file per worker and format; a worker's own workers
//   the judgement  a worker that cannot be bundled — or reaches a
//                  server-only module — is left as written, and said: the
//                  build stays green, as it was when no worker was bundled
//   the same bytes an app that starts no worker bundles exactly as before
//   the staging    dist/ clean, prod server (also for an anonymous caller),
//                  the dev server, the web folder, the APK's assets
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import * as esbuild from "esbuild";
import {
  bundleClient,
  type EsbuildModule,
  judgeClientBundle,
  skippedWorkerMessage,
} from "../src/build/client-bundle.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import {
  copyWorkerBundles,
  keepInDistStaging,
} from "../src/build/dist-staging.ts";
import { _writeLocalAssets } from "../src/build/build-android.ts";
import { buildWeb, webArtifactName } from "../src/build/build-web.ts";
import { isBundleFresh, versionStamp } from "../src/build/build-bundle.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import {
  isWorkerBundle,
  workerBundleName,
  workerBundlesIn,
} from "../src/server/app-files.ts";
import {
  BLOCKING_CATEGORIES,
  createProdGraphCheck,
  devWorkerProbe,
  rewriteWorkers,
  unmanagedWorkers,
  workerEntries,
} from "../src/server/graph-validator.ts";
import {
  _isBuiltShellPath,
  createStaticHandler,
  isShellAsset,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { _servedAssets } from "../src/server/server.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const there = () => true;
/** An absolute path as this OS spells it. */
const abs = (p: string) => resolve(p);
const MODULE =
  `new Worker(new URL("./w.ts", import.meta.url), { type: "module" })`;

Deno.test("workerEntries: a URL literal relative to the module, naming a file that exists, is followed", () => {
  const one = (code: string, file = abs("/app/src/App.tsx")) =>
    workerEntries(code, file, there).map((e) => [e.spec, e.abs, e.format]);
  assertEquals(one(MODULE), [["./w.ts", abs("/app/src/w.ts"), "esm"]]);
  // Classic unless the call says module; any quote; any spacing.
  assertEquals(one(`new Worker(new URL('../lib/w.tsx', import.meta.url))`), [
    ["../lib/w.tsx", abs("/app/lib/w.tsx"), "iife"],
  ]);
  assertEquals(
    one(
      "new  Worker (\n  new URL(`./w.ts`, import.meta.url),\n  { name: 'x', type: 'module' },\n)",
    ),
    [["./w.ts", abs("/app/src/w.ts"), "esm"]],
  );
  assertEquals(one(`new Worker(new URL("./w.ts", import.meta.url), opts)`), [
    ["./w.ts", abs("/app/src/w.ts"), "iife"],
  ]);
  assertEquals(
    one(`new SharedWorker(new URL("./s.ts", import.meta.url))`),
    [["./s.ts", abs("/app/src/s.ts"), "iife"]],
  );
  // Not this spelling: a plain path, a computed URL, another base, a URL
  // that is not relative, a remote one — and a `.js`, which is a file the
  // app serves as it is (the same request in dev and in every build).
  for (
    const code of [
      `new Worker(new URL("./w.js", import.meta.url))`,
      `new Worker(new URL("./w.mjs", import.meta.url), { type: "module" })`,
      `new Worker("workers/w.js")`,
      `new Worker("./w.ts")`,
      `new Worker(new URL(name, import.meta.url))`,
      "new Worker(new URL(`./${name}.ts`, import.meta.url))",
      `new Worker(new URL("./w.ts", location.href))`,
      `new Worker(new URL("/w.ts", import.meta.url))`,
      `new Worker(new URL("https://cdn.example.com/w.js", import.meta.url))`,
      `new Worker(url)`,
    ]
  ) assertEquals(one(code), [], code);
  // Text that merely shows the call is not a call.
  assertEquals(
    one(`// ${MODULE}\nconst doc = '${MODULE}';\n/* ${MODULE} */`),
    [],
  );
  // A file that is not there is not an entry (and is warned about, below).
  assertEquals(workerEntries(MODULE, abs("/app/src/App.tsx"), () => false), []);
});

Deno.test("rewriteWorkers: only the specifier changes, and a module that starts no worker is the same string", () => {
  const code = `const a = ${MODULE};\nconst b = "./w.ts";\n`;
  const dir = Deno.makeTempDirSync({ prefix: "aio-worker-rw-" });
  try {
    Deno.writeTextFileSync(join(dir, "w.ts"), "");
    assertEquals(
      rewriteWorkers(code, join(dir, "App.tsx"), (e) => `./built-${e.format}`),
      code.replace(`new URL("./w.ts"`, `new URL("./built-esm"`),
    );
    const plain = `export const x = "Worker";`;
    assert(rewriteWorkers(plain, join(dir, "App.tsx"), () => "x") === plain);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("unmanagedWorkers: a followed worker is not reported; what no build can follow is, with the way out", () => {
  const found = (code: string, exists = there) =>
    unmanagedWorkers(code, abs("/app/src/App.tsx"), exists);
  assertEquals(found(MODULE), []);
  assertEquals(
    found(`new SharedWorker(new URL("./s.ts", import.meta.url))`),
    [],
  );
  // A `.js` by URL is the app's own file, never rewritten — and said.
  assertStringIncludes(
    found(`new Worker(new URL("./s.js", import.meta.url))`)[0]!.message,
    "does not follow",
  );

  const missing = found(`\n\n${MODULE}`, () => false);
  assertEquals(missing.length, 1);
  assertEquals(missing[0]!.line, 3);
  assertStringIncludes(
    missing[0]!.message,
    `${abs("/app/src/w.ts")} does not exist`,
  );

  const computed = found(`new Worker(new URL(name, import.meta.url))`);
  assertEquals(computed.length, 1);
  assertStringIncludes(computed[0]!.message, "computed URL");
  // The fix names both ways out: the literal, and the mount.
  assertStringIncludes(computed[0]!.fix, `new URL("./worker.ts"`);
  assertStringIncludes(computed[0]!.fix, `"assets"`);

  const plain = found(`new Worker("/w.mts")`);
  assertEquals(plain.length, 1);
  assertStringIncludes(plain[0]!.message, "dev only");
  assertStringIncludes(plain[0]!.fix, `new Worker("workers/w.js")`);

  assertStringIncludes(
    found(`new Worker(new URL("./w.js", location.href))`)[0]!.message,
    "does not follow",
  );
});

Deno.test("worker bundle names: one spelling, recognised by every staging site, and nothing else is", () => {
  const name = workerBundleName("transcribe.worker", "0a1b2c3d");
  assertEquals(name, "worker-transcribe-worker-0a1b2c3d.js");
  assert(isWorkerBundle(name));
  assert(keepInDistStaging(name), "the dist/ clean would delete it");
  for (
    const not of [
      "worker.js",
      "worker-x.js",
      "worker-x-0a1b2c3.js",
      "worker-x-0a1b2c3d.js.map",
      "sub/worker-x-0a1b2c3d.js",
      "app.js",
    ]
  ) assert(!isWorkerBundle(not), not);
});

/** An app whose page starts a module worker and a classic one; the classic
 *  one starts the module worker again, and both import through an alias. */
async function workerApp(extra: Record<string, string> = {}): Promise<string> {
  const root = await tempDir("aio-worker-bundle-");
  const files: Record<string, string> = {
    "src/App.tsx": `const doc = '${MODULE}';
export default function App() {
  new Worker(new URL("./w.ts", import.meta.url), { type: "module" });
  new Worker(new URL("./sub/classic.ts", import.meta.url));
  return doc;
}`,
    "src/dep.ts": `export const tag = "DEP_INLINED";`,
    "src/w.ts": `import { tag } from "lib";
self.onmessage = () => postMessage(tag);`,
    "src/sub/classic.ts": `import { tag } from "../dep.ts";
const inner = new Worker(new URL("../w.ts", import.meta.url), { type: "module" });
inner.onmessage = () => postMessage(tag + import.meta.url);`,
    ...extra,
  };
  for (const [f, body] of Object.entries(files)) {
    await Deno.mkdir(join(root, f, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, f), body);
  }
  // The framework's own npm dep, where the build looks for it.
  await fixtureNodeModules(root, "npm:immer@10.2.0");
  return root;
}

const bundle = (
  root: string,
  standalone = false,
  esb: EsbuildModule = esbuild,
) =>
  bundleClient({
    esbuild: esb,
    root,
    appDir: join(root, "src"),
    uiEntry: "App.tsx",
    standalone,
    imports: { lib: join(root, "src/dep.ts") },
    shares: [],
    frameworkSrcDir: join(REPO, "src"),
  });

Deno.test("build: each worker is one bundle beside app.js — its imports inlined, its own workers followed, the page's URLs pointing at them", async () => {
  const root = await workerApp();
  try {
    for (const standalone of [false, true]) {
      const b = await bundle(root, standalone);
      assert(b.ok, b.errors.join("\n"));
      const names = b.workers.map((w) => w.name).sort();
      assertEquals(names.map((n) => n.slice(0, -11)), [
        "worker-classic-",
        "worker-w-",
      ]);
      assert(names.every(isWorkerBundle), names.join(" "));
      const [classic, w] = [
        b.workers.find((x) => x.name.startsWith("worker-classic-"))!,
        b.workers.find((x) => x.name.startsWith("worker-w-"))!,
      ];
      // The page names the built files, relative to itself; the text that
      // only SHOWS the call is untouched.
      assertStringIncludes(b.code, `new URL("./${w.name}",`);
      assertStringIncludes(b.code, `new URL("./${classic.name}",`);
      assertStringIncludes(b.code, `new URL("./w.ts", import.meta.url)`);
      // What a smoke asks an artifact for: the page's workers, and theirs.
      assertEquals(workerBundlesIn(b.code).sort(), names);
      assertEquals(workerBundlesIn(classic.code), [w.name]);
      assertEquals(workerBundlesIn(w.code), []);
      // A module worker: the alias import is in it.
      assertStringIncludes(w.code, "DEP_INLINED");
      assert(!/\bimport\b/.test(w.code), w.code);
      assertEquals(w.entryKey, "src/w.ts");
      assert("src/dep.ts" in w.inputs, Object.keys(w.inputs).join(" "));
      // A classic worker: no import, no import.meta, and the worker IT
      // starts is the same built file.
      assertStringIncludes(classic.code, "DEP_INLINED");
      assert(!classic.code.includes("import.meta"), classic.code);
      assertStringIncludes(
        classic.code,
        `new URL("./${w.name}",self.location.href)`,
      );
    }
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

/** The same esbuild, minus the worker plugin: what every build before
 *  workers were bundled emitted. */
const withoutWorkers: EsbuildModule = {
  build: (o) =>
    esbuild.build({
      ...o,
      plugins: o.plugins.filter((p: { name: string }) =>
        p.name !== "aio-worker"
      ),
    }),
};

Deno.test("build: a classic worker that awaits at its top level is told why it was built classic — the options aio could not read; a module worker's reason carries no such hint", async () => {
  const root = await workerApp({
    // Started with no `{ type: "module" }` aio can read (`workerApp`).
    "src/sub/classic.ts": `postMessage(await Promise.resolve(1));`,
    "src/w.ts": `import "./not-there.ts";`,
  });
  try {
    const b = await bundle(root);
    assert(b.ok, b.errors.join("\n"));
    const reason = (key: string) =>
      b.workersSkipped.find((w) => w.entryKey === key)!.reason;
    const classic = reason("src/sub/classic.ts");
    assertStringIncludes(classic, `"iife" output format`); // esbuild's own
    assertStringIncludes(classic, "aio builds this worker as a classic script");
    assertStringIncludes(classic, `{ type: "module" }`);
    assertStringIncludes(classic, "a variable, a spread");
    assert(!reason("src/w.ts").includes("classic script"), reason("src/w.ts"));
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("build: a worker that cannot be bundled does not fail the build — its literal is left as written, no file is emitted, and the reason is said", async () => {
  const root = await workerApp({
    "src/w.ts": `import { nope } from "./not-there.ts";\npostMessage(nope);`,
  });
  try {
    for (const standalone of [false, true]) {
      const b = await bundle(root, standalone);
      assert(b.ok, b.errors.join("\n"));
      // The good worker is bundled; the bad one is not, anywhere.
      assertEquals(b.workers.map((w) => w.entryKey), ["src/sub/classic.ts"]);
      const classic = b.workers[0]!;
      assertStringIncludes(b.code, `new URL("./${classic.name}",`);
      assert(!b.code.includes("worker-w-"), "the bad worker was rewritten");
      // …nor in the worker that starts it too.
      assertStringIncludes(
        classic.code,
        `new URL("../w.ts",self.location.href)`,
      );
      assertEquals(b.workersSkipped.length, 1);
      const [skipped] = b.workersSkipped;
      assertEquals(skipped!.entryKey, "src/w.ts");
      assertStringIncludes(skipped!.reason, "not-there.ts");
      assertStringIncludes(skipped!.reason, "src/w.ts:1");
      const said = skippedWorkerMessage(skipped!);
      assertStringIncludes(said, "the worker src/w.ts cannot be bundled");
      assertStringIncludes(said, "does not run in the built app");
      // What the verdict was read from: the file, and the one it lacked.
      assert(skipped!.watch.includes(join(root, "src/w.ts")));
      assert(skipped!.watch.includes(join(root, "src/not-there.ts")));
    }
    // With no worker it can bundle, the page's bundle is the bytes a build
    // without the worker plugin emits.
    await Deno.writeTextFile(
      join(root, "src/sub/classic.ts"),
      `import "./nor-this.ts";`,
    );
    for (const standalone of [false, true]) {
      const now = await bundle(root, standalone);
      const before = await bundle(root, standalone, withoutWorkers);
      assert(now.ok && before.ok, [...now.errors, ...before.errors].join("\n"));
      assertEquals(now.workers, []);
      assertEquals(now.workersSkipped.length, 2);
      assert(now.code === before.code, `the ${now.format} bundle changed`);
    }
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("build: a package only a worker imports is installed from the WORKER, not from the UI entry that never reaches it", async () => {
  const root = await workerApp({
    "src/w.ts": `import { zip } from "fflate";\npostMessage(zip);`,
  });
  try {
    const b = await bundle(root);
    assert(b.ok, b.errors.join("\n"));
    assertStringIncludes(
      b.workersSkipped[0]!.reason,
      "deno install --entrypoint src/w.ts",
    );
    // Installed, the verdict is read again: where it would be is watched.
    assert(
      b.workersSkipped[0]!.watch.includes(join(root, "node_modules/fflate")),
      b.workersSkipped[0]!.watch.join(" "),
    );
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("build: a worker that reaches a server-only module is not shipped — left as written and said, the build green", async () => {
  const root = await workerApp({
    "src/secret.server.ts": `export const key = "SECRET_KEY";`,
    "src/w.ts": `import { key } from "./secret.server.ts";\npostMessage(key);`,
  });
  try {
    const b = await bundle(root);
    assert(b.ok, b.errors.join("\n"));
    assert((await judgeClientBundle(b, root)).ok);
    assertEquals(b.workers.map((w) => w.entryKey), ["src/sub/classic.ts"]);
    for (const code of [b.code, ...b.workers.map((w) => w.code)]) {
      assert(!code.includes("SECRET_KEY"), "a server-only module shipped");
      assert(!code.includes("worker-w-"), "the worker was rewritten");
    }
    assertEquals(b.workersSkipped.map((w) => w.entryKey), ["src/w.ts"]);
    assertStringIncludes(b.workersSkipped[0]!.reason, "secret.server.ts");
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("build: a `.js` named by URL literal is the app's own file — the bundle is byte for byte what a build without the worker plugin emits", async () => {
  const root = await workerApp({
    "src/App.tsx": `export default function App() {
  new Worker(new URL("./pre.js", import.meta.url));
  new Worker(new URL("./pre.mjs", import.meta.url), { type: "module" });
  return "x";
}`,
    "src/pre.js": `var G = 1; importScripts("./lib.js");`,
    "src/pre.mjs": `import "./dep.js";`,
  });
  try {
    for (const standalone of [false, true]) {
      const now = await bundle(root, standalone);
      const before = await bundle(root, standalone, withoutWorkers);
      assert(now.ok && before.ok, [...now.errors, ...before.errors].join("\n"));
      assertEquals(now.workers, []);
      assertEquals(now.workersSkipped, []);
      assertStringIncludes(now.code, `new URL("./pre.js",`);
      assert(now.code === before.code, `the ${now.format} bundle changed`);
    }
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("build: an app that starts no worker is bundled byte for byte as without the worker plugin", async () => {
  const root = join(REPO, "examples/counter");
  const imports = JSON.parse(
    await Deno.readTextFile(join(root, "deno.json")),
  ).imports as Record<string, string>;
  const without = withoutWorkers;
  let dropped = 0;
  const counting: EsbuildModule = {
    build: (o) => {
      dropped +=
        o.plugins.filter((p: { name: string }) => p.name === "aio-worker")
          .length;
      return esbuild.build(o);
    },
  };
  try {
    for (const standalone of [false, true]) {
      const opts = {
        root,
        appDir: join(root, "src"),
        uiEntry: "App.tsx",
        standalone,
        imports,
        shares: [],
        frameworkSrcDir: join(REPO, "src"),
      };
      const now = await bundleClient({ ...opts, esbuild: counting });
      const before = await bundleClient({ ...opts, esbuild: without });
      assert(now.ok && before.ok, [...now.errors, ...before.errors].join("\n"));
      assertEquals(now.workers, []);
      assertEquals(now.workersSkipped, []);
      assert(now.code.length > 10_000);
      assert(now.code === before.code, `the ${now.format} bundle changed`);
    }
    assertEquals(dropped, 2, "the comparison removed no plugin");
  } finally {
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("staleness: a worker's bundle missing from dist/ makes the bundle not fresh", async () => {
  const root = await tempDir("aio-worker-fresh-");
  try {
    const dist = join(root, "dist");
    const out = join(dist, "app.js");
    await Deno.mkdir(join(root, ".aio"));
    await Deno.mkdir(dist);
    const input = join(root, "App.tsx");
    await Deno.writeTextFile(input, "");
    await Deno.utime(input, 1, 1); // older than the bundle
    await Deno.writeTextFile(
      out,
      versionStamp((await import("../src/server/aio-cli.ts")).VERSION) +
        `globalThis.__aioBundleTarget = "browser";\n`,
    );
    const worker = "worker-w-0a1b2c3d.js";
    await Deno.writeTextFile(join(dist, worker), "");
    await Deno.writeTextFile(
      join(root, ".aio/bundle-inputs.json"),
      JSON.stringify({
        v: 2,
        out,
        app: root,
        inputs: [input],
        workers: [worker],
      }),
    );
    const cfg = { out, root, appDir: root, doForce: false } as BuildConfig;
    assertEquals(await isBundleFresh(cfg), true);
    await Deno.remove(join(dist, worker));
    assertEquals(await isBundleFresh(cfg), false);
    // What a worker that could not be bundled lacked, now there: not fresh.
    await Deno.writeTextFile(join(dist, worker), "");
    const lacked = join(root, "not-there.ts");
    await Deno.writeTextFile(
      join(root, ".aio/bundle-inputs.json"),
      JSON.stringify({
        v: 2,
        out,
        app: root,
        inputs: [input],
        workers: [worker],
        absent: [lacked],
      }),
    );
    assertEquals(await isBundleFresh(cfg), true);
    await Deno.writeTextFile(lacked, "");
    assertEquals(await isBundleFresh(cfg), false);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("dev: a worker that cannot be bundled is a warning in the build's words, never the diagnostic page — kept while its files are as they were, judged again when one changes or the missing one appears", async () => {
  const root = await workerApp({
    "src/w.ts": `import { nope } from "./not-there.ts";\npostMessage(nope);`,
  });
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ imports: { lib: "./src/dep.ts" } }),
    );
    const check = createProdGraphCheck({
      absBaseDir: join(root, "src"),
      uiEntry: "App.tsx",
    });
    // The same page graph every time: only the worker changes.
    const broken = await check("h");
    assertEquals(broken.errors.length, 1);
    assertEquals(broken.errors[0]!.category, "unmanaged-worker");
    assert(!BLOCKING_CATEGORIES.has(broken.errors[0]!.category));
    assertEquals(broken.errors[0]!.file, join(root, "src/w.ts"));
    // The build's sentence, word for word.
    const built = await bundle(root);
    assertEquals(
      broken.errors[0]!.message,
      skippedWorkerMessage(built.workersSkipped[0]!),
    );
    // Still broken, nothing touched: not bundled again.
    assertEquals((await check("h")).cached, true, "a broken worker re-ran");
    // Fixed by CREATING the file it lacked — no file it read changed.
    await Deno.writeTextFile(
      join(root, "src/not-there.ts"),
      `export const nope = 1;`,
    );
    const fixed = await check("h");
    assertEquals(fixed.cached, false, "the fixed worker was not judged again");
    assertEquals(fixed.errors, []);
    assertEquals((await check("h")).cached, true, "unchanged: nothing rebuilt");
    // …and what a worker IMPORTS is one of its sources.
    await Deno.writeTextFile(
      join(root, "src/not-there.ts"),
      `import "./gone.ts";\nexport const nope = 2;`,
    );
    const again = await check("h");
    assertEquals(again.cached, false);
    assertStringIncludes(again.errors[0]!.message, "gone.ts");
  } finally {
    await stopEsbuild();
    await stopEsbuildService(() => esbuild.stop());
    await dropTempDir(root);
  }
});

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

Deno.test("prod server: a worker's bundle is served from dist/ beside app.js — to an anonymous caller of an auth app too", async () => {
  const root = await tempDir("aio-worker-prod-");
  try {
    const name = "worker-w-0a1b2c3d.js";
    await Deno.mkdir(join(root, "dist"));
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(join(root, "dist", name), "postMessage(1)");
    // The app's OWN file of such a name is still the app's.
    await Deno.writeTextFile(join(root, "src/worker-own-11111111.js"), "own()");
    const { serveStatic } = createStaticHandler(deps({
      prod: true,
      absBaseDir: join(root, "src"),
      absDistDir: join(root, "dist"),
      noCache: { "Cache-Control": "no-cache" },
    }));
    const r = await serveStatic(`/${name}`);
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("content-type"), "application/javascript");
    assertEquals(await r.text(), "postMessage(1)");
    // The name is of the script's PATH, not its bytes: a rebuilt worker is
    // the same URL, so it is revalidated like app.js — never a stale copy.
    assertEquals(r.headers.get("cache-control"), "no-cache");
    const app = join(root, "dist/app.js");
    await Deno.writeTextFile(app, "");
    assertEquals(
      (await serveStatic("/app.js")).headers.get("cache-control"),
      "no-cache",
    );
    const etag = r.headers.get("etag");
    assert(etag);
    await Deno.writeTextFile(join(root, "dist", name), "postMessage(22)");
    await Deno.utime(join(root, "dist", name), 1, 1);
    const r2 = await serveStatic(`/${name}`);
    assertEquals(await r2.text(), "postMessage(22)");
    assert(r2.headers.get("etag") !== etag, "new bytes, the old ETag");
    await Deno.writeTextFile(join(root, "dist", name), "postMessage(1)");
    assertEquals(
      await (await serveStatic("/worker-own-11111111.js")).text(),
      "own()",
    );
    const write = await serveStatic(
      `/${name}`,
      new Request(`http://x/${name}`, { method: "DELETE" }),
    );
    assertEquals(write.status, 405);
    await write.body?.cancel();
    // The sign-in page's worker loads with no session, with or without a
    // declared public directory; nothing else named like code does.
    for (const dev of [false, true]) {
      assert(_isBuiltShellPath(`/${name}`, dev));
      assert(isShellAsset(`/${name}`, dev, "public"));
      assert(isShellAsset(`/${name}`, dev));
    }
    assert(!isShellAsset("/sub/" + name, false, "public"));
    assert(!isShellAsset("/other.js", false, "public"));
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("dev server: the module that starts a worker asks for it bundled, and gets its bare import inlined", async () => {
  const root = await workerApp();
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ imports: { lib: "./src/dep.ts" } }),
    );
    const served: string[] = [];
    const { serveStatic } = createStaticHandler(deps({
      absBaseDir: join(root, "src"),
      onModuleServed: (f) => served.push(f),
    }));
    const page = await (await serveStatic("/App.tsx")).text();
    assertStringIncludes(
      page,
      `new URL("/w.ts?aio-worker=esm", import.meta.url)`,
    );
    assertStringIncludes(
      page,
      `new URL("/sub/classic.ts?aio-worker=iife", import.meta.url)`,
    );
    // Asked for as a module, the file is a module as before.
    const plain = await (await serveStatic("/w.ts")).text();
    assertStringIncludes(plain, `from "lib"`);

    const get = (path: string) =>
      serveStatic(path.split("?")[0]!, new Request(`http://x${path}`));
    served.length = 0;
    const w = await get("/w.ts?aio-worker=esm");
    assertEquals(w.headers.get("content-type"), "application/javascript");
    const code = await w.text();
    assertStringIncludes(code, "DEP_INLINED");
    assert(!/\bimport\b/.test(code), code);
    // Its sources are watched: an edit to what it imports reloads.
    assert(served.includes(join(root, "src/dep.ts")), served.join(" "));

    // A classic worker, and the worker it starts — at ITS dev URL.
    const classic = await (await get("/sub/classic.ts?aio-worker=iife")).text();
    assertStringIncludes(
      classic,
      `new URL("/w.ts?aio-worker=esm",self.location.href)`,
    );

    // A worker that cannot be bundled: the page is NOT pointed at a bundle —
    // the literal is as written (the worker is served as source, as it
    // always was), in the page and in the worker that starts it. The good
    // one beside it is still bundled.
    await Deno.writeTextFile(join(root, "src/w.ts"), `import "./gone.ts";`);
    const probe = () =>
      devWorkerProbe(join(root, "src"), {
        abs: join(root, "src/w.ts"),
        format: "esm",
      });
    const page2 = await (await serveStatic("/App.tsx")).text();
    assert(!page2.includes("/w.ts?aio-worker"), page2);
    assertStringIncludes(page2, `/sub/classic.ts?aio-worker=iife`);
    const classic2 = await (await get("/sub/classic.ts?aio-worker=iife"))
      .text();
    assertStringIncludes(classic2, `new URL("../w.ts",self.location.href)`);
    const first = await probe();
    assertStringIncludes(first.skipped!.reason, "gone.ts");
    // …and while it is broken and untouched it is not bundled again.
    assert(await probe() === first, "a broken worker was bundled again");
    // Asked for by a page served before it broke: said in the worker.
    const bad = await (await get("/w.ts?aio-worker=esm")).text();
    assert(bad.startsWith("throw new Error("), bad);
    assertStringIncludes(bad, "gone.ts");
    // …and a server-only module is not served inside one.
    await Deno.writeTextFile(
      join(root, "src/k.server.ts"),
      `export const k = "SECRET_KEY";`,
    );
    await Deno.writeTextFile(
      join(root, "src/w.ts"),
      `import { k } from "./k.server.ts";\npostMessage(k);`,
    );
    assert(await probe() !== first, "an edited worker kept its old verdict");
    const leak = await (await get("/w.ts?aio-worker=esm")).text();
    assert(leak.startsWith("throw new Error("), leak);
    assert(!leak.includes("SECRET_KEY"), "a server-only module was served");
    const page3 = await (await serveStatic("/App.tsx")).text();
    assert(!page3.includes("/w.ts?aio-worker"), page3);
  } finally {
    await stopEsbuild();
    await dropTempDir(root);
  }
});

Deno.test("targets: the web folder and the APK's assets carry every worker bundle, and the service worker precaches and pins them", async () => {
  const root = await tempDir("aio-worker-targets-");
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ title: "Probe", version: "0.3" }),
    );
    const dist = join(root, "dist");
    await Deno.mkdir(dist);
    await Deno.writeTextFile(
      join(dist, "app.js"),
      versionStamp("0.3.0") + "x();\n",
    );
    const names = ["worker-a-0a1b2c3d.js", "worker-b-99999999.js"];
    for (const n of names) await Deno.writeTextFile(join(dist, n), `// ${n}`);
    await Deno.writeTextFile(join(dist, "notes.js"), "not a worker");

    const picked = join(root, "picked");
    await Deno.mkdir(picked);
    assertEquals(await copyWorkerBundles(dist, picked), names);
    assertEquals(
      [...Deno.readDirSync(picked)].map((e) => e.name).sort(),
      names,
    );

    const cfg = {
      root,
      dist,
      binaryName: "probe",
      appTitle: "Probe",
      appDir: root,
      configEntry: "src/app.ts",
    } as unknown as BuildConfig;
    await buildWeb(cfg);
    const web = join(root, webArtifactName("probe"));
    const sw = await Deno.readTextFile(join(web, "sw.js"));
    assertEquals(names.length, 2);
    for (const n of names) {
      assertEquals(await Deno.readTextFile(join(web, n)), `// ${n}`);
      assert(
        sw.includes(`"./${n}":"sha256-`),
        `${n} is not digest-pinned in the precache:\n${sw.slice(0, 600)}`,
      );
    }
    assert(!sw.includes("notes.js"));

    const apk = join(root, "apk-assets");
    await Deno.mkdir(apk);
    await _writeLocalAssets(cfg, apk);
    const packed = [...Deno.readDirSync(apk)].map((e) => e.name).sort();
    assertEquals(packed, ["app.js", "index.html", ...names]);
  } finally {
    console.log = log;
    console.warn = warn;
    await dropTempDir(root);
    // The APK's copies are rewritten through esbuild (`_apkWorkers`).
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("assets: a mount declared in deno.json alone is served — dev and prod — and aio.run's wins a shared prefix", async () => {
  const root = await tempDir("aio-worker-assets-");
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.mkdir(join(root, "media"));
    await Deno.writeTextFile(join(root, "media/a.txt"), "FROM_DENO_JSON");
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ assets: { "/media": "./media", "/both": "./media" } }),
    );
    const base = join(root, "src");
    assertEquals(_servedAssets({ "/both": "./elsewhere" }, base), {
      "/media": join(root, "media"),
      "/both": "./elsewhere",
    });
    for (const prod of [false, true]) {
      const { serveStatic } = createStaticHandler(deps({
        prod,
        absBaseDir: base,
        assets: _servedAssets(undefined, base),
      }));
      const r = await serveStatic("/media/a.txt");
      assertEquals(r.status, 200, `prod=${prod}`);
      assertEquals(await r.text(), "FROM_DENO_JSON");
    }
    // No declaration: exactly what aio.run said, the same object.
    const run = { "/x": "./x" };
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    assert(_servedAssets(run, base) === run);
  } finally {
    await dropTempDir(root);
  }
});
