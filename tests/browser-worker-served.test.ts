// A worker started from a script the app SERVES — `new Worker("/x.js")`,
// `new Worker(new URL("./x.js", import.meta.url))` — is bundled by nothing,
// so the build says which artifact does not carry it.
//
// A file of the app's folder is served by the dev server and by `--prod`,
// and is in no compiled binary (unless `compile.include` names it), web build
// or APK: the first word was the Worker's `error` event in the artifact. And
// an absolute path in a web build is the host's root, not the build's folder.
// Both are warnings — the build is as green as it was. Held here too:
//   the silence    what the artifact carries, and what this build cannot
//                  see (a route, an `aio.run` mount), is not reported; a
//                  `.js` named beside the bundle is the same request either
//                  side of a build and no longer gets "does not follow"
//   dev == build   a classic `.ts` worker is ONE bundle, the same bytes from
//                  the dev server and from a build (its top-level names are
//                  the bundle's own in both)
//   the cache      a bundle another aio version built is never read as fresh,
//                  whatever its inputs record says; a bundle that IS reused
//                  says every worker warning again
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import * as esbuild from "esbuild";
import {
  isBundleFresh,
  servedWorkerNotes,
  versionStamp,
} from "../src/build/build-bundle.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import { bundleClient } from "../src/build/client-bundle.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import {
  devWorkerBundle,
  servedWorkers,
  unmanagedWorkers,
  workerEntries,
} from "../src/server/graph-validator.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const abs = (p: string) => resolve(p);
const there = () => true;

Deno.test("servedWorkers: a literal that names no source is one — by plain path or relative to the module; source, a computed URL and another base are not", () => {
  const at = abs("/app/src/App.tsx");
  assertEquals(
    servedWorkers(
      `new Worker("/workers/a.js");\n` +
        `new SharedWorker("workers/b.mjs", { type: "module" });\n` +
        `new Worker(new URL("./c.js", import.meta.url));\n` +
        `new Worker(new URL("./d.ts", import.meta.url));\n` + // bundled
        `new Worker("/e.ts");\n` + // source by path: said by unmanagedWorkers
        `new Worker(new URL("./f.js", location.href));\n` + // another base
        `new Worker(new URL(name, import.meta.url));\n` +
        `new Worker("https://cdn.example/g.js");\n` +
        `// new Worker("/in-a-comment.js")\n`,
      at,
    ),
    [
      { line: 1, spec: "/workers/a.js", meta: false },
      { line: 2, spec: "workers/b.mjs", meta: false },
      { line: 3, spec: "./c.js", meta: true },
    ],
  );
});

Deno.test("unmanagedWorkers: a `.js` named beside the bundle is the same request in dev and in a build — not reported; from another folder it is", () => {
  const code = `new Worker(new URL("./s.js", import.meta.url))`;
  const said = (file: string, appDir?: string) =>
    unmanagedWorkers(code, abs(file), there, appDir && abs(appDir))
      .map((e) => e.message);
  assertEquals(said("/app/src/App.tsx", "/app/src"), []);
  assertEquals(said("/app/src/App.tsx", "/app/src/"), []);
  assertStringIncludes(said("/app/src/ui/Panel.tsx", "/app/src")[0]!, "follow");
  // A caller that does not know the app's folder says it, as before.
  assertStringIncludes(said("/app/src/App.tsx")[0]!, "does not follow");
  // Another base is not the bundle's folder, wherever the module is.
  assertEquals(
    unmanagedWorkers(
      `new Worker(new URL("./s.js", location.href))`,
      abs("/app/src/App.tsx"),
      there,
      abs("/app/src"),
    ).length,
    1,
  );
});

