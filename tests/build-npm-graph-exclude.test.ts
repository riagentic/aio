// A compiled binary embeds only the npm packages its own module graph can
// reach.
//
// Field report (2026-09-17): a 3D app's Windows exe carried three.js (27 MB)
// and its typings — the server never imports them; the browser bundle already
// holds what the page needs — and every cross-compiled exe gained esbuild's
// Windows binary (10 MB), linked by deno DURING the compile, after the
// exclude list had been built from the tree on disk.
import { assertEquals } from "@std/assert";
import {
  compileModuleRoots,
  type DenoInfoGraph,
  unreachableNpmEntries,
} from "../src/build/build-compile.ts";

const pkgs = (deps: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(deps).map(([id, d]) => [id, { dependencies: d }]),
  );

const lock = pkgs({
  "immer@10.2.0": [],
  "three@0.170.0": [],
  "@types/three@0.170.0": ["@types/webxr@0.5.24"],
  "@types/webxr@0.5.24": [],
  "esbuild@0.24.2": ["@esbuild/win32-x64@0.24.2"],
  "@esbuild/win32-x64@0.24.2": [],
  "undici@7.29.1": ["undici-types@7.18.2"],
  "undici-types@7.18.2": [],
  "a@1.0.0": ["b@2.0.0_c@1.0.0"],
  "b@2.0.0_c@1.0.0": [],
});

const entries = (ids: string[]) =>
  new Set(ids.map((id) => id.replaceAll("/", "+")));

Deno.test("npm graph: everything the graph cannot reach is excluded — including links deno has not made yet", () => {
  const graph: DenoInfoGraph = {
    modules: [
      { kind: "esm" },
      { kind: "npm", npmPackage: "immer@10.2.0" },
      { kind: "npm", npmPackage: "a@1.0.0" },
    ],
    npmPackages: lock,
  };
  // `@esbuild/win32-x64` is NOT on disk yet (deno links it mid-compile), and
  // is excluded all the same: the lockfile names it.
  const onDisk = entries(Object.keys(lock).filter((k) => !k.includes("win32")));
  assertEquals(unreachableNpmEntries([graph], onDisk), [
    "@esbuild+win32-x64@0.24.2",
    "@types+three@0.170.0",
    "@types+webxr@0.5.24",
    "esbuild@0.24.2",
    "three@0.170.0",
    "undici-types@7.18.2",
    "undici@7.29.1",
  ]);
});

Deno.test("npm graph: reachability is transitive and unioned over every root", () => {
  const entry: DenoInfoGraph = {
    modules: [{ kind: "npm", npmPackage: "immer@10.2.0" }],
    npmPackages: lock,
  };
  const worker: DenoInfoGraph = {
    modules: [{ kind: "npm", npmPackage: "undici@7.29.1" }],
    npmPackages: lock,
  };
  const out = unreachableNpmEntries(
    [entry, worker],
    entries(Object.keys(lock)),
  )!;
  // undici is reached by the worker, and its dependency with it.
  assertEquals(out.includes("undici@7.29.1"), false);
  assertEquals(out.includes("undici-types@7.18.2"), false);
  assertEquals(out.includes("immer@10.2.0"), false);
  assertEquals(out.includes("three@0.170.0"), true);
});

Deno.test("npm graph: @types are never embedded, even when a module names them", () => {
  const graph: DenoInfoGraph = {
    modules: [{ kind: "npm", npmPackage: "@types/three@0.170.0" }],
    npmPackages: lock,
  };
  const out = unreachableNpmEntries([graph], entries(Object.keys(lock)))!;
  assertEquals(out.includes("@types+three@0.170.0"), true);
  assertEquals(out.includes("@types+webxr@0.5.24"), true);
});

Deno.test("npm graph: a reached package with no node_modules entry excludes NOTHING", () => {
  const graph: DenoInfoGraph = {
    modules: [{ kind: "npm", npmPackage: "immer@10.2.0" }],
    npmPackages: lock,
  };
  // A layout this cannot map is never a guess about what to leave out.
  assertEquals(
    unreachableNpmEntries([graph], entries(["three@0.170.0"])),
    null,
  );
});

Deno.test("npm graph: module roots are the entry plus every included module file", () => {
  assertEquals(
    compileModuleRoots("src/app.ts", [
      "--include",
      "dist/",
      "--include",
      "/fw/src/server/db-worker.ts",
      "--include",
      "src/server/geo.server.ts",
      "--include",
      "deno.json",
      "--include",
      "assets/x.wasm",
    ]),
    ["src/app.ts", "/fw/src/server/db-worker.ts", "src/server/geo.server.ts"],
  );
});
