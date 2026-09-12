// Two CSP complaints, from two apps that had already read the source.
//
//  1. `base-uri 'self'` is in `"basic"` as one of "the directives that cannot
//     break a page". True of an app's OWN pages — and false of any page your
//     app SERVES that is not about your app: an archived document, a mirrored
//     page, a print preview, where the original `<base href>` is load-bearing
//     and dropping it rewrites every relative URL in the capture (report 5 §3).
//     Losing one directive meant writing the whole policy by hand, including
//     re-deriving `frame-ancestors` from `allowedOrigins` and keeping it in
//     sync forever.
//
//  2. The served shell inlines its own bootstrap, so `"strict"` had to keep
//     `script-src 'unsafe-inline'` — and a hardened wallet carried that as a
//     documented HIGH waiver (report 1 §11).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  contentSecurityPolicy,
  cspNonce,
  securityHeaders,
} from "../src/server/security-headers.ts";
import {
  generateHTML,
  withScriptNonce,
} from "../src/server/server-html-gen.ts";

const parse = (policy: string) =>
  Object.fromEntries(
    policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(" ");
      return i < 0 ? [d, ""] : [d.slice(0, i), d.slice(i + 1)];
    }),
  );

Deno.test("the default policy is unchanged", () => {
  // Everything below is opt-in; an app that writes no `security` block must
  // get byte-identical output.
  assertEquals(
    contentSecurityPolicy(undefined, "'self'"),
    "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
      "form-action 'self'",
  );
});

Deno.test("cspDirectives can DROP one directive and keep the rest", () => {
  const p = parse(
    contentSecurityPolicy(
      { cspDirectives: { "base-uri": false } },
      "'self'",
    )!,
  );
  assertEquals(p["base-uri"], undefined, "the one they asked to lose");
  assertEquals(p["object-src"], "'none'", "…and nothing else went with it");
  assertEquals(p["form-action"], "'self'");
  // `frame-ancestors` is the reason this exists rather than a verbatim policy:
  // it is DERIVED from allowedOrigins, and hand-writing the policy means
  // re-deriving it and keeping it in sync forever.
  assertEquals(p["frame-ancestors"], "'self'");
});

Deno.test("cspDirectives can widen or add one", () => {
  const p = parse(
    contentSecurityPolicy(
      {
        csp: "strict",
        cspDirectives: {
          "img-src": "'self' https:",
          "worker-src": "'self' blob:",
        },
      },
      "'self'",
    )!,
  );
  assertEquals(p["img-src"], "'self' https:", "replaced, not appended");
  assertEquals(p["worker-src"], "'self' blob:", "a directive aio never sends");
  assertEquals(p["default-src"], "'self'", "strict is otherwise untouched");
});

Deno.test("cspDirectives is IGNORED for a verbatim policy", () => {
  // An app that hands us a whole policy has already decided. Two ways to say
  // one thing, with one of them silent, is the shape this repo refuses.
  assertEquals(
    contentSecurityPolicy(
      { csp: "default-src 'none'", cspDirectives: { "base-uri": false } },
      "'self'",
    ),
    "default-src 'none'",
  );
});

Deno.test("dropping every directive sends no header at all", () => {
  assertEquals(
    contentSecurityPolicy({
      cspDirectives: {
        "base-uri": false,
        "object-src": false,
        "frame-ancestors": false,
        "form-action": false,
      },
    }, "'self'"),
    null,
    'an empty policy is not a policy — send nothing rather than `""`',
  );
});

Deno.test("a nonce replaces 'unsafe-inline' for SCRIPTS only", () => {
  const n = cspNonce();
  const p = parse(contentSecurityPolicy({ csp: "strict" }, "'self'", n)!);
  assertEquals(p["script-src"], `'self' 'nonce-${n}'`);
  assert(
    !p["script-src"]!.includes("unsafe-inline"),
    "the waiver is what the nonce exists to remove",
  );
  // STYLES KEEP IT. `style-src 'unsafe-inline'` also governs the `style=`
  // ATTRIBUTE, which `style={{…}}` produces on ordinary components — noncing
  // styles breaks most apps in exchange for a directive nobody asked about.
  assertStringIncludes(p["style-src"]!, "'unsafe-inline'");
});

Deno.test("without a nonce, strict keeps the waiver — a blocked shell is an outage", () => {
  const p = parse(contentSecurityPolicy({ csp: "strict" }, "'self'")!);
  assertStringIncludes(p["script-src"]!, "'unsafe-inline'");
});

Deno.test("a nonce carries nothing regex-special", () => {
  // `+` and `/` are valid in CSP and hostile everywhere else: a nonce with one
  // turns a downstream `new RegExp(nonce)` into a different pattern than its
  // author meant, on one run in a few.
  for (let i = 0; i < 200; i++) {
    assert(
      /^[A-Za-z0-9_-]+$/.test(cspNonce()),
      "a nonce must be base64URL — see cspNonce",
    );
  }
});

