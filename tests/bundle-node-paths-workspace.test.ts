// A workspace member's bundle finds the packages its workspace installed.
//
// Deno puts a member's npm packages in the workspace ROOT's `node_modules`.
// The bundler told esbuild to look in the member's own only, so the
// framework's `import "immer"` was "Could not resolve" for every workspace
// app built against a path-pinned aio — unless some `node_modules` happened
// to sit above the framework files, which aio's own checkout has. The real
// build is pinned by tests/am-check-bundle-truth.test.ts ("a workspace member
// inherits the root's import map"); this pins the rule.
import { assert, assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  bundleNodePaths,
  explainMissingPackage,
} from "../src/build/client-bundle.ts";

Deno.test("bundleNodePaths: the app's own, then each enclosing PROJECT's — never a stray one", () => {
  const ws = resolve("/ws");
  const app = join(ws, "packages", "app");
  const have = new Set([
    join(ws, "node_modules"),
    join(ws, "deno.json"),
    // a `node_modules` with no project file beside it: somebody's leftovers
    join(ws, "packages", "node_modules"),
    // a project with no `node_modules`: nothing to add
    join(resolve("/"), "package.json"),
  ]);
  assertEquals(
    bundleNodePaths(app, (p) => have.has(p)),
    [join(app, "node_modules"), join(ws, "node_modules")],
  );
  // Only the NEAREST enclosing project: one above it is somebody else's.
  const outer = new Set([
    ...have,
    join(resolve("/"), "node_modules"),
  ]);
  assertEquals(
    bundleNodePaths(app, (p) => outer.has(p)),
    [join(app, "node_modules"), join(ws, "node_modules")],
  );
  // …and nothing above the app's repository, workspace or not.
  const repo = new Set([
    join(ws, ".git"),
    join(resolve("/"), "node_modules"),
    join(resolve("/"), "package.json"),
  ]);
  assertEquals(bundleNodePaths(app, (p) => repo.has(p)), [
    join(app, "node_modules"),
  ]);
  // An app that IS its repository root (`~/proj/app/.git`) with a project
  // one level up (`~/proj/package.json` + `~/proj/node_modules`): not its own.
  const ownRepo = new Set([
    join(app, ".git"),
    join(ws, "packages", "node_modules"),
    join(ws, "packages", "package.json"),
  ]);
  assertEquals(bundleNodePaths(app, (p) => ownRepo.has(p)), [
    join(app, "node_modules"),
  ]);
  // The workspace case is untouched by that: the `.git` is the ROOT's, and
  // the member still gets the root's packages.
  const wsRepo = new Set([...have, join(ws, ".git")]);
  assertEquals(
    bundleNodePaths(app, (p) => wsRepo.has(p)),
    [join(app, "node_modules"), join(ws, "node_modules")],
  );
  // No enclosing project at all: exactly what it was before.
  assertEquals(bundleNodePaths(app, () => false), [join(app, "node_modules")]);
});

// A checkout whose packages were never installed (amui before its first run)
// failed its build with esbuild's bare `Could not resolve "immer"` — which
// names no fix. The build now says the command.
Deno.test("bundle: an uninstalled package is said with the command that installs it", () => {
  const root = join("/proj", "app");
  const none = () => false;
  const line = explainMissingPackage(
    '../src/state-core.ts:21:30: ERROR: Could not resolve "immer"',
    root,
    "src/App.tsx",
    none,
  );
  assert(line !== null);
  for (
    const part of [
      '"immer"',
      join(root, "node_modules"),
      "`deno install --entrypoint src/App.tsx`",
      root,
    ]
  ) assert(line.includes(part), `${part} is not in: ${line}`);
  // A scoped package, and a file inside one, name the package.
  assert(
    explainMissingPackage(
      'Could not resolve "@scope/pkg/sub.js"',
      root,
      "A",
      none,
    )
      ?.includes('"@scope/pkg"'),
  );
  // Installed (anywhere the bundle searches): another problem, esbuild's line.
  assertEquals(
    explainMissingPackage(
      'Could not resolve "immer"',
      root,
      "A",
      (p) => p === join(root, "node_modules", "immer"),
    ),
    null,
  );
  // Not a package: a file of the app's, an alias, another error.
  for (
    const text of [
      'Could not resolve "./missing.ts"',
      'Could not resolve "../x"',
      'Could not resolve "/abs/x"',
      'Could not resolve "aio/renderer"',
      "Unexpected token",
    ]
  ) assertEquals(explainMissingPackage(text, root, "A", none), null, text);
});
