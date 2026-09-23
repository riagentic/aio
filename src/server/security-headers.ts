// Response security headers — one policy, derived from what the app already
// declared, applied at the one place every response passes through.
//
// Until alpha72 the server sent `X-Content-Type-Options: nosniff` and nothing
// else. That was a deliberate, documented non-goal ("Positioning & non-goals"
// — cross-origin is REFUSED by the Origin and Host checks rather than
// negotiated), and the reasoning held: a proxy in front of a public deployment
// is where the rest belongs.
//
// What the reasoning did not cover is the app that has no proxy, which is most
// of them — a localhost tool, a LAN dashboard, an Electron window. Those get
// the same browser, the same clickjacking, the same `<base>` hijack and the
// same form-exfiltration surface as anything else, and each of the directives
// below closes one of those without asking the app for anything.
//
// THE COMPATIBILITY RULE, which every default here obeys: a header may only be
// on by default when it cannot break an app that works today.
//
//   • `frame-ancestors` / `X-Frame-Options` — an aio page in a cross-origin
//     iframe ALREADY cannot work: the WS upgrade carries the embedder's
//     `Origin`, which is neither `isOwnHost` nor allow-listed, so the socket is
//     refused (`server-ws.ts`, CSWSH defense). The one configuration where the
//     embed does work is an explicit `allowedOrigins` entry — so that is
//     exactly what the frame policy is derived FROM. Same input, same answer,
//     one decider: nothing that works stops working.
//   • `base-uri`, `object-src`, `form-action` — aio never emits a `<base>`
//     tag, never a plugin object, and its own forms post same-origin. An app
//     that does none of those (all of them) sees no change.
//   • The default CSP deliberately has NO `default-src`, so a stylesheet, a
//     font, an image or a script from anywhere still loads. `csp: "strict"`
//     is the opt-in that locks that down, and it is opt-in precisely because
//     it CAN break a page that reaches off-origin.
//   • HSTS is sent only behind a certificate the operator supplied. aio's own
//     `--expose` certificate is a self-signed, name-constrained local CA;
//     pinning HTTPS for a name on the strength of it would outlive the app.
import type { SecurityConfig } from "./security-config.ts";

/** Everything the policy needs to know about the running server. */
export interface SecurityContext {
  /** `config.allowedOrigins` — the app's own statement of who may embed and
   *  connect to it. The frame policy is derived from it, never re-declared. */
  allowedOrigins?: string[];
  /** True when this server speaks TLS. */
  secure?: boolean;
  /** True when the certificate came from the operator (`--tls-cert`) rather
   *  than aio's own local CA. Only then is HSTS honest. */
  operatorCert?: boolean;
}

/** The header set, as name → value. Pure: same inputs, same output. */
export function securityHeaders(
  cfg: SecurityConfig | undefined,
  ctx: SecurityContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg?.headers === false) return out;

  // Never a default that can be argued with: a declared type is the type.
  out["X-Content-Type-Options"] = "nosniff";

  // `strict-origin-when-cross-origin` is the modern browser default already;
  // stating it means an older browser behaves like a current one. The served
  // HTML also carries `<meta name="referrer" content="no-referrer">`, which is
  // stricter still and wins for that document — this covers everything else.
  out["Referrer-Policy"] = cfg?.referrerPolicy ??
    "strict-origin-when-cross-origin";

  const ancestors = frameAncestors(ctx.allowedOrigins);
  // `X-Frame-Options` cannot express a list, so it is sent only in the case it
  // can express: nobody else may embed. When the app named embedders, CSP's
  // `frame-ancestors` (which every browser that matters honors, and which
  // supersedes XFO) carries the policy alone.
  if (ancestors === "'self'" && cfg?.frameOptions !== false) {
    out["X-Frame-Options"] = "SAMEORIGIN";
  }

  const csp = contentSecurityPolicy(cfg, ancestors);
  if (csp) out["Content-Security-Policy"] = csp;

  if (ctx.secure && ctx.operatorCert && cfg?.hsts !== false) {
    // 180 days, no preload, no subdomains: a framework may harden the name it
    // was given and must not speak for names it was not.
    out["Strict-Transport-Security"] = typeof cfg?.hsts === "string"
      ? cfg.hsts
      : "max-age=15552000";
  }

  if (cfg?.permissionsPolicy) {
    out["Permissions-Policy"] = cfg.permissionsPolicy;
  }
  // A value the runtime cannot put in a header would throw once per RESPONSE —
  // a 500 on everything, from a config key, with the cause nowhere near the
  // symptom. This function runs once at server construction, so refusing here
  // turns that into a boot error naming the key and the character.
  for (const [name, value] of Object.entries(out)) {
    const bad = /[\r\n\0]/.test(value)
      ? "a control character"
      : /[^\x20-\x7e]/.test(value)
      ? "a non-ASCII character"
      : null;
    if (bad) {
      throw new Error(
        `security: the ${name} value contains ${bad}, which cannot go in an ` +
          `HTTP header — every response would fail.\n  value: ${
            JSON.stringify(value)
          }\n  Check the \`security\` block in aio.run() (and \`allowedOrigins\`, ` +
          `which the frame policy is derived from).`,
      );
    }
  }
  return out;
}

