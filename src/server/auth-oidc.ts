// auth-oidc.ts — OpenID Connect login (AUTH-3): authorization code + PKCE.
//
//   auth: { oidc: { issuer, clientId, clientSecret? } }
//
//   GET /__aio/auth/oidc/start     → 302 to the provider (state + PKCE S256)
//   GET /__aio/auth/oidc/callback  → code→token exchange, ID-token verify
//                                    (JWKS RS256), session + cookie, 302 "/"
//
// Config-only: discovery from `<issuer>/.well-known/openid-configuration`,
// JWKS fetched and cached (1h), signature verified with WebCrypto. The state
// is a one-shot stored token (10-min TTL) carrying the PKCE verifier — replay
// and CSRF die there. External identities get a users row (never password-
// verifiable) so role management and admin listing see them.

import type { UserStore } from "./auth-users.ts";
import type { SessionStore } from "./sessions.ts";
import type { AioUser } from "./aio-types.ts";

export interface OidcConfig {
  /** Provider issuer URL, e.g. "https://accounts.google.com". */
  issuer: string;
  clientId: string;
  /** Confidential-client secret; omit for a pure-PKCE public client. */
  clientSecret?: string;
  /** Map verified ID-token claims → role for NEW users (default "user").
   *  Existing users keep their stored role — promotions happen server-side. */
  role?: (claims: Record<string, unknown>) => string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const CACHE_MS = 3_600_000;
const _discovery = new Map<string, { d: Discovery; at: number }>();
const _jwks = new Map<string, { keys: JsonWebKey[]; at: number }>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = _discovery.get(issuer);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.d;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`oidc discovery failed: ${resp.status}`);
  const d = await resp.json() as Discovery;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
    throw new Error("oidc discovery incomplete");
  }
  _discovery.set(issuer, { d, at: Date.now() });
  return d;
}

/** THE key-selection rule, extracted so it can be tested without an issuer.
 *  A declared `kid` must MATCH; only a token that declares none may fall back
 *  to a sole published key. @internal */
export function _selectJwk<T>(
  keys: T[],
  kid: string | undefined,
): T | undefined {
  if (kid !== undefined) {
    return keys.find((k) => (k as { kid?: string }).kid === kid);
  }
  return keys.length === 1 ? keys[0] : undefined;
}

async function jwksKeys(jwksUri: string): Promise<JsonWebKey[]> {
  const hit = _jwks.get(jwksUri);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.keys;
  const resp = await fetch(jwksUri);
  if (!resp.ok) throw new Error(`jwks fetch failed: ${resp.status}`);
  const { keys } = await resp.json() as { keys: JsonWebKey[] };
  _jwks.set(jwksUri, { keys: keys ?? [], at: Date.now() });
  return keys ?? [];
}

/** Test isolation — drop discovery/JWKS caches. */
export function _resetOidcCaches(): void {
  _discovery.clear();
  _jwks.clear();
}

/** Verify an RS256 ID token against the issuer's JWKS. Returns claims. */
export async function verifyIdToken(
  idToken: string,
  cfg: OidcConfig,
  jwksUri: string,
): Promise<Record<string, unknown>> {
  const [h, p, sig] = idToken.split(".");
  if (!h || !p || !sig) throw new Error("oidc_bad_token");
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256") throw new Error("oidc_alg_unsupported");
  const keys = await jwksKeys(jwksUri);
  // `kid` binds a token to the key that signed it. The old `|| keys.length === 1`
  // dropped that binding whenever the issuer happened to publish one key: any
  // token verified against the sole key regardless of the kid it declared.
  // Signature verification still ran (a wrong key fails), so this was never an
  // auth bypass — but the binding is what makes key ROTATION meaningful, and
  // "correct until the issuer adds a second key" is not a property worth
  // having. A key set with no kid at all is still matched by position, because
  // some issuers publish none and refusing them would break a working setup.
  const jwk = _selectJwk(keys, header.kid);
  if (!jwk) throw new Error("oidc_unknown_kid");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(sig) as BufferSource,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new Error("oidc_bad_signature");
  const claims = JSON.parse(
    new TextDecoder().decode(b64urlDecode(p)),
  ) as Record<string, unknown>;
  const iss = String(claims.iss ?? "").replace(/\/$/, "");
  if (iss !== cfg.issuer.replace(/\/$/, "")) throw new Error("oidc_bad_iss");
  const aud = claims.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(cfg.clientId)
    : aud === cfg.clientId;
  if (!audOk) throw new Error("oidc_bad_aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("oidc_expired");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new Error("oidc_no_sub");
  }
  return claims;
}

/** Prefix marking a users row as an EXTERNAL (IdP-owned) identity. */
export const OIDC_ID_PREFIX = "oidc:";

