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
  const jwk = keys.find((k) =>
    (k as { kid?: string }).kid === header.kid || keys.length === 1
  );
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

  // Stable identity = sub. Existing users keep their stored role (server-side
  // promotions survive re-login); new users get cfg.role(claims) ?? "user".
  const id = claims.sub as string;
  const email = typeof claims.email === "string" ? claims.email : undefined;
  let user: AioUser;
  const existing = deps.users.get(id);
  if (existing) {
    user = { id: existing.id, role: existing.role };
    if (email && existing.email !== email) deps.users.setEmail(id, email);
  } else {
    const role = deps.cfg.role?.(claims) ?? "user";
    // External identity — random unusable password (never password-verifiable).
    const rnd = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const rec = await deps.users.create(id, rnd, { role, email });
    deps.users.markVerified(id); // provider vouched for the email
    user = { id: rec.id, role: rec.role };
  }
  const token = deps.sessions.issue(user, { ttlMs: deps.ttlMs });
  const headers = new Headers({ Location: safePath(returnTo) });
  headers.append("Set-Cookie", deps.cookie(token));
  // Clear the one-shot binder cookie.
  headers.append(
    "Set-Cookie",
    `${OIDC_BINDER_COOKIE}=; Path=/__aio/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return new Response(null, { status: 302, headers });
}