/** The `frame-ancestors` source list, derived from `allowedOrigins`.
 *
 *  An entry may be a bare hostname (`dash.corp`), a `host:port`, or a full
 *  origin — the same three spellings `allowlistAdmits` accepts. A bare host
 *  becomes a scheme-relative source so either scheme matches, which is what
 *  the WS check does too. */
export function frameAncestors(allowedOrigins?: string[]): string {
  const extra: string[] = [];
  for (const raw of allowedOrigins ?? []) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "*") return "*";
    const src = cspHostSource(entry);
    if (src) extra.push(src);
  }
  return ["'self'", ...dedupe(extra)].join(" ");
}

/** `entry` as a CSP host-source, or null when it cannot be one.
 *
 *  THIS IS A SAFETY GATE, not tidiness. A header value must be ASCII with no
 *  control characters, no `,` and no `;` — and `allowedOrigins` is app config,
 *  so it can hold an IDN hostname (`ünïcödé.example`), a zero-width character
 *  that survived `trim()`, or a stray comma. Splicing one of those into the
 *  policy produces a value the runtime refuses, and since the header set is
 *  applied to EVERY response, that is a 500 on every request — from a config
 *  key whose only other job is to widen an allowlist.
 *
 *  Found by `scripts/audit-round.ts 5`, which builds the policy from random
 *  origins and asks `new Headers()` whether the result is legal.
 *
 *  Deliberately conservative: an entry this cannot express is DROPPED from the
 *  frame policy (the app is then no more framable than the default, which is
 *  the safe direction) and left completely untouched everywhere else — the WS
 *  Origin check and the Host gate read the raw list, so no behaviour an app
 *  has today changes. */
export function cspHostSource(entry: string): string | null {
  // Scheme-only source: `https:`, `ws:`, `data:`.
  if (/^[a-z][a-z0-9+.-]*:$/i.test(entry)) return entry.toLowerCase();
  const withoutScheme = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const scheme = entry.slice(0, entry.length - withoutScheme.length);
  const hostPort = withoutScheme.replace(/\/.*$/, "").replace(/\/+$/, "");
  if (!hostPort) return null;
  // host[:port], where host is a name, a wildcard subdomain, an IPv4 literal,
  // or a bracketed IPv6 literal. ASCII only, by construction.
  const OK =
    /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:([0-9]{1,5}|\*))?$/;
  const IPV6 = /^\[[0-9A-Fa-f:.]+\](:([0-9]{1,5}|\*))?$/;
  if (!OK.test(hostPort) && !IPV6.test(hostPort)) return null;
  return (scheme ? scheme.toLowerCase() : "") + hostPort;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** The Content-Security-Policy for this app, or null for none.
 *
 *  `"basic"` (the default) is the set of directives that cannot break a page:
 *  no `default-src`, so every off-origin stylesheet, font, image, script and
 *  API call still loads exactly as before. What it does close is real —
 *  `<base>` hijacking, plugin objects, cross-origin framing, a form that
 *  posts your inputs somewhere else, and `eval`.
 *
 *  `"strict"` adds `default-src 'self'` and is opt-in, because an app that
 *  loads a Google Font or a CDN script needs to say so first. */
