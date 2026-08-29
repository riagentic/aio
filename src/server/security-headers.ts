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
 *  `<base>` hijacking, plugin objects, cross-origin framing, and a form that
 *  posts your inputs somewhere else.
 *
 *  `"strict"` adds `default-src 'self'` and is opt-in, because an app that
 *  loads a Google Font or a CDN script needs to say so first. */
export function contentSecurityPolicy(
  cfg: SecurityConfig | undefined,
  ancestors: string,
): string | null {
  const mode = cfg?.csp ?? "basic";
  if (mode === false || mode === "off") return null;
  if (typeof mode === "string" && mode !== "basic" && mode !== "strict") {
    // A literal policy the app wrote — used verbatim, because an app that
    // hands us a policy has already decided.
    return mode;
  }
  const directives = [
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors ${ancestors}`,
    `form-action 'self'`,
  ];
  if (mode === "strict") {
    // `'unsafe-inline'` stays for style and script: the served shell inlines
    // both (the theme stylesheet and the two-line module bootstrap), and an
    // app's own components set inline styles as a matter of course. What
    // `default-src 'self'` buys even so is the whole off-origin surface —
    // an injected `<script src=//evil>` no longer loads.
    directives.unshift(`default-src 'self'`);
    directives.push(
      `script-src 'self' 'unsafe-inline'`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob:`,
      `font-src 'self' data:`,
      // A page must always be able to reach its own socket, on either scheme.
      `connect-src 'self' ws: wss:`,
    );
  }
  return directives.join("; ");
}
