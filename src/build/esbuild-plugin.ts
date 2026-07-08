// esbuild plugin for AIO browser builds
// Intercepts server-only imports (@std/*, node:*) and returns safe stub modules.
// Also marks *.server.ts dynamic imports as external (convention for server-only helpers).
//
// Note: This plugin is used in esbuild.build() (prod bundle) only.
// Dev mode uses esbuild.transform() which doesn't support plugins.
// Dev-mode protection comes from: dynamic import map (Layer 1b),
// aiol lint checks (Layer 2), and error overlay (Layer 3).

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
      // Intercept @std/* — Deno standard library, never browser-safe
      build.onResolve({ filter: /^@std\// }, (args: { path: string }) => ({
        path: args.path,
        namespace: "aio-server-only",
      }));

      // Intercept node:* — Node built-ins, never browser-safe
      build.onResolve({ filter: /^node:/ }, (args: { path: string }) => ({
        path: args.path,
        namespace: "aio-server-only",
      }));

      // AIO-55: Mark *.server.ts dynamic imports as external — convention for
      // server-only helper modules. Cell methods run server-side; any
      // import('../foo.server.ts') inside them is dead code in the browser bundle.
      build.onResolve(
        { filter: /\.server\.ts$/ },
        (args: { path: string; kind: string }) => {
          if (args.kind === "dynamic-import") {
            return { path: args.path, external: true };
          }
          return undefined; // fall through to default resolution
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
