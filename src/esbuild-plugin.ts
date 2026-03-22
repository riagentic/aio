// esbuild plugin for AIO browser builds
// Intercepts server-only imports (@std/*, node:*) and returns throwing proxy modules
//
// Note: This plugin is used in esbuild.build() (prod bundle) only.
// Dev mode uses esbuild.transform() which doesn't support plugins.
// Dev-mode protection comes from: dynamic import map (Layer 1b),
// aiol lint checks (Layer 2), and error overlay (Layer 3).

/** Creates an esbuild plugin that makes browser builds safe by intercepting server-only imports. */
// deno-lint-ignore no-explicit-any
export function aioBrowserPlugin(): { name: string; setup: (build: any) => void } {
  return {
    name: 'aio-browser',
    // deno-lint-ignore no-explicit-any
    setup(build: any) {
      // Intercept @std/* — Deno standard library, never browser-safe
      build.onResolve({ filter: /^@std\// }, (args: { path: string }) => ({
        path: args.path,
        namespace: 'aio-server-only',
      }))

      // Intercept node:* — Node built-ins, never browser-safe
      build.onResolve({ filter: /^node:/ }, (args: { path: string }) => ({
        path: args.path,
        namespace: 'aio-server-only',
      }))

      // Return throwing proxy module for intercepted imports
      build.onLoad(
        { filter: /.*/, namespace: 'aio-server-only' },
        (args: { path: string }) => ({
          contents: serverOnlyProxy(args.path),
          loader: 'js',
        }),
      )
    },
  }
}

/** Generates JS source for a throwing Proxy module */
function serverOnlyProxy(pkg: string): string {
  const escaped = pkg.replace(/'/g, "\\'")
  return `
const _handler = {
  get(_, prop) {
    if (prop === '__esModule' || prop === 'default' || typeof prop === 'symbol') return undefined;
    throw new Error('[aio] ' + '${escaped}' + '.' + String(prop) + ' is server-only — this code should not run in browser. Move to an async method or effect.');
  },
  apply() {
    throw new Error('[aio] ${escaped} is server-only — this code should not run in browser. Move to an async method or effect.');
  }
};
const _mod = new Proxy(function(){}, _handler);
export default _mod;
`
}
