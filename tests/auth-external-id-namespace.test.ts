// ACCOUNT PRE-HIJACKING: a local signup must not be able to claim an id in the
// EXTERNAL (IdP-owned) namespace.
//
// `externalId()` exists so that "no OIDC login can ever land on a local
// account — the namespaces do not overlap" (auth-oidc.ts). The barrier was
// only ever enforced from the OIDC side. `POST /__aio/auth/signup` is open by
// default and its id was checked for length and invisible characters only, so
// an ANONYMOUS caller could take the other side of the same collision:
//
//   1. signup { id: "oidc:<issuer>:<victim-sub>", password: "known" } → 201
//   2. the real SSO user signs in → `users.get(id)` finds that row and the
//      callback issues a session for it (no new account, `role(claims)` never
//      consulted)
//   3. the attacker's password still opens it — measured: 200 + a session for
//      the SSO identity, indefinitely, with no access to the IdP at all.
//
// The reserved namespace is now the store's rule (one decider, so `am auth
// add` and `app.auth.create` answer the same way), with an explicit
// `{ external: true }` for the one caller that owns it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { _resetOidcCaches } from "../src/server/auth-oidc.ts";

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function mockIdp() {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", kp.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state = { claims: {} as Record<string, unknown>, nonce: "" };
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (u.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (u.pathname === "/token") {
        await req.text();
        const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
        const p = b64u(JSON.stringify({
          iss: issuer,
          aud: "app1",
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: state.nonce,
          ...state.claims,
        }));
        const sig = new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            kp.privateKey,
            new TextEncoder().encode(`${h}.${p}`),
          ),
        );
        return Response.json({ id_token: `${h}.${p}.${b64u(sig)}` });
      }
      return new Response("nf", { status: 404 });
    },
  );
  return { issuer, port, state, close: () => server.shutdown() };
}

type Idp = Awaited<ReturnType<typeof mockIdp>>;

async function oidcLogin(url: string, idp: Idp, sub: string) {
  idp.state.claims = { sub };
  const s = await fetch(`${url}/__aio/auth/oidc/start`, { redirect: "manual" });
  await s.body?.cancel();
  if (s.status !== 302) return { status: s.status, user: null };
  const loc = new URL(s.headers.get("location")!);
  const binder = s.headers.getSetCookie()[0]!.split(";")[0]!;
  idp.state.nonce = loc.searchParams.get("nonce")!;
  const cb = await fetch(
    `${url}/__aio/auth/oidc/callback?code=x&state=${
      encodeURIComponent(loc.searchParams.get("state")!)
    }`,
    { redirect: "manual", headers: { cookie: binder } },
  );
  await cb.body?.cancel();
  const sess = cb.headers.getSetCookie().find((c) =>
    c.startsWith("aio_session")
  )?.split(";")[0];
  if (!sess) return { status: cb.status, user: null };
  const me = await fetch(`${url}/__aio/auth/me`, { headers: { cookie: sess } });
  return {
    status: cb.status,
    user: (await me.json()).user as { id: string; role: string } | null,
  };
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body) });

Deno.test("auth: a signup cannot claim an id in the external (oidc:) namespace", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("r5c_ext1", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const victimId = `oidc:127.0.0.1:${idp.port}:victim-sub`;

    // 1. The anonymous land-grab is refused, and leaves no row behind.
    const su = await post(srv.url, "/__aio/auth/signup", {
      id: victimId,
      password: "attacker-pw-123",
    });
    assertEquals(su.status, 400, "signup into the IdP namespace must refuse");
    assertEquals((await su.json()).error, "reserved_id");
    assertEquals(
      srv.app.auth!.get(victimId),
      null,
      "…and no account exists under the victim's SSO id",
    );

    // 2. The real SSO login still works, and owns the id.
    const r = await oidcLogin(srv.url, idp, "victim-sub");
    assertEquals(r.status, 302);
    assertEquals(r.user, { id: victimId, role: "user" });

    // 3. No password the attacker chose opens it — the row has the unusable
    //    random password the callback minted.
    const li = await post(srv.url, "/__aio/auth/login", {
      id: victimId,
      password: "attacker-pw-123",
    });
    assertEquals(li.status, 401, "the attacker's password must not log in");
    await li.body?.cancel();

    // 4. The same rule for the programmatic/CLI door (`am auth add`).
    const thrown = await srv.app.auth!.create(victimId + "2", "another-pw-123")
      .then(() => null, (e: unknown) => String(e));
    assert(
      thrown?.includes("reserved_id"),
      `app.auth.create must refuse too, got ${thrown}`,
    );
    // …and an ordinary local id is untouched.
    const ok = await srv.app.auth!.create("plainuser", "another-pw-123");
    assertEquals(ok.id, "plainuser");
  } finally {
    await idp.close();
  }
});

