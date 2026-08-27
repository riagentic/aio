// esbuild plugin for AIO browser builds
// Intercepts server-only imports (@std/*, node:*) and returns safe stub modules.
// Also marks *.server.ts dynamic imports as external (convention for server-only helpers).
//
// Note: This plugin is used in esbuild.build() (prod bundle) only.
// Dev mode uses esbuild.transform() which doesn't support plugins.
// Dev-mode protection comes from: dynamic import map (Layer 1b),
// aiol lint checks (Layer 2), and error overlay (Layer 3).

import { SERVER_FILE_RE } from "../entries.ts";

/** Static server-only imports seen in the last client build:
 *  `specifier → the modules that statically import it`.
 *
 *  Populated by the plugin, read by the build so it can FAIL with the chain
 *  rather than ship a bundle whose every use of that module throws in the
 *  browser. Module-level rather than returned, because esbuild's plugin API
 *  gives the caller no channel back and the build already awaits the run. */
export const serverOnlyStatic: Record<string, Set<string>> = {};

/** Server-only modules the client graph reaches DYNAMICALLY —
 *  `await import("./link.server.ts")` inside a cell method.
 *
 *  Legal, and the documented pattern: cell methods run server-side, so on
 *  every target that HAS a Deno runtime this is exactly right and the import
 *  is simply external to the browser bundle. Standalone Android has no Deno
 *  runtime at all — the APK is a WebView and a bundle — so there the same
 *  import is not dead code, it is the half of the app that does the work, and
 *  it silently does not ship. the remote-desktop agent (screenrecord, `wm size`, FFI)
 *  built to a 3.2 MB APK that installed, launched, rendered its control panel,
 *  and did nothing: the Windows build of the same entry is 180 MB because it
 *  carries a runtime. Recorded separately from the static map because the two
 *  mean opposite things — static is always wrong, dynamic is wrong only where
 *  nothing can execute it. */
export const serverOnlyDynamic: Record<string, Set<string>> = {};

/** Forget the previous build's findings — a build is a fresh question. */
export function _resetServerOnlyStatic(): void {
  for (const k of Object.keys(serverOnlyStatic)) delete serverOnlyStatic[k];
  for (const k of Object.keys(serverOnlyDynamic)) delete serverOnlyDynamic[k];
}

