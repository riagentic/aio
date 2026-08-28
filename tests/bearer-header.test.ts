// `Authorization: Bearer` had THREE readers, each spelling the rule for itself
// — the general extractor, the auth-flow resolver, and the shared-key path.
// Three chances to drift on the one header where drifting means
// "authenticated here, anonymous there".
//
// And all three were exact-match on `"Bearer "`. RFC 7235 makes `auth-scheme`
// a token, and tokens are case-insensitive, so a client sending
// `bearer <token>` — which some HTTP libraries do — presented a perfectly good
// credential and was read as anonymous. It fails CLOSED, which is why nobody
// noticed: the symptom is "your token doesn't work", not a breach.
import { assertEquals } from "@std/assert";
import {
  _extractTokenWithSource,
  bearerToken,
} from "../src/server/server-auth.ts";

/** Every source file under a directory. At module scope, not inside the test:
 *  a generator declared in the body hides the assertion below it from
 *  `check:vacuous`'s block reader — and a helper is not part of the claim. */
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

const withAuth = (v: string) =>
  new Request("http://x/", { headers: { authorization: v } });

Deno.test("bearerToken: the scheme is case-insensitive, as the RFC says", () => {
  for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
    assertEquals(bearerToken(withAuth(`${scheme} abc123`)), "abc123", scheme);
  }
});

Deno.test("bearerToken: whitespace around the token is not part of it", () => {
  assertEquals(bearerToken(withAuth("Bearer  abc123")), "abc123");
  assertEquals(bearerToken(withAuth("Bearer\tabc123")), "abc123");
  assertEquals(bearerToken(withAuth("  Bearer abc123  ")), "abc123");
});

Deno.test("bearerToken: anything that is not a bearer credential is null", () => {
  // A different scheme is a different credential — reading its payload as a
  // bearer token would authenticate something nobody presented.
  assertEquals(bearerToken(withAuth("Basic dXNlcjpwYXNz")), null);
  assertEquals(bearerToken(withAuth("Bearer")), null, "no token at all");
  assertEquals(bearerToken(withAuth("Bearer ")), null, "empty token");
  assertEquals(bearerToken(withAuth("Bearerabc")), null, "not the scheme");
  assertEquals(bearerToken(withAuth("")), null);
  assertEquals(bearerToken(new Request("http://x/")), null, "no header");
});

Deno.test("the general extractor reads the header through the same rule", () => {
  // The drift this consolidation removes: the extractor must agree with
  // `bearerToken` about what a header-borne credential is, because the SOURCE
  // decides what a token is allowed to authenticate.
  const r = _extractTokenWithSource(
    new URL("http://x/"),
    withAuth("bearer abc123"),
  );
  assertEquals(r.token, "abc123");
  assertEquals(r.source, "header");
  assertEquals(r.fromUrl, false);
});

Deno.test("a URL token still outranks a header one", () => {
  // Precedence is a separate rule and must survive the refactor: `?token=` is
  // the deliberate, visible credential and wins.
  const r = _extractTokenWithSource(
    new URL("http://x/?token=fromurl"),
    withAuth("Bearer fromheader"),
  );
  assertEquals(r.token, "fromurl");
  assertEquals(r.source, "url");
  assertEquals(r.fromUrl, true);
});

// A gate, not just a fix. The consolidation missed a FOURTH reader on the
// trojan listener — whose own comment said "same rules as main server" while
// spelling the rule for itself, so `bearer <token>` was accepted by the app
// and refused by its control plane. A half-done consolidation leaves exactly
// the drift it set out to remove, so the rule is now the gate.
//
// The rule is about READING, not sending: a client that BUILDS
// `Authorization: Bearer <t>` is the other direction and is fine. So the test
// is "whoever reads the authorization header parses it with `bearerToken`".
Deno.test("whoever reads the authorization header uses the ONE reader", async () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const strays: string[] = [];
  for await (const f of walk(root)) {
    const rel = f.slice(root.length).replace(/^\/+/, "");
    if (rel === "server/server-auth.ts") continue; // the home
    const src = await Deno.readTextFile(f);
    if (!/headers\.get\(\s*["'`]authorization["'`]/i.test(src)) continue;
    // An AD-HOC parse is the offence, whether or not the file also imports the
    // real reader — merely MENTIONING `bearerToken` (an import line) proved
    // nothing, and a mutation test caught this gate passing a file that had
    // grown its own parse right beside the import.
    const adHoc = /startsWith\(\s*["'`][Bb]earer\s|\.slice\(\s*7\s*\)/.test(
      src,
    );
    if (!adHoc && src.includes("bearerToken(")) continue;
    const line =
      src.slice(0, src.search(/headers\.get\(\s*["'`]authorization["'`]/i))
        .split("\n").length;
    strays.push(`src/${rel}:${line}`);
  }
  assertEquals(
    strays,
    [],
    `these read the authorization header without the one reader. Use ` +
      `bearerToken(req) from server-auth.ts — it is case-insensitive, as RFC ` +
      `7235 requires the scheme to be:\n  ` + strays.join("\n  "),
  );
});