/** EXTERNAL IDENTITIES ARE A DIFFERENT NAMESPACE FROM LOCAL ONES.
 *
 *  The callback used to key the account on `claims.sub` alone
 *  (`users.get(claims.sub)`), so an IdP account whose `sub` happened to equal
 *  a local username WAS that user: a session was issued for the local account
 *  without ever consulting its `totpEnabled` or `verified` state — an SSO
 *  login walked straight past a second factor the owner had enrolled — and the
 *  local row's email was rewritten to the IdP-supplied one, handing over the
 *  password-reset channel permanently. `sub` is only unique WITHIN an issuer,
 *  and plenty of providers (Keycloak mappers, LDAP bridges, self-hosted IdPs)
 *  mint username- or email-shaped subs, so a collision is a configuration
 *  away, not a coincidence.
 *
 *  The id therefore carries its origin: `oidc:<issuer-without-scheme>:<sub>`.
 *  Two identities from different issuers cannot collide, and no OIDC login can
 *  ever land on a local account — the namespaces do not overlap. Linking an
 *  SSO identity to an existing local account is a deliberate, verified step
 *  that does not exist yet; silently adopting one was never that step. */
export function externalId(issuer: string, sub: string): string {
  const iss = issuer.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `${OIDC_ID_PREFIX}${iss}:${sub}`;
}

/** True when a users row belongs to an external identity provider — it has no
 *  usable password, so password-shaped flows (reset) must skip it. */
export const isExternalId = (id: string): boolean =>
  id.startsWith(OIDC_ID_PREFIX);

export interface OidcDeps {
  cfg: OidcConfig;
  users: UserStore;
  sessions: SessionStore;
  ttlMs?: number;
  cookie: (token: string) => string;
  /** TLS active — mark the binder cookie Secure. */
  secure?: boolean;
}

/** GET /__aio/auth/oidc/start — redirect to the provider. */
const OIDC_BINDER_COOKIE = "aio_oidc";

/** Hex SHA-256 of a string (browser-binder hash). */
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read the one-shot OIDC binder cookie from the callback request. */
function oidcBinderFromCookie(req: Request): string | null {
  const cookies = req.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === OIDC_BINDER_COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Same-site path only ("/orders/7") — anything else (absolute URLs,
 *  protocol-relative "//evil") would be an open redirect. */
const safePath = (p: string | null): string => {
  // Same-site absolute path only. A browser's URL parser STRIPS ASCII control
  // chars (tab/newline/etc.) and rewrites "\"→"/" BEFORE resolving a Location
  // header, so "/\evil", "//evil", AND "/\t/evil" all normalize to a
  // protocol-relative URL → https://evil (open redirect). Require: starts with
  // "/", second char is not "/" or "\", and NO control char anywhere (which a
  // browser could delete to expose "//"). Anything else → "/".
  if (!p || p[0] !== "/") return "/";
  if (p[1] === "/" || p[1] === "\\") return "/";
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return "/"; // C0 controls + DEL
  }
  return p;
};

export async function oidcStart(
  req: Request,
  deps: OidcDeps,
): Promise<Response> {
  const d = await discover(deps.cfg.issuer);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      ),
    ),
  );
  const self = new URL(req.url);
  // CSRF / session-fixation defense: bind this login attempt to THIS browser.
  // A random binder is set as a cookie; only its hash rides in the server-side
  // state. The callback requires the cookie to hash-match — so an attacker
  // can't start their own flow and feed the resulting (code,state) to a
  // victim (which would log the victim into the ATTACKER's account). SameSite
  // is Lax (not Strict): the provider redirect back is a cross-site top-level
  // navigation, and Strict would drop the cookie. `nonce` binds the ID token
  // to this request, defeating token replay.
  const binder = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = deps.users.issueToken(
    "oidc",
    "state",
    10 * 60_000,
    JSON.stringify({
      v: verifier,
      r: safePath(self.searchParams.get("redirect")),
      b: await sha256hex(binder),
      n: nonce,
    }),
  );
  const redirectUri = `${self.origin}/__aio/auth/oidc/callback`;
  const auth = new URL(d.authorization_endpoint);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", deps.cfg.clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", "openid profile email");
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", nonce);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      "Set-Cookie": `${OIDC_BINDER_COOKIE}=${binder}; Path=/__aio/auth/oidc` +
        `; HttpOnly; SameSite=Lax; Max-Age=600${deps.secure ? "; Secure" : ""}`,
    },
  });
}