/** Creates an esbuild plugin that makes browser builds safe by intercepting server-only imports. */
export function aioBrowserPlugin(): {
  name: string;
  // deno-lint-ignore no-explicit-any
  setup: (build: any) => void;
} {
  return {
    name: "aio-browser",
    // deno-lint-ignore no-explicit-any
    setup(build: any) {
      // Intercept @std/* and node:* — Deno stdlib and Node built-ins, never
      // browser-safe. Both are stubbed (see serverOnlyStub), and a STATIC one
      // is RECORDED on the way past.
      //
      // The stub's premise is that these imports sit inside server-only method
      // bodies reached through `await import(...)`, where they are dead code in
      // the browser. That premise holds for a dynamic import and fails
      // completely for a static one: a top-level `import { … } from
      // "node:sqlite"` in a module the client graph reaches is LIVE code, and
      // the stub turns it into a throw at first use. A production consumer shipped
      // exactly that — a cell value-imported a module touching `node:sqlite`,
      // the client bundle broke, the app served a blank page with "1 module
      // error", and the entire test suite stayed green because tests render
      // server-side where `node:sqlite` exists. They ended up policing aio's
      // bundler with a test of their own. The bundler is where that belongs.
      const record = (importer: string, spec: string) => {
        if (!importer) return;
        (serverOnlyStatic[spec] ??= new Set()).add(importer);
      };
      const recordDynamic = (importer: string, spec: string) => {
        if (!importer) return;
        (serverOnlyDynamic[spec] ??= new Set()).add(importer);
      };
      const intercept = (
        args: { path: string; kind: string; importer: string },
      ) => {
        if (args.kind === "dynamic-import") {
          recordDynamic(args.importer, args.path);
        } else record(args.importer, args.path);
        return { path: args.path, namespace: "aio-server-only" };
      };
      build.onResolve({ filter: /^@std\// }, intercept);
      build.onResolve({ filter: /^node:/ }, intercept);

      // AIO-55: Mark *.server.ts dynamic imports as external — convention for
      // server-only helper modules. Cell methods run server-side; any
      // import('../foo.server.ts') inside them is dead code in the browser bundle.
      build.onResolve(
        { filter: SERVER_FILE_RE },
        (args: { path: string; kind: string; importer: string }) => {
          if (args.kind === "dynamic-import") {
            recordDynamic(args.importer, args.path);
            return { path: args.path, external: true };
          }
          // A STATIC import of a *.server.ts module from the client graph is
          // the whole-app blank screen: the suffix convention is load-bearing
          // and this was its one silent hole — typecheck, lint and the suite
          // all stay green (tests render server-side) while the browser dies
          // on the import chain. A wallet's field report (RIS-8.2) built its
          // own graph test to catch exactly this; the bundler is where it
          // belongs. Recorded like node:/@std — the build FAILS, naming the
          // importing file.
          record(args.importer, args.path);
          return undefined; // still resolves, so the error can name ONE thing
        },
      );

      // The `aio/server` and `aio/build` ENTRIES are the specifier-shaped
      // version of the same convention — `await import("aio/server")` inside
      // a method is the documented lazy pattern (imports.md rule 2b), and
      // without this rule esbuild statically resolved it anyway, dragging the
      // whole server entry into the client graph (one field report kept an
      // opaque-specifier trick purely to defeat that). Dynamic only: a STATIC
      // import stays a loud build error, as it must.
      build.onResolve(
        { filter: /^aio\/(server|build)$/ },
        (args: { path: string; kind: string; importer: string }) => {
          if (args.kind === "dynamic-import") {
            // RECORDED, not just externalized. This is the one server-only
            // door that was opened silently: every other route into server
            // code lands in `serverOnlyDynamic`, and a standalone Android
            // build refuses when the client graph reaches ANY of them,
            // because an APK is a WebView with no Deno runtime to run them.
            // `await import("aio/server")` — the documented lazy pattern —
            // skipped that ledger entirely, so the one import most likely to
            // appear in a real app was the one the Android gate could not
            // see: build SUCCEEDS, APK installs, UI renders, buttons do
            // nothing.
            recordDynamic(args.importer, args.path);
            return { path: args.path, external: true };
          }
          return undefined;
        },
      );

      // AIO-55: Return CJS stub module for server-only imports.
      // Using CJS (not ESM) is critical: esbuild resolves named imports from CJS
      // via the exports object at runtime, not static analysis at build time.
      // A Proxy-backed module.exports satisfies ANY named import (join, resolve, etc.)
      // so `import { join } from "@std/path"` builds successfully even when reached
      // transitively through a dynamic import('../helpers.ts').
      // At runtime, accessing any export throws a clear error — but since these
      // imports are inside server-only method bodies, they're dead code in browser.
      build.onLoad(
        { filter: /.*/, namespace: "aio-server-only" },
        (args: { path: string }) => ({
          contents: serverOnlyStub(args.path),
          loader: "js",
        }),
      );
    },
  };
}

/** Generates CJS source for a server-only stub module.
 *  Any property access on the module throws with a clear error at runtime.
 *  Because it's CJS, esbuild's named import resolution works via the exports object
 *  rather than static ESM analysis — the Proxy satisfies any imported name. */
function serverOnlyStub(pkg: string): string {
  const escaped = pkg.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `var _msg = '[aio] ${escaped} is server-only — move to an async method or effect.';
function _throw() { throw new Error(_msg); }
var _handler = {
  get: function(_, prop) {
    if (prop === '__esModule' || typeof prop === 'symbol') return undefined;
    if (prop === 'default') return _p;
    return function() { throw new Error(_msg + ' (.' + String(prop) + ')'); };
  },
  apply: _throw
};
var _p = new Proxy(_throw, _handler);
module.exports = _p;
module.exports.__esModule = true;
module.exports.default = _p;
`;
}
