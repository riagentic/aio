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
  /** Override or REMOVE individual directives of the computed policy, without
   *  hand-writing the whole thing.
   *
   *  `base-uri 'self'` is in `"basic"` as one of "the directives that cannot
   *  break a page", and for an app's OWN pages that is true. It is not true of
   *  a page your app serves that is not about your app — an archived document,
   *  a mirrored page, a print preview — where the original `<base href>` is
   *  load-bearing and dropping it rewrites every relative URL in the capture
   *  (report 5 §3). Writing a verbatim policy to lose one directive means
   *  re-deriving `frame-ancestors` from `allowedOrigins` by hand and keeping
   *  it in sync forever, so:
   *
   *  ```ts
   *  security: { cspDirectives: { "base-uri": false } }          // drop it
   *  security: { cspDirectives: { "img-src": "'self' https:" } } // widen it
   *  ```
   *
   *  A value replaces (or adds) the directive; `false` removes it. Ignored
   *  when `csp` is a verbatim policy — an app that wrote the whole thing has
   *  already decided. */
  cspDirectives?: Record<string, string | false>;
  /** Give the shell's inline scripts a per-response nonce, so a strict app can
   *  drop `script-src 'unsafe-inline'`. Default: off.
   *
   *  The served shell inlines its own bootstrap, so `"strict"` had to keep
   *  `'unsafe-inline'` for scripts and a hardened app carried that as a
   *  documented waiver (report 1 §11). With a nonce the shell's own scripts are
   *  named and every other inline script is refused.
   *
   *  STYLES ARE NOT NONCED, deliberately. `style-src 'unsafe-inline'` also
   *  governs the `style=` ATTRIBUTE, which `style={{…}}` produces on ordinary
   *  components — noncing styles would break every app that sets one, which is
   *  most of them, in exchange for a directive that was not the complaint.
   *
   *  Only affects `"strict"`: `"basic"` sends no `script-src` at all, so there
   *  is nothing for a nonce to tighten. */
  cspNonce?: boolean;
  /** Compress responses (`br`/`gzip`/`deflate`, negotiated). Default: on.
   *  Only buffered, compressible, non-trivial 200s are touched — see
   *  `http-encoding.ts`. */
  compress?: boolean;
}