/** GET /__aio/auth/oidc/callback — exchange, verify, session, redirect. */
export async function oidcCallback(
  req: Request,
  url: URL,
  deps: OidcDeps,
): Promise<Response> {
  const err = url.searchParams.get("error");
  if (err) return new Response(`OIDC error: ${err}`, { status: 400 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return new Response("missing code/state", { status: 400 });
  }
  const stored = deps.users.consumeToken("oidc", state);
  if (!stored) return new Response("invalid or expired state", { status: 400 });
  const { v: verifier, r: returnTo, b: binderHash, n: nonce } = JSON.parse(
    stored.payload!,
  ) as { v: string; r: string; b?: string; n?: string };
  // The browser must present the binder cookie that hash-matches this state —
  // otherwise this callback was started by someone else (login CSRF).
  const binder = oidcBinderFromCookie(req);
  if (!binderHash || !binder || (await sha256hex(binder)) !== binderHash) {
    return new Response("state not bound to this browser", { status: 400 });
  }

  const d = await discover(deps.cfg.issuer);
  const redirectUri = `${url.origin}/__aio/auth/oidc/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: deps.cfg.clientId,
    code_verifier: verifier,
    ...(deps.cfg.clientSecret ? { client_secret: deps.cfg.clientSecret } : {}),
  });
  const tokenResp = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResp.ok) {
    console.warn(
      `[aio] auth: oidc token exchange failed (${tokenResp.status})`,
    );
    return new Response("token exchange failed", { status: 502 });
  }
  const { id_token } = await tokenResp.json() as { id_token?: string };
  if (!id_token) return new Response("no id_token", { status: 502 });

  let claims: Record<string, unknown>;
  try {
    claims = await verifyIdToken(id_token, deps.cfg, d.jwks_uri);
  } catch (e) {
    console.warn(`[aio] auth: oidc id_token rejected — ${e}`);
    return new Response("invalid id_token", { status: 401 });
  }
  // Nonce binds the token to THIS /start (anti-replay). Providers echo it;
  // require a match when we sent one.
  if (nonce && claims.nonce !== nonce) {
    console.warn(`[aio] auth: oidc nonce mismatch`);
    return new Response("invalid id_token", { status: 401 });
  }

  // Stable identity = (issuer, sub), namespaced — see `externalId`. Existing
  // users keep their stored role (server-side promotions survive re-login);
  // new users get cfg.role(claims) ?? "user".
  const sub = claims.sub as string;
  const id = externalId(deps.cfg.issuer, sub);
  if (id.length > 256) {
    console.warn(`[aio] auth: oidc subject too long for an account id`);
    return new Response("invalid id_token", { status: 401 });
  }
  const email = typeof claims.email === "string" ? claims.email : undefined;
  let user: AioUser;
  const existing = deps.users.get(id);
  // A local account that merely SHARES the sub is a different account, and
  // stays one. Say so out loud: before the namespace fix this login adopted
  // it, so an operator upgrading needs to know why an SSO user who used to
  // land on "alice" now lands on a fresh account.
  if (!existing && deps.users.get(sub)) {
    console.warn(
      `[aio] auth: oidc login for sub="${sub}" maps to id="${id}" — a ` +
        `separate local account named "${sub}" exists and is NOT adopted ` +
        `(external identities are their own namespace; linking is not ` +
        `automatic). Grant it access with \`am auth role "${id}" <role>\`.`,
    );
  }
  if (existing) {
    user = { id: existing.id, role: existing.role };
    // Only ever for an account this namespace owns (never a local one — it is
    // unreachable from here now), and never silently.
    if (email && existing.email !== email) {
      console.warn(
        `[aio] auth: oidc updated the email on id="${id}" (provider claim)`,
      );
      deps.users.setEmail(id, email);
    }
  } else {
    const role = deps.cfg.role?.(claims) ?? "user";
    // External identity — random unusable password (never password-verifiable).
    const rnd = b64url(crypto.getRandomValues(new Uint8Array(24)));
    try {
      const rec = await deps.users.create(id, rnd, { role, email });
      deps.users.markVerified(id); // provider vouched for the email
      user = { id: rec.id, role: rec.role };
    } catch (e) {
      // The id rules (length, no invisible characters) are the store's, and a
      // provider can mint a sub that breaks them. Refuse the login loudly
      // rather than 500 on a half-created account.
      console.warn(
        `[aio] auth: oidc account creation refused for "${id}" — ${e}`,
      );
      return new Response("invalid id_token", { status: 401 });
    }
  }
  const token = deps.sessions.issue(user, { ttlMs: deps.ttlMs });
  const headers = new Headers({
    Location: safePath(returnTo),
    // Identity-bearing (it hands out a session cookie) — never cached.
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", deps.cookie(token));
  // Clear the one-shot binder cookie.
  headers.append(
    "Set-Cookie",
    `${OIDC_BINDER_COOKIE}=; Path=/__aio/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return new Response(null, { status: 302, headers });
}