// …AND THE NAMESPACE IS RESERVED UNDER THE FOLDING THAT DECIDES UNIQUENESS.
//
// Account ids are unique CASE-INSENSITIVELY (`selCi`, `COLLATE NOCASE`) —
// `Neighbour` cannot join `neighbour` — while lookups stay exact. The
// reservation, though, was `id.startsWith("oidc:")`: case-SENSITIVE. So the
// land-grab came back one shift key later. `OIDC:<issuer>:<sub>` passed the
// reservation, and then collided with the real SSO id at the uniqueness
// check, where nothing can be done about it any more:
//
//   1. signup { id: "OIDC:<issuer>:<victim-sub>", password: … } → 201
//   2. the victim's first SSO login: `users.get("oidc:…")` is EXACT, so it
//      misses the squatted row, the callback creates the account — and
//      `selCi` refuses it as a duplicate. The callback answers 401.
//   3. …on every login, forever. An anonymous request took an SSO identity
//      out of service permanently, and the operator sees an account that
//      LOOKS like the SSO one in `am auth users`.
//
// One decider, one folding: what uniqueness treats as the same id, the
// reservation must treat as the same namespace.
Deno.test("auth: the external namespace is reserved in EVERY case, as uniqueness is", async () => {
  _resetOidcCaches();
  const idp = await mockIdp();
  try {
    await using srv = await testServer({
      cells: [
        cell("r6a_ext2", { state: { n: 0 }, visible: "all", methods: {} }),
      ],
      auth: { oidc: { issuer: idp.issuer, clientId: "app1" } },
    });
    const realId = `oidc:127.0.0.1:${idp.port}:victim2-sub`;

    for (const squat of ["OIDC:", "Oidc:", "oIdC:"]) {
      const id = squat + realId.slice("oidc:".length);
      const su = await post(srv.url, "/__aio/auth/signup", {
        id,
        password: "attacker-pw-123",
      });
      const body = await su.json();
      assertEquals(
        su.status,
        400,
        `signup as "${id}" must refuse — it is the same account as ` +
          `"${realId}" to the uniqueness check`,
      );
      assertEquals(body.error, "reserved_id");
      assertEquals(
        srv.app.auth!.get(id),
        null,
        `…and left no row behind for "${id}"`,
      );
    }

    // The victim's SSO login is unharmed: it creates its own account.
    const r = await oidcLogin(srv.url, idp, "victim2-sub");
    assertEquals(r.status, 302, "the SSO login must not be deniable");
    assertEquals(r.user, { id: realId, role: "user" });

    // The programmatic door answers the same way.
    const thrown = await srv.app.auth!
      .create(`OIDC:127.0.0.1:${idp.port}:other`, "another-pw-123")
      .then(() => null, (e: unknown) => String(e));
    assert(
      thrown?.includes("reserved_id"),
      `app.auth.create must refuse the folded namespace too, got ${thrown}`,
    );
    // An id that merely CONTAINS the prefix, or starts with something that is
    // not it, stays an ordinary local account.
    for (const fine of ["oidcuser", "my-oidc:thing", "OIDCX:a"]) {
      assertEquals(
        (await srv.app.auth!.create(fine, "another-pw-123")).id,
        fine,
      );
    }
  } finally {
    await idp.close();
  }
});