Deno.test("unmanagedWorkers: a bundled classic worker in a sub-folder that hands importScripts a relative literal is named — its own URL differs either side of a build", async () => {
  const dir = await tempDir("aio-import-scripts-");
  try {
    await Deno.mkdir(join(dir, "src/sub"), { recursive: true });
    const REL = `// importScripts("./no.js")\nimportScripts("./x.js");`;
    await Deno.writeTextFile(join(dir, "src/sub/w.ts"), REL);
    await Deno.writeTextFile(join(dir, "src/w.ts"), REL);
    await Deno.writeTextFile(
      join(dir, "src/sub/abs.ts"),
      `const s = 'importScripts("./in-a-string.js")';\nimportScripts("/x.js");`,
    );
    const said = (call: string, appDir: string | null = "src") =>
      unmanagedWorkers(
        call,
        join(dir, "src/App.tsx"),
        undefined,
        appDir === null ? undefined : join(dir, appDir),
      );
    const url = (f: string, opts = "") =>
      `\nnew Worker(new URL("${f}", import.meta.url)${opts})`;
    const [one, ...rest] = said(url("./sub/w.ts"));
    assertEquals(rest, []);
    assertEquals([one!.category, one!.line], ["unmanaged-worker", 2]);
    assertStringIncludes(one!.message, `calls importScripts("./x.js")`);
    assertStringIncludes(one!.fix!, `importScripts("/sub/x.js")`);
    // The same request either side of a build, or not a classic worker, or
    // a folder this caller does not know: nothing.
    assertEquals(said(url("./w.ts")), []);
    assertEquals(said(url("./sub/w.ts", `, { type: "module" }`)), []);
    assertEquals(said(url("./sub/abs.ts")), []);
    assertEquals(said(url("./sub/w.ts"), null), []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("servedWorkerNotes: says what THIS artifact does not carry — and nothing about what it carries or cannot see", () => {
  const root = abs("/app");
  const files = new Set(
    ["src/x.js", "src/inc/y.js", "src/workers/own.js", "src/beside.js"]
      .map((f) => join(root, f)),
  );
  const notes = (
    code: string,
    target: { compile?: boolean; standalone?: boolean; web?: boolean },
    module = "src/App.tsx",
  ) =>
    servedWorkerNotes({
      workers: servedWorkers(code, join(root, module)),
      module,
      root,
      appDir: join(root, "src"),
      mounts: ["/workers"],
      include: ["src/inc", "./src/listed.js"],
      compile: !!target.compile,
      standalone: !!target.standalone,
      web: !!target.web,
      isFile: (p) => files.has(p),
    });
  const BINARY = { compile: true };
  const WEB = { standalone: true, web: true };
  const APK = { standalone: true };

  // A file of the app's folder: not in the binary, the web build or the APK.
  const [headline, fix] = notes(`\n\nnew Worker("/x.js")`, BINARY)[0]!;
  assertStringIncludes(headline, `src/App.tsx:3 — the worker "/x.js"`);
  assertStringIncludes(headline, "is src/x.js");
  assertStringIncludes(headline, "compiled binary embeds no such file");
  assertStringIncludes(fix, `Add "src/x.js" to deno.json "compile"`);
  assertStringIncludes(fix, `"assets"`);
  assertStringIncludes(fix, `new URL("./worker.ts"`);
  assertEquals(notes(`new Worker("x.js")`, BINARY).length, 1);
  assertStringIncludes(
    notes(`new Worker("x.js")`, APK)[0]![0],
    "carries the bundle and the mounts only",
  );
  // …by URL from a module beside the bundle, the same file.
  const beside = `new Worker(new URL("./beside.js", import.meta.url))`;
  assertEquals(notes(beside, BINARY).length, 1);
  assertEquals(notes(beside, APK).length, 1);
  // From another folder `unmanagedWorkers` has the word; never two.
  assertEquals(notes(beside, BINARY, "src/ui/Panel.tsx"), []);

  // SILENT — served from the tree, where the file is:
  assertEquals(notes(`new Worker("/x.js")`, {}), []);
  // — `compile.include` names it, or a folder above it:
  assertEquals(notes(`new Worker("/inc/y.js")`, BINARY), []);
  // …which no web build or APK reads.
  assertEquals(notes(`new Worker("/inc/y.js")`, APK).length, 1);
  // — a deno.json mount, which every target carries (the app's own file
  //   of that path or not):
  assertEquals(notes(`new Worker("/workers/own.js")`, BINARY), []);
  assertEquals(notes(`new Worker("workers/w.js")`, WEB), []);
  assertEquals(notes(`new Worker("workers/w.js")`, APK), []);
  // — a path this build cannot see the server of (a route, an `aio.run`
  //   mount): not its to judge.
  assertEquals(notes(`new Worker("/api/worker.js")`, BINARY), []);
  assertEquals(notes(`new Worker("/cache/w.js")`, APK), []);

  // A web build under a sub-path: an absolute path is the host's root —
  // said for a mounted file too, since that is the one that would work.
  const sub = notes(`new Worker("/workers/w.js")`, WEB);
  assertEquals(sub.length, 1);
  assertStringIncludes(sub[0]![0], "not under a sub-path");
  assertStringIncludes(sub[0]![1], `new Worker("workers/w.js")`);
  assertEquals(notes(`new Worker("/workers/w.js")`, APK), []);
  // …and an app-folder file by absolute path is both things.
  assertEquals(notes(`new Worker("/x.js")`, WEB).length, 2);
});

const DENO_JSON = (extra: Record<string, unknown>) =>
  JSON.stringify({
    appId: "served-worker",
    nodeModulesDir: "manual",
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
    imports: {
      "aio": `${spec(REPO)}mod.ts`,
      "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
      "aio/server": `${REPO}src/server.ts`,
      "immer": "npm:immer@10.2.0",
      "@std/path": "jsr:@std/path@^1",
    },
    ...extra,
  });

Deno.test({
  name:
    "build: a worker script of the app's folder is named by the build that will not carry it — a warning, exit 0; the tree build and the mounted script say nothing",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-served-worker-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await Deno.mkdir(join(dir, "workers"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(join(dir, "src/x.js"), "postMessage(1)");
      await Deno.writeTextFile(join(dir, "workers/m.js"), "postMessage(2)");
      await Deno.writeTextFile(
        join(dir, "src/App.tsx"),
        `export default function App() {
  new Worker("/x.js");
  new Worker("workers/m.js");
  return <p>hi</p>;
}`,
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
      const build = async (
        over: Partial<BuildConfig>,
        config: Record<string, unknown> = {},
      ) => {
        await Deno.writeTextFile(
          join(dir, "deno.json"),
          DENO_JSON({ assets: { "/workers": "./workers" }, ...config }),
        );
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
        return said.replace(/\s+/g, " "); // the build wraps its lines
      };
      // From the tree (`--prod`): the file is where the server reads it.
      assert(
        !(await build({})).includes("the worker"),
        "said for a tree build",
      );
      // A compiled binary: named, with the line to add.
      const binary = await build({ doCompile: true });
      assertStringIncludes(binary, `src/App.tsx:2 — the worker "/x.js"`);
      assertStringIncludes(binary, `Add "src/x.js" to deno.json "compile"`);
      assert(!binary.includes("m.js"), binary);
      // …and silent once `compile.include` carries it.
      assert(
        !(await build({ doCompile: true }, {
          compile: { include: ["src/x.js"] },
        })).includes("the worker"),
        "said though compile.include names the file",
      );
      // A web build: the app's file is not in it, and "/" is the host's root.
      const web = await build({ doWeb: true, standalone: true });
      assertStringIncludes(web, "carries the bundle and the mounts only");
      assertStringIncludes(web, "not under a sub-path");
      assert(!web.includes("m.js"), web);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "build: a cached bundle says the worker warnings again — the same lines as the build that ran esbuild",
  sanitizeOps: false, // aio-ok(sanitizers): a child build per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-cached-worker-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await fixtureNodeModules(dir);
      await Deno.writeTextFile(join(dir, "src/x.js"), "postMessage(1)");
      // A worker that cannot be bundled: it imports a file that is not there.
      await Deno.writeTextFile(join(dir, "src/w.ts"), `import "./gone.ts";`);
      await Deno.writeTextFile(
        join(dir, "src/App.tsx"),
        `export default function App() {
  new Worker("/x.js");
  new Worker(new URL("./w.ts", import.meta.url), { type: "module" });
  return <p>hi</p>;
}`,
      );
      await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON({}));
      // Every input older than the bundle by more than any clock's grain:
      // an equal mtime is "stale", by design.
      const past = new Date(Date.now() - 60_000);
      for (const f of ["src/x.js", "src/w.ts", "src/App.tsx", "deno.json"]) {
        await Deno.utime(join(dir, f), past, past);
      }
      const runner = join(dir, "runner.ts");
      await Deno.writeTextFile(
        runner,
        `import { runBundle } from "${spec(REPO)}src/build/build-bundle.ts";
import { loadBuildConfig } from "${spec(REPO)}src/build/build-config.ts";
const cfg = await loadBuildConfig();
await runBundle(
  { ...cfg, doCompile: true, doForce: Deno.args[0] === "force" },
  JSON.parse(await Deno.readTextFile("deno.json")),
);
`,
      );
      const build = async (arg: string) => {
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", runner, arg],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(out.stderr) +
          new TextDecoder().decode(out.stdout);
        assertEquals(out.code, 0, said);
        return said.replace(/\s+/g, " "); // the build wraps its lines
      };
      const SERVED = `src/App.tsx:2 — the worker "/x.js"`;
      const SKIPPED = "the worker src/w.ts cannot be bundled";
      const count = (said: string, what: string) => said.split(what).length - 1;
      const first = await build("force");
      assert(!first.includes("cached"), first);
      assertEquals([count(first, SERVED), count(first, SKIPPED)], [1, 1]);
      const second = await build("");
      assertStringIncludes(second, "dist/app.js cached");
      assertEquals(
        [count(second, SERVED), count(second, SKIPPED)],
        [1, 1],
        second,
      );
      // …in the same words: the sentence that ends each warning.
      const tail = (said: string, what: string) =>
        said.slice(said.indexOf(what)).split(" · ")[0]!.slice(0, 200);
      assertEquals(tail(second, SERVED), tail(first, SERVED));
      assertEquals(tail(second, SKIPPED), tail(first, SKIPPED));
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("dev == build: a classic `.ts` worker is one IIFE bundle in both — the same bytes, its top-level names the bundle's own", async () => {
  const root = await tempDir("aio-worker-classic-parity-");
  try {
    await Deno.mkdir(join(root, "src"));
    await fixtureNodeModules(root, "npm:immer@10.2.0");
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    const page = `export default function App() {
  new Worker(new URL("./c.ts", import.meta.url));
  new Worker(new URL("./c.ts", import.meta.url), opts);
  return "x";
}`;
    await Deno.writeTextFile(join(root, "src/App.tsx"), page);
    await Deno.writeTextFile(
      join(root, "src/c.ts"),
      `import { tag } from "./dep.ts";
function topLevel(): string { return tag; }
var alsoTop = 1;
self.onmessage = () => postMessage(topLevel() + alsoTop);`,
    );
    await Deno.writeTextFile(
      join(root, "src/dep.ts"),
      `export const tag = "T";`,
    );
    // An options argument that is not a literal `{ type: "module" }` is
    // built classic: an IIFE is a valid script under either worker type.
    const entries = workerEntries(page, join(root, "src/App.tsx"));
    assertEquals(entries.map((e) => e.format), ["iife", "iife"]);

    const built = await bundleClient({
      esbuild,
      root,
      appDir: join(root, "src"),
      uiEntry: "App.tsx",
      standalone: false,
      imports: {},
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(built.ok, built.errors.join("\n"));
    assertEquals(built.workers.length, 1);
    const dev = await devWorkerBundle(
      join(root, "src"),
      entries[0]!,
      (e) => e.spec,
    );
    assertEquals(dev.errors, []);
    assertEquals(dev.code, built.workers[0]!.code);
    // One function scope, and nothing a module-only parser is needed for.
    assert(/^\(\(\)=>\{/.test(dev.code.trim()), dev.code);
    assert(!/\b(?:import|export)\b/.test(dev.code), dev.code);
  } finally {
    await stopEsbuild();
    await stopEsbuildService(() => esbuild.stop());
    await dropTempDir(root);
  }
});

Deno.test("staleness: a bundle another aio version built is not fresh, whatever its inputs record says — a record without `workers`/`absent` is never read across versions", async () => {
  const root = await tempDir("aio-worker-record-version-");
  try {
    const dist = join(root, "dist");
    const out = join(dist, "app.js");
    await Deno.mkdir(join(root, ".aio"));
    await Deno.mkdir(dist);
    const input = join(root, "App.tsx");
    await Deno.writeTextFile(input, "");
    await Deno.utime(input, 1, 1); // older than the bundle
    // The record 1.0.19 wrote: the same `v`, no `workers`, no `absent`.
    await Deno.writeTextFile(
      join(root, ".aio/bundle-inputs.json"),
      JSON.stringify({ v: 2, out, app: root, inputs: [input] }),
    );
    const cfg = { out, root, appDir: root, doForce: false } as BuildConfig;
    const stamp = (version: string) =>
      Deno.writeTextFile(
        out,
        versionStamp(version) + `globalThis.__aioBundleTarget = "browser";\n`,
      );
    await stamp("1.0.19-beta");
    assertEquals(await isBundleFresh(cfg), false);
    // The instrument: the same record under this version's bundle IS fresh.
    await stamp(VERSION);
    assertEquals(await isBundleFresh(cfg), true);
  } finally {
    await dropTempDir(root);
  }
});