Deno.test("nonces are per-response, and unguessable", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(cspNonce());
  assertEquals(seen.size, 200, "a reused nonce is a replayable nonce");
  const n = cspNonce();
  assert(n.length >= 20, `128 bits of base64, got ${n.length} chars: ${n}`);
});

Deno.test("EVERY script in the shell carries the nonce — a missed one is a blank page", () => {
  // Under `script-src 'nonce-…'` an unnamed inline script does not run at all.
  // So this counts tags rather than checking the ones I remembered.
  const n = cspNonce();
  for (const prod of [false, true]) {
    const html = generateHTML({
      title: "t",
      hasCSS: false,
      prod,
      importMap: "{}",
      headExtra: "<script>window.appOwn=1</script>",
      nonce: n,
    });
    const tags = html.match(/<script\b/g) ?? [];
    // SPLIT, not a RegExp built from the nonce. A nonce is base64url now
    // precisely so it carries no regex-special character — and a test that
    // relied on that would be one edit away from passing for the wrong
    // reason, intermittently.
    const nonced = { length: html.split(`<script nonce="${n}"`).length - 1 };
    assert(tags.length > 0, `prod=${prod}: no scripts to check`);
    assertEquals(
      nonced.length,
      tags.length,
      `prod=${prod}: ${tags.length - nonced.length} script(s) would not run`,
    );
  }
});

Deno.test("no nonce asked for: the shell is byte-identical", () => {
  const opts = { title: "t", hasCSS: false, prod: true, importMap: "{}" };
  assert(!generateHTML(opts).includes("nonce="));
});

Deno.test("withScriptNonce leaves an existing nonce alone", () => {
  assertEquals(
    withScriptNonce('<script nonce="already">x</script>', "new"),
    '<script nonce="already">x</script>',
  );
  // …and a quote in the nonce cannot break out of the attribute.
  assert(!withScriptNonce("<script>x</script>", 'a"b').includes('"a"b"'));
});

Deno.test("the header builder still ships the policy it computed", () => {
  const h = securityHeaders({ cspDirectives: { "base-uri": false } }, {
    allowedOrigins: undefined,
    secure: false,
    operatorCert: false,
  });
  assert(!h["Content-Security-Policy"]!.includes("base-uri"));
  assertStringIncludes(h["Content-Security-Policy"]!, "object-src 'none'");
});

// ── the nonce COMPOSES with the app's own directives ──────────────────────
// A wallet needed one extra script host AND the nonce. The override won
// whole, so it was one or the other; and the nonce is per-response, so it
// could not be written by hand. Now a `script-src` you write gets the nonce
// appended, `{nonce}` names it anywhere, and a placeholder with no nonce to
// fill it is refused instead of shipping a policy that blocks everything.
Deno.test("cspNonce + a user script-src: the host AND the nonce, not one or the other", () => {
  const n = cspNonce();
  const p = parse(
    contentSecurityPolicy(
      {
        csp: "strict",
        cspNonce: true,
        cspDirectives: { "script-src": "'self' https://cdn.example.com" },
      } as never,
      "'none'",
      n,
    )!,
  );
  assertStringIncludes(p["script-src"]!, "https://cdn.example.com");
  assertStringIncludes(p["script-src"]!, `'nonce-${n}'`);
  assert(!p["script-src"]!.includes("'unsafe-inline'"));
});
Deno.test("{nonce} names the per-response nonce in ANY directive", () => {
  const n = cspNonce();
  const p = parse(
    contentSecurityPolicy(
      {
        csp: "strict",
        cspNonce: true,
        cspDirectives: {
          "style-src": "'self' {nonce}",
          "script-src": "{nonce} 'self'",
        },
      } as never,
      "'none'",
      n,
    )!,
  );
  assertEquals(p["style-src"], `'self' 'nonce-${n}'`);
  assertEquals(p["script-src"], `'nonce-${n}' 'self'`);
});
Deno.test("a {nonce} placeholder with cspNonce OFF is refused — a literal one blocks every script", () => {
  let err = "";
  try {
    contentSecurityPolicy(
      {
        csp: "strict",
        cspDirectives: { "script-src": "'self' {nonce}" },
      } as never,
      "'none'",
    );
  } catch (e) {
    err = String(e);
  }
  assertStringIncludes(err, "cspNonce");
});
Deno.test("without a nonce, a user script-src is taken verbatim (nothing appended)", () => {
  const p = parse(
    contentSecurityPolicy(
      {
        csp: "strict",
        cspDirectives: { "script-src": "'self' https://x" },
      } as never,
      "'none'",
    )!,
  );
  assertEquals(p["script-src"], "'self' https://x");
});
