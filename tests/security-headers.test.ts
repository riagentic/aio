// The response security headers — and the compatibility rule they obey.
//
// Until alpha72 the server sent `X-Content-Type-Options: nosniff` and nothing
// else, as a documented non-goal: cross-origin is REFUSED by the Origin and
// Host checks rather than negotiated, and a proxy in front is where a public
// deployment adds the rest. That reasoning does not reach the app with no
// proxy, which is most of them — a localhost tool, a LAN dashboard, an
// Electron window — and those get the same browser and the same clickjacking,
// `<base>`-hijack and form-exfiltration surface as anything else.
//
// THE RULE every default here obeys, and the reason this file is mostly about
// what does NOT change: a header may be on by default only when it cannot
// break an app that works today. The frame policy is therefore DERIVED from
// `allowedOrigins` — the same list that decides whether an embedder's socket
// is accepted decides whether it may frame the page — so there is one decider
// and no configuration where the two can disagree.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  contentSecurityPolicy,
  cspHostSource,
  frameAncestors,
  securityHeaders,
} from "../src/server/security-headers.ts";

Deno.test("security: the defaults an app gets without asking", () => {
  const h = securityHeaders(undefined, {});
  assertEquals(h["X-Content-Type-Options"], "nosniff");
  assertEquals(h["Referrer-Policy"], "strict-origin-when-cross-origin");
  assertEquals(h["X-Frame-Options"], "SAMEORIGIN");
  assertStringIncludes(h["Content-Security-Policy"]!, "frame-ancestors 'self'");
  assertStringIncludes(h["Content-Security-Policy"]!, "base-uri 'self'");
  assertStringIncludes(h["Content-Security-Policy"]!, "object-src 'none'");
  assertStringIncludes(h["Content-Security-Policy"]!, "form-action 'self'");
});

Deno.test("security: the default CSP has NO default-src — nothing off-origin breaks", () => {
  const csp = contentSecurityPolicy(undefined, "'self'")!;
  assert(
    !csp.includes("default-src"),
    "a `default-src 'self'` default would break every app that loads a CDN " +
      "font, script or image — that is opt-in, not a default",
  );
  for (const off of ["script-src", "style-src", "img-src", "connect-src"]) {
    assert(!csp.includes(off), `"${off}" must not appear in the basic policy`);
  }
});

Deno.test("security: the frame policy is DERIVED from allowedOrigins, never re-declared", () => {
  // An aio page in a cross-origin iframe already cannot work: the WS upgrade
  // carries the embedder's Origin, which is refused unless allow-listed. So
  // the one configuration where framing works is the one where the app said
  // so — and that is the input the frame policy reads.
  assertEquals(frameAncestors(undefined), "'self'");
  assertEquals(frameAncestors([]), "'self'");
  assertEquals(
    frameAncestors(["dash.corp"]),
    "'self' dash.corp",
  );
  assertEquals(
    frameAncestors(["https://dash.corp", "shell.internal:8080"]),
    "'self' https://dash.corp shell.internal:8080",
  );
  assertEquals(frameAncestors(["a.com", "a.com"]), "'self' a.com");
  assertEquals(frameAncestors(["https://a.com/"]), "'self' https://a.com");
  assertEquals(frameAncestors(["*"]), "*");
});

Deno.test("security: an app that named embedders gets no X-Frame-Options", () => {
  // XFO cannot express a list. Sending SAMEORIGIN alongside a permissive
  // `frame-ancestors` is the worst answer: an older browser blocks the embed
  // the app explicitly allowed.
  const h = securityHeaders(undefined, { allowedOrigins: ["dash.corp"] });
  assertEquals(h["X-Frame-Options"], undefined);
  assertStringIncludes(
    h["Content-Security-Policy"]!,
    "frame-ancestors 'self' dash.corp",
  );
});

Deno.test("security: HSTS only behind an operator's own certificate", () => {
  // aio's --expose cert is a self-signed, name-constrained LOCAL CA. Pinning
  // HTTPS for a name on the strength of it outlives the app and the cert.
  assertEquals(
    securityHeaders(undefined, { secure: true, operatorCert: false })[
      "Strict-Transport-Security"
    ],
    undefined,
  );
  assertEquals(
    securityHeaders(undefined, { secure: false, operatorCert: true })[
      "Strict-Transport-Security"
    ],
    undefined,
  );
  assertEquals(
    securityHeaders(undefined, { secure: true, operatorCert: true })[
      "Strict-Transport-Security"
    ],
    "max-age=15552000",
  );
  assertEquals(
    securityHeaders({ hsts: "max-age=63072000; includeSubDomains" }, {
      secure: true,
      operatorCert: true,
    })["Strict-Transport-Security"],
    "max-age=63072000; includeSubDomains",
  );
  assertEquals(
    securityHeaders({ hsts: false }, { secure: true, operatorCert: true })[
      "Strict-Transport-Security"
    ],
    undefined,
  );
});

Deno.test("security: no Permissions-Policy is guessed", () => {
  // Restricting camera / mic / geolocation by default breaks the app that
  // uses them, and aio cannot know. Absent unless the app says.
  assertEquals(
    securityHeaders(undefined, {})["Permissions-Policy"],
    undefined,
  );
  assertEquals(
    securityHeaders({ permissionsPolicy: "camera=()" }, {})[
      "Permissions-Policy"
    ],
    "camera=()",
  );
});