export function contentSecurityPolicy(
  cfg: SecurityConfig | undefined,
  ancestors: string,
  /** A per-response nonce for the SHELL's inline scripts. Only meaningful
   *  under `"strict"` — see {@link SecurityConfig.cspNonce}. */
  nonce?: string,
): string | null {
  const mode = cfg?.csp ?? "basic";
  if (mode === false || mode === "off") return null;
  if (typeof mode === "string" && mode !== "basic" && mode !== "strict") {
    // A literal policy the app wrote — used verbatim, because an app that
    // hands us a policy has already decided. `cspDirectives` is ignored here
    // for the same reason: two ways to say one thing, one of them silent.
    return mode;
  }
  const directives = new Map<string, string>([
    ["base-uri", `'self'`],
    ["object-src", `'none'`],
    ["frame-ancestors", ancestors],
    ["form-action", `'self'`],
    // A `script-src` that names EVERY source a page could already use, and
    // withholds exactly one capability: `'unsafe-eval'`. So `eval`,
    // `new Function` and `setTimeout("…")` stop working, and nothing else
    // changes — which keeps `"basic"`'s promise ("cannot break a page")
    // while closing the hole that `"basic"` was otherwise silent about.
    //
    //   `*`                  every http(s) URL, AND — per CSP3's special case
    //                        for the bare `*` — any URL on the document's own
    //                        scheme. That second half is what keeps
    //                        `aio://app/app.js` loading inside the packaged
    //                        Electron window, where the document's scheme is
    //                        not a network scheme.
    //   `data:` `blob:`      generated scripts and blob-URL Workers (`*` is
    //                        defined not to match either).
    //   `'unsafe-inline'`    the shell's own bootstrap, `ui.head` scripts and
    //                        `on…=` handlers. Deliberately NOT combined with
    //                        the nonce: a nonce switches `'unsafe-inline'`
    //                        off, which would refuse every inline script an
    //                        app wrote. `"strict"` is where nonces belong.
    //   `'wasm-unsafe-eval'` WebAssembly, which any `script-src` would
    //                        otherwise take away from an app that had it.
    //
    // WHY it is here and not only on the Electron shell: without a
    // `script-src`, Chromium's `_isEvalAllowed()` is true, and Electron logs
    // "Electron Security Warning (Insecure Content-Security-Policy)" in the
    // renderer of every packaged app at every launch. Measured on a real
    // Electron 44.4.1 window over `aio://`: warning present before, absent
    // after, with the module, WASM, inline scripts and http/https/data/blob/
    // same-scheme script sources all still loading. Electron also has an env
    // switch that hides the message — it would have left the eval in place,
    // and `tests/electron-csp-eval.test.ts` keeps it out of this repo. Dev
    // and prod get the identical policy on purpose — an app
    // that needs `eval` must fail in `deno task dev` first, not only once
    // packaged. That app opts out by name:
    // `security: { cspDirectives: { "script-src": false } }`.
    ["script-src", `* data: blob: 'unsafe-inline' 'wasm-unsafe-eval'`],
  ]);
  if (mode === "strict") {
    // `default-src 'self'` buys the whole off-origin surface — an injected
    // `<script src=//evil>` no longer loads.
    const ordered = new Map<string, string>([["default-src", `'self'`]]);
    for (const [k, v] of directives) ordered.set(k, v);
    directives.clear();
    for (const [k, v] of ordered) directives.set(k, v);
    // A NONCE names the shell's own inline scripts, so `'unsafe-inline'` can
    // go and every OTHER inline script is refused. Without one it has to stay:
    // the served shell inlines its own bootstrap, and a policy that blocks the
    // page aio itself served is not a hardening, it is an outage.
    directives.set(
      "script-src",
      nonce ? `'self' 'nonce-${nonce}'` : `'self' 'unsafe-inline'`,
    );
    // STYLES KEEP `'unsafe-inline'`, always. The directive also governs the
    // `style=` ATTRIBUTE, which `style={{…}}` produces on ordinary components,
    // so noncing styles would break most apps in exchange for a directive
    // nobody asked about.
    directives.set("style-src", `'self' 'unsafe-inline'`);
    directives.set("img-src", `'self' data: blob:`);
    directives.set("font-src", `'self' data:`);
    // A page must always be able to reach its own socket, on either scheme.
    directives.set("connect-src", `'self' ws: wss:`);
  }
  // The app's own overrides, LAST, so they beat everything computed above.
  for (const [name, value] of Object.entries(cfg?.cspDirectives ?? {})) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    if (value === false) directives.delete(key);
    else if (typeof value === "string" && value.trim()) {
      let v = value.trim();
      // COMPOSE with the nonce rather than replace it. A wallet that needed
      // one extra script host had to choose: its host, or the nonce that let
      // 'unsafe-inline' go — never both, because the override won whole and
      // the nonce is per-response, so it cannot be written by hand. `{nonce}`
      // names it anywhere; a `script-src` written without one gets it
      // appended, because dropping the nonce silently is the outage the nonce
      // exists to prevent.
      if (v.includes("{nonce}")) {
        if (!nonce) {
          throw new Error(
            `security.cspDirectives["${key}"] uses {nonce}, but ` +
              `security.cspNonce is not on — there is no nonce to put there. ` +
              `Set cspNonce: true, or remove the placeholder.`,
          );
        }
        v = v.replaceAll("{nonce}", `'nonce-${nonce}'`);
      } else if (key === "script-src" && nonce && !v.includes("'nonce-")) {
        v = `${v} 'nonce-${nonce}'`;
      }
      directives.set(key, v);
    }
  }
  if (directives.size === 0) return null;
  return [...directives].map(([k, v]) => `${k} ${v}`).join("; ");
}

