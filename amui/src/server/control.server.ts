// The aio-internal control surface amui speaks to a running app through, behind
// the ONE convention the bundler actually enforces: a `*.server.ts` file name.
//
// `src/am/am-http.ts` and `src/am/am-cmd-state.ts` are Deno-only (UDS sockets,
// `@std/path`, the single-instance lock). amui reached them with a bare
// `await import("../../src/am/am-http.ts")` from a cell method — which reads as
// server-only, and is not: esbuild BUNDLES a dynamic import of a local module,
// so the whole `am` HTTP/UDS chain landed in the browser graph and its static
// `@std/path`/`node:crypto` imports refused the build (`✗ discarded
// dist/app.js`). The suffix — not the `server/` folder it sits in, not the
// dynamic form of the import — is what makes the bundler externalize a module,
// so every hop out of amui into aio's server internals goes through here.
export { httpGet, trojanGet, trojanPost } from "../../../src/am/am-http.ts";
export { envelopePayload } from "../../../src/am/am-cmd-state.ts";
export {
  instances,
  isProcessAlive,
} from "../../../src/server/single-instance-lock.ts";
