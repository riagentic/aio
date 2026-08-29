// `security: { … }` — the app's statement about how its responses are served.
//
// One small block, defaults chosen so an app that never writes it is strictly
// better off than before and behaves identically to before (see
// `security-headers.ts` for why each default cannot break a working app).
//
// It lives in its own file because `aio.run()`'s config, the server's config
// and the build all need the type, and none of them should have to import a
// module that pulls in `node:zlib`.

/** A Content-Security-Policy choice.
 *
 *  - `"basic"` (default) — the directives that cannot break a page:
 *    `base-uri`, `object-src`, `frame-ancestors`, `form-action`. No
 *    `default-src`, so off-origin assets still load.
 *  - `"strict"` — adds `default-src 'self'` and the per-type sources. Opt-in:
 *    an app that loads a CDN font or script must widen it first.
 *  - `false` / `"off"` — send no CSP.
 *  - any other string — used verbatim as the policy. */
export type CspOption =
  | "basic"
  | "strict"
  | "off"
  | false
  /** A policy the app wrote — used verbatim. */
  | (string & Record<never, never>);

/** How this app's HTTP responses are hardened and encoded. Every field is
 *  optional and every default is the behaviour a good app wants. */
export interface SecurityConfig {
  /** Master switch for the security headers. `false` sends only what the
   *  server sent before alpha72 (`X-Content-Type-Options`). Default: on. */
  headers?: boolean;
  /** Content-Security-Policy. Default `"basic"`. */
  csp?: CspOption;
  /** Send `X-Frame-Options: SAMEORIGIN` when no `allowedOrigins` are
   *  declared. Default: on. (With `allowedOrigins`, CSP `frame-ancestors`
   *  carries the policy instead — `X-Frame-Options` cannot express a list.) */
  frameOptions?: boolean;
  /** `Referrer-Policy` value. Default `strict-origin-when-cross-origin`. */
  referrerPolicy?: string;
  /** `Strict-Transport-Security`. Sent ONLY behind an operator-supplied
   *  certificate (`--tls-cert`), never behind aio's own local CA — pinning
   *  HTTPS for a name on the strength of a self-signed cert outlives the app.
   *  `true`/default: `max-age=15552000`. A string is used verbatim. */
  hsts?: boolean | string;
  /** `Permissions-Policy`, verbatim. No default: restricting camera, mic or
   *  geolocation by guess would break an app that uses them. */
  permissionsPolicy?: string;
  /** Compress responses (`br`/`gzip`/`deflate`, negotiated). Default: on.
   *  Only buffered, compressible, non-trivial 200s are touched — see
   *  `http-encoding.ts`. */
  compress?: boolean;
}