/** The directives a policy delivered by `<meta http-equiv>` cannot carry.
 *
 *  Not a style rule — the spec says a document-delivered policy ignores these,
 *  and Chromium says it OUT LOUD, once per document:
 *
 *    The Content Security Policy directive 'frame-ancestors' is ignored when
 *    delivered via a <meta> element.
 *
 *  Every aio policy carries `frame-ancestors` (it is in the "basic" default),
 *  so the packaged Electron shell — which is returned from the main process
 *  and therefore has the meta as its ONLY delivery — logged that error at
 *  every launch, and read as if the window were frame-protected by its own
 *  document. The header keeps all three wherever the shell is served over
 *  HTTP, which is the one place they can work. */
export const CSP_META_IGNORES: readonly string[] = [
  "frame-ancestors",
  "report-uri",
  "sandbox",
];

/** The part of `policy` a `<meta http-equiv>` can actually deliver — or null
 *  when nothing of it is left, because `content=""` is a policy that denies
 *  nothing while looking like one that denies everything.
 *
 *  ONE decider: the generator emits what this returns, and nothing else
 *  decides what a document may carry.
 *
 *  @decider */
export function metaDeliverableCsp(policy: string): string | null {
  const kept = policy
    .split(";")
    .map((d) => d.trim())
    .filter((d) =>
      d && !CSP_META_IGNORES.includes(d.split(/\s+/)[0]!.toLowerCase())
    );
  return kept.length ? kept.join("; ") : null;
}

/** A fresh CSP nonce: 128 bits, base64. Per RESPONSE — a nonce reused across
 *  responses is a nonce an attacker can read from one page and replay into
 *  another, which is the whole reason the directive exists. */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // BASE64URL, not plain base64. CSP's `base64-value` admits `-` and `_` as
  // well as `+` and `/`, so both are valid — but `+` and `/` are
  // regex-special, and a nonce carrying one turns every downstream
  // `new RegExp(nonce)` into a different pattern than its author meant. That
  // happens intermittently, on one run in a few, which is the worst way for a
  // bug to present. `=` padding goes for the same reason.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
