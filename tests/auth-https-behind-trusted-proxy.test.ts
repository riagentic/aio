// Behind the TLS-terminating proxy `docs/auth/auth.md` prescribes, the auth
// flows must know the BROWSER is on https.
//
// They read only "does this process terminate TLS" — false behind the proxy —
// so every session cookie went out without `Secure`, and the OIDC
// `redirect_uri` was built as `http://<host>/__aio/auth/oidc/callback`, which
// Google, Entra and most providers refuse for a non-loopback host: SSO could
// not work behind the documented deployment at all, and no setting fixed it.
//
// With `trustProxyHeader` set (the operator says a proxy fronts the app), the
// proxy's `X-Forwarded-Proto: https` now marks the cookies Secure and makes the
// redirect_uri https. Without that setting the header is not read.
import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
} from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";
import { mockIdp } from "./oidc-mock-idp-helper.ts";

const PROXIED = {
  "x-forwarded-for": "203.0.113.7",
  "x-forwarded-proto": "https",
};

async function run(trust: boolean, redirectUri?: string) {
  _resetOidcCaches();
  // The one-time "register this redirect_uri" warning (console.warn is the
  // logger's warn sink).
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.join(" "));
    origWarn(...a);
  };
  const idp = await mockIdp();
  const srv = await testServer({
    ...(trust ? { trustProxyHeader: "x-forwarded-for" } : {}),
    cells: [
      cell(`proxy_https_${trust}`, { state: {}, visible: "all", methods: {} }),
    ],
    auth: {
      oidc: {
        issuer: idp.issuer,
        clientId: "app1",
        ...(redirectUri ? { redirectUri } : {}),
      },
    },
  });
  try {
    const start = await fetch(`${srv.url}/__aio/auth/oidc/start`, {
      redirect: "manual",
      headers: PROXIED,
    });
    await start.body?.cancel();
    const loc = new URL(start.headers.get("location")!);
    const binder = start.headers.getSetCookie()[0]!;
    idp.state.claims = { sub: "s1" };
    idp.state.nonce = loc.searchParams.get("nonce")!;
    const cb = await fetch(
      `${srv.url}/__aio/auth/oidc/callback?code=x&state=${
        encodeURIComponent(loc.searchParams.get("state")!)
      }`,
      {
        redirect: "manual",
        headers: { ...PROXIED, cookie: binder.split(";")[0]! },
      },
    );
    await cb.body?.cancel();
    const signup = await fetch(`${srv.url}/__aio/auth/signup`, {
      method: "POST",
      headers: PROXIED,
      body: JSON.stringify({ id: "alice", password: "password123" }),
    });
    await signup.body?.cancel();
    // A second /start: the warning is said once, not per login.
    const again = await fetch(`${srv.url}/__aio/auth/oidc/start`, {
      redirect: "manual",
      headers: PROXIED,
    });
    await again.body?.cancel();
    return {
      registerWarnings: warnings.filter((w) =>
        w.includes("Register exactly this URI")
      ),
      redirectUri: loc.searchParams.get("redirect_uri")!,
      binder,
      oidcSession: cb.headers.getSetCookie().find((c) =>
        c.startsWith("aio_session")
      ) ?? "",
      cbStatus: cb.status,
      signupCookie: signup.headers.getSetCookie()[0] ?? "",
      host: new URL(srv.url).host,
    };
  } finally {
    console.warn = origWarn;
    await srv.close();
    await idp.close();
  }
}

Deno.test("auth behind a trusted TLS proxy: https redirect_uri, Secure cookies", async () => {
  const r = await run(true);
  assertEquals(
    r.redirectUri,
    `https://${r.host}/__aio/auth/oidc/callback`,
    "the provider is handed the https callback the browser can reach",
  );
  assert(/;\s*Secure/.test(r.binder), `binder cookie: ${r.binder}`);
  assertEquals(r.cbStatus, 302, "the callback completes with the same uri");
  assert(/;\s*Secure/.test(r.oidcSession), `SSO session: ${r.oidcSession}`);
  assertEquals(r.registerWarnings.length, 1, "said once, at the first /start");
  assert(
    r.registerWarnings[0]!.includes(r.redirectUri),
    `names the exact uri: ${r.registerWarnings[0]}`,
  );
  assert(
    /;\s*Secure/.test(r.signupCookie),
    `password session: ${r.signupCookie}`,
  );
});

Deno.test("auth without trustProxyHeader: X-Forwarded-Proto is not read", async () => {
  const r = await run(false);
  assertEquals(r.redirectUri, `http://${r.host}/__aio/auth/oidc/callback`);
  assertFalse(/Secure/.test(r.binder), r.binder);
  assertFalse(/Secure/.test(r.signupCookie), r.signupCookie);
  assertEquals(r.registerWarnings, [], "nothing changed, nothing to say");
});

Deno.test("auth.oidc.redirectUri: sent verbatim, the proxy scheme ignored", async () => {
  // The URI an existing provider registration already has — http, behind a
  // proxy that says https. Kept exactly; no "register the new one" warning.
  const kept = "http://app.example.test/__aio/auth/oidc/callback";
  const r = await run(true, kept);
  assertEquals(r.redirectUri, kept);
  assertEquals(r.cbStatus, 302, "the callback completes with the same uri");
  assertEquals(r.registerWarnings, [], "an explicit uri needs no warning");
});

Deno.test("auth.oidc.redirectUri: a non-URL is refused at boot", async () => {
  for (const bad of ["/__aio/auth/oidc/callback", "ftp://x/cb", "", 42]) {
    const err = await assertRejects(() =>
      testServer({
        cells: [
          cell("oidc_bad_uri", { state: {}, visible: "all", methods: {} }),
        ],
        auth: {
          oidc: {
            issuer: "http://127.0.0.1:9/",
            clientId: "app1",
            redirectUri: bad as string,
          },
        },
      })
    );
    assertMatch(String(err), /invalid aio\.run\(\) configuration/, `${bad}`);
  }
});