Deno.test("security: `headers: false` is the pre-alpha72 behaviour, exactly", () => {
  assertEquals(securityHeaders({ headers: false }, {}), {});
});

Deno.test("security: every piece is individually switchable", () => {
  assertEquals(
    securityHeaders({ frameOptions: false }, {})["X-Frame-Options"],
    undefined,
  );
  assertEquals(
    securityHeaders({ csp: false }, {})["Content-Security-Policy"],
    undefined,
  );
  assertEquals(
    securityHeaders({ csp: "off" }, {})["Content-Security-Policy"],
    undefined,
  );
  assertEquals(
    securityHeaders({ referrerPolicy: "no-referrer" }, {})["Referrer-Policy"],
    "no-referrer",
  );
});

Deno.test("security: `csp: strict` locks down off-origin, and says so", () => {
  const csp = contentSecurityPolicy({ csp: "strict" }, "'self'")!;
  assertStringIncludes(csp, "default-src 'self'");
  assertStringIncludes(csp, "connect-src 'self' ws: wss:");
  assertStringIncludes(csp, "img-src 'self' data: blob:");
  // The served shell inlines its theme stylesheet and a two-line module
  // bootstrap, and app components set inline styles as a matter of course.
  // A strict policy that forbade those would blank the page.
  assertStringIncludes(csp, "script-src 'self' 'unsafe-inline'");
  assertStringIncludes(csp, "style-src 'self' 'unsafe-inline'");
});

Deno.test("security: a literal policy is used verbatim", () => {
  assertEquals(
    contentSecurityPolicy({ csp: "default-src 'none'" }, "'self'"),
    "default-src 'none'",
  );
});

Deno.test("security: the whole policy, spelled out", () => {
  // The one test that would catch a header appearing, vanishing or changing
  // without anyone deciding to. Every other case here checks one rule; this
  // checks the ANSWER.
  assertEquals(
    securityHeaders({ csp: "strict" }, {
      allowedOrigins: ["a.com"],
      secure: true,
      operatorCert: true,
    }),
    {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'self'; object-src 'none'; " +
        "frame-ancestors 'self' a.com; form-action 'self'; " +
        "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; " +
        "connect-src 'self' ws: wss:",
      "Strict-Transport-Security": "max-age=15552000",
    },
  );
});

// ── What `allowedOrigins` may contain, and what it must never produce ──

Deno.test("security: an origin that cannot be a CSP source is dropped, not spliced", () => {
  // `allowedOrigins` is app config, so it can hold an IDN hostname, a
  // zero-width character that survived `trim()`, or a stray comma. Splicing one
  // into the policy produces a value the runtime refuses — and since the header
  // set is applied to EVERY response, that is a 500 on everything, from a
  // config key whose only other job is to widen an allowlist.
  // Found by `scripts/audit-round.ts 5`.
  const nasty = [
    "\u00fcn\u00efc\u00f6d\u00e9.example", // IDN: not ASCII, cannot go in a header
    "\u200b\u200e", // zero-width + LRM: non-empty after trim(), invisible
    "a.com, b.com", // a comma splits the source list
    "a.com; script-src *", // a semicolon injects a DIRECTIVE
    "has space.com",
    "\nb.com",
  ];
  for (const bad of nasty) {
    const h = securityHeaders(undefined, { allowedOrigins: [bad] });
    const csp = h["Content-Security-Policy"]!;
    assertEquals(
      csp.includes(bad),
      false,
      `${JSON.stringify(bad)} reached the policy`,
    );
    // ...and whatever came out is a legal header value.
    new Headers({ "Content-Security-Policy": csp });
  }
});

Deno.test("security: the spellings that ARE valid all survive", () => {
  const good: [string, string][] = [
    ["dash.corp", "dash.corp"],
    ["https://dash.corp", "https://dash.corp"],
    ["https://dash.corp/", "https://dash.corp"],
    ["https://dash.corp/path", "https://dash.corp"],
    ["shell.internal:8080", "shell.internal:8080"],
    ["http://a.com:8080", "http://a.com:8080"],
    ["*.corp.example", "*.corp.example"],
    ["127.0.0.1:3000", "127.0.0.1:3000"],
    ["[::1]:3000", "[::1]:3000"],
    ["a.com:*", "a.com:*"],
  ];
  for (const [input, want] of good) {
    assertEquals(cspHostSource(input), want, input);
    assertStringIncludes(frameAncestors([input]), want);
  }
});

Deno.test("security: a header value that cannot be sent is refused AT BOOT", () => {
  // Not per response: `securityHeaders` runs once at server construction, so a
  // throw here is a boot error naming the key. A value that only fails when a
  // response is built is a 500 on everything with the cause nowhere near it.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  for (
    const cfg of [
      { permissionsPolicy: "camera=(\u00fcn\u00efc\u00f6d\u00e9)" },
      { permissionsPolicy: `camera=()${CR}${LF}X-Injected: yes` },
      { referrerPolicy: `no-referrer${LF}` },
    ]
  ) {
    const e = assertThrows(() => securityHeaders(cfg, {})) as Error;
    assertStringIncludes(e.message, "cannot go in an HTTP header");
    assertStringIncludes(e.message, "every response would fail");
  }
  // A legal value is untouched.
  assertEquals(
    securityHeaders({ permissionsPolicy: "camera=(), microphone=()" }, {})[
      "Permissions-Policy"
    ],
    "camera=(), microphone=()",
  );
});
