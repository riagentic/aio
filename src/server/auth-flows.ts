// auth-flows.ts — the framework login endpoints (AUTH-2/3).
//
//   POST /__aio/auth/signup         { id, password, email? }
//   POST /__aio/auth/login          { id, password } → session | totp step | 423
//   POST /__aio/auth/totp           { pending, code }   second factor → session
//   POST /__aio/auth/logout
//   GET  /__aio/auth/me
//   POST /__aio/auth/password       (authed) { old, new } — rotates sessions
//   POST /__aio/auth/verify/request (authed) — email a verification token
//   POST /__aio/auth/verify         { token }
//   POST /__aio/auth/reset/request  { id } — always 200 (no enumeration)
//   POST /__aio/auth/reset          { token, password } — revokes all sessions
//   POST /__aio/auth/totp/setup     (authed) → { secret, uri }
//   POST /__aio/auth/totp/enable    (authed) { code }
//   POST /__aio/auth/totp/disable   (authed) { password }
//   GET  /__aio/auth/oidc/start     → 302 provider (PKCE)
//   GET  /__aio/auth/oidc/callback  → session + 302 "/"
//
// Enabled by `aio.run({ auth: true | {...} })`. Sessions come from the AUTH-1
// store; the token doubles as an HttpOnly SameSite=Strict cookie so browsers
// authenticate follow-up requests (incl. the WS handshake) without touching
// URLs. CSRF: SameSite=Strict + an Origin same-host check on every POST.
// Failed logins burn the AUTH-1 per-IP budget AND the per-account lockout.

import type { UserStore } from "./auth-users.ts";
import type { SessionStore } from "./sessions.ts";
import {
  authFailBudgetExceeded,
  recordAuthFail,
  SESSION_COOKIE,
  sessionTokenFromCookie,
} from "./server-auth.ts";
import { generateTotpSecret, totpUri, verifyTotp } from "./auth-totp.ts";
import {
  isExternalId,
  oidcCallback,
  type OidcConfig,
  oidcStart,
} from "./auth-oidc.ts";
import type { AioUser } from "./aio-types.ts";
import { log } from "../diagnostics/logger-api.ts";

const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 15 * 60_000;
const TOTP_PENDING_TTL_MS = 5 * 60_000;

/** Outbound mail hook — the dev supplies transport (SMTP, SES, console…). */
export type SendMailFn = (msg: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void> | void;

export interface AuthFlows {
  users: UserStore;
  sessions: SessionStore;
  /** Open self-signup allowed (default true; false = admin-seeded users only). */
  signup: boolean;
  /** Set/clear the session cookie on login/logout (default true). */
  cookie: boolean;
  /** Session TTL for issued logins (default: store default, 30d). */
  ttlMs?: number;
  /** TLS active — mark the cookie Secure. */
  secure: boolean;
  /** App title — the TOTP issuer label authenticator apps display. */
  appTitle: string;
  /** Email transport for verify/reset flows; absent → those routes 501. */
  sendMail?: SendMailFn;
  /** Block login until the account's email is verified (needs sendMail). */
  requireVerified?: boolean;
  /** Allow users to enroll TOTP 2FA (default true). */
  totp?: boolean;
  /** OIDC provider — enables /oidc/start + /oidc/callback. */
  oidc?: OidcConfig;
}

/** Every auth response is identity-bearing (a user, a session token, a
 *  one-shot secret) or a credential verdict. `no-store` on ALL of them — one
 *  decider, so a route added later cannot forget it — keeps a proxy, a service
 *  worker or the browser's back/forward cache from holding someone's identity
 *  and replaying it to the next person on that connection. */
const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

/** Largest body any /__aio/auth/* route will buffer.
 *
 *  These routes are the ones reachable BEFORE any credential, and they read
 *  the body with a bare `req.json()`. A single 48 MB login body took RSS to
 *  ~500 MB — an unauthenticated memory pump. Every auth payload is a handful
 *  of short strings; 16 KiB is orders of magnitude of headroom. (The trojan
 *  and the static upload path already bound their bodies — the auth routes
 *  were the outlier, and the exposed one.) */
const MAX_AUTH_BODY = 16 * 1024;

const cookieHeader = (
  token: string,
  maxAgeS: number,
  secure: boolean,
): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` +
  `; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;

/** CSRF floor for the POST flows: when a browser sends an Origin, its host
 *  must match the request host (SameSite=Strict already blocks cross-site
 *  cookie sends; this also stops cross-origin token-less POSTs). Requests
 *  without Origin (curl, native clients) pass — they carry no ambient cookie
 *  authority to ride. */
const sameOrigin = (req: Request): boolean => {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? "");
  } catch {
    return false;
  }
};

const MAIL_OFF = json.bind(null, 501, { error: "mail_not_configured" });

/** Read a request body as text, or null once it passes MAX_AUTH_BODY.
 *  Streams and stops — an oversized body is never fully buffered, which is
 *  the entire point (a declared length can lie, or be absent). */
async function _readBounded(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_AUTH_BODY) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released by cancel */ }
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** Handle /__aio/auth/* — returns null for any other path. */
export async function handleAuthFlow(
  req: Request,
  url: URL,
  cfg: AuthFlows,
  clientKey: string | undefined,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/__aio/auth/")) return null;
  const route = `${req.method} ${url.pathname.slice("/__aio/auth/".length)}`;
  const maxAgeS = Math.floor((cfg.ttlMs ?? 30 * 24 * 3_600_000) / 1000);
  const sessionCookie = (token: string): string =>
    cookieHeader(token, maxAgeS, cfg.secure);
  const issueSession = (user: AioUser, status = 200): Response => {
    const token = cfg.sessions.issue(user, { ttlMs: cfg.ttlMs });
    return json(
      status,
      { user: { id: user.id, role: user.role }, token },
      cfg.cookie ? { "Set-Cookie": sessionCookie(token) } : undefined,
    );
  };
  const bearer = (): string | null => {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    return sessionTokenFromCookie(req);
  };
  /** Session-authed caller, or null. */
  const caller = (): AioUser | null => {
    const t = bearer();
    const info = t ? cfg.sessions.get(t) : null;
    return info ? { id: info.id, role: info.role } : null;
  };
  /** The body text, read ONCE and bounded (null = over the cap). Filled in
   *  before the POST switch so every route parses the same bytes and none of
   *  them can forget the bound. */
  let raw: string | null = "";
  const body = (): Record<string, unknown> | null => {
    try {
      const b = JSON.parse(raw ?? "");
      return b && typeof b === "object" ? b as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const str = (v: unknown): string | null => typeof v === "string" ? v : null;

  // GET routes first (no CSRF check — no state change without verified tokens).
  if (route === "GET me") {
    const user = caller();
    // `features` lets <SignIn/> adapt to the server's config automatically —
    // no OIDC button when there is no provider, no signup toggle when signup
    // is off. Booleans only, nothing sensitive.
    return json(200, {
      user,
      features: {
        signup: cfg.signup,
        oidc: !!cfg.oidc,
        totp: cfg.totp !== false,
        mail: !!cfg.sendMail,
      },
    });
  }
  if (cfg.oidc && route === "GET oidc/start") {
    return await oidcStart(req, {
      cfg: cfg.oidc,
      users: cfg.users,
      sessions: cfg.sessions,
      ttlMs: cfg.ttlMs,
      cookie: sessionCookie,
      secure: cfg.secure,
    });
  }
  if (cfg.oidc && route === "GET oidc/callback") {
    return await oidcCallback(req, url, {
      cfg: cfg.oidc,
      users: cfg.users,
      sessions: cfg.sessions,
      ttlMs: cfg.ttlMs,
      cookie: sessionCookie,
      secure: cfg.secure,
    });
  }

  if (req.method !== "POST") return json(404, { error: "unknown_auth_route" });
  if (!sameOrigin(req)) return json(403, { error: "cross_origin" });
  // Body cap, once, for every POST route — a route added later inherits it,
  // and a route that forgets to read the body cannot leave one unbounded.
  // The declared length is refused before a byte is read; a body that lies
  // about (or omits) its length is cut off by the bounded reader.
  const declared = Number(req.headers.get("content-length") ?? NaN);
  const tooBig = Number.isFinite(declared) && declared > MAX_AUTH_BODY;
  if (tooBig) req.body?.cancel().catch(() => {});
  raw = tooBig ? null : await _readBounded(req);
  if (raw === null) {
    return json(413, {
      error: "body_too_large",
      hint: `auth request bodies are capped at ${MAX_AUTH_BODY} bytes`,
    });
  }

  switch (route.slice(5)) {
    case "signup": {
      if (!cfg.signup) return json(403, { error: "signup_disabled" });
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const id = str(b?.id), password = str(b?.password);
      const email = str(b?.email) ?? undefined;
      if (!id || !password) {
        return json(400, { error: "id_and_password_required" });
      }
      if (email !== undefined && !/^.+@.+\..+$/.test(email)) {
        return json(400, { error: "invalid_email" });
      }
      if (cfg.requireVerified && !email) {
        return json(400, { error: "email_required" });
      }
      let user: AioUser;
      try {
        user = await cfg.users.create(id, password, { email });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A 409 is a direct "this id exists" oracle. It can't be hidden (a
        // legit signer-up must learn the name is taken), but feeding the
        // per-IP budget means scripted enumeration hits 429 fast — the guard
        // at the top of this case only helps if failures actually record.
        if (msg === "user_exists") {
          recordAuthFail(clientKey, `signup collision for id=${id}`);
        }
        return json(msg === "user_exists" ? 409 : 400, { error: msg });
      }
      if (email && cfg.sendMail) {
        const token = cfg.users.issueToken("verify", id, VERIFY_TTL_MS);
        await cfg.sendMail({
          to: email,
          subject: `Verify your ${cfg.appTitle} account`,
          text:
            `Your verification token: ${token}\n\nPOST it to /__aio/auth/verify to activate the account.`,
        });
      }
      // With verification REQUIRED there is no session until the email is
      // proven — otherwise signup logs straight in.
      if (cfg.requireVerified) {
        return json(201, {
          user: { id: user.id, role: user.role },
          verificationSent: true,
        });
      }
      return issueSession(user, 201);
    }

    case "login": {
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const id = str(b?.id), password = str(b?.password);
      if (!id || !password) {
        return json(400, { error: "id_and_password_required" });
      }
      const verified = await cfg.users.verify(id, password);
      if (verified === "locked") {
        return json(423, { error: "account_locked" });
      }
      if (!verified) {
        recordAuthFail(clientKey, `login failed for id=${id}`);
        return json(401, { error: "invalid_credentials" });
      }
      const rec = cfg.users.get(id);
      if (cfg.requireVerified && rec && !rec.verified) {
        return json(403, { error: "email_unverified" });
      }
      // TOTP enrolled → the password alone is HALF a login. Hand back a
      // short-lived one-shot pending token; /totp completes it.
      //
      // NOT gated on `cfg.totp`: that flag turns ENROLLMENT off (the docs say
      // so), and reading it here also turned VERIFICATION off — flipping
      // `auth: { totp: false }` on an existing auth.db silently demoted every
      // already-enrolled account to password-only, with no warning and no
      // trace. A configuration switch may refuse to add a factor; it must
      // never quietly drop one a user is relying on. (Boot warns loudly when
      // enrolled accounts exist under `totp: false` — see server.ts.)
      if (rec?.totpEnabled) {
        const pending = cfg.users.issueToken("totp", id, TOTP_PENDING_TTL_MS);
        return json(200, { totpRequired: true, pending });
      }
      return issueSession(verified);
    }

    case "totp": {
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const pending = str(b?.pending), code = str(b?.code);
      if (!pending || !code) {
        return json(400, { error: "pending_and_code_required" });
      }
      // One-shot: a wrong code burns the pending token — back to login.
      const stored = cfg.users.consumeToken("totp", pending);
      if (!stored) return json(401, { error: "pending_expired" });
      const secret = cfg.users.totpSecret(stored.subject);
      if (!secret?.enabled || !(await verifyTotp(secret.secret, code))) {
        recordAuthFail(clientKey, `totp failed for id=${stored.subject}`);
        return json(401, { error: "invalid_code" });
      }
      const rec = cfg.users.get(stored.subject);
      if (!rec) return json(401, { error: "invalid_code" });
      return issueSession({ id: rec.id, role: rec.role });
    }

    case "logout": {
      const token = bearer();
      if (token) cfg.sessions.revoke(token);
      return json(200, { ok: true }, {
        "Set-Cookie": cookieHeader("", 0, cfg.secure), // clear
      });
    }

    case "password": {
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      // Same per-IP budget every other verifying endpoint checks. Without it
      // this route verified a password — one PBKDF2, ~100ms of CPU — for every
      // request, unthrottled: a stolen session could brute-force the OLD
      // password here at full speed, and anyone could use it as a CPU pump
      //. The account lockout alone is not the answer; this is the gate
      // that makes guessing expensive per SOURCE, not per account.
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const oldPw = str(b?.old), newPw = str(b?.new);
      if (!oldPw || !newPw) return json(400, { error: "old_and_new_required" });
      const ok = await cfg.users.verify(user.id, oldPw);
      if (ok === "locked") return json(423, { error: "account_locked" });
      if (!ok) {
        recordAuthFail(clientKey, `password change failed for id=${user.id}`);
        return json(401, { error: "invalid_credentials" });
      }
      try {
        await cfg.users.setPassword(user.id, newPw);
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
      // `setPassword` IS the rotation: it clears the lockout, burns every
      // outstanding one-shot token and revokes every session (stolen ones
      // included). This route deliberately does not repeat any of that — a
      // second copy of the rule is how one of the two copies rots, and it is
      // exactly how `am auth passwd` ended up rotating passwords without
      // revoking anything. The caller gets a fresh session in the response.
      return issueSession(user);
    }

    case "verify/request": {
      if (!cfg.sendMail) return MAIL_OFF();
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      const rec = cfg.users.get(user.id);
      if (!rec?.email) return json(400, { error: "no_email_on_account" });
      if (rec.verified) return json(200, { ok: true, alreadyVerified: true });
      const token = cfg.users.issueToken("verify", user.id, VERIFY_TTL_MS);
      await cfg.sendMail({
        to: rec.email,
        subject: `Verify your ${cfg.appTitle} account`,
        text: `Your verification token: ${token}`,
      });
      return json(200, { ok: true });
    }

    case "verify": {
      const b = body();
      const token = str(b?.token);
      if (!token) return json(400, { error: "token_required" });
      const stored = cfg.users.consumeToken("verify", token);
      if (!stored) return json(401, { error: "invalid_or_expired_token" });
      cfg.users.markVerified(stored.subject);
      return json(200, { ok: true });
    }

    case "reset/request": {
      if (!cfg.sendMail) return MAIL_OFF();
      // Rate-cap the mail trigger (per-IP budget) so a known-id attacker can't
      // mail-bomb an inbox / run up send costs. Still ALWAYS 200 below.
      if (authFailBudgetExceeded(clientKey)) {
        return json(200, { ok: true }); // silent — reveal nothing
      }
      const b = body();
      const id = str(b?.id);
      // ALWAYS 200 at the SAME latency — a reset probe must reveal nothing
      // about whether the account exists. Two guards make the timing uniform
      // for existing vs missing ids: (1) issue a one-shot token on BOTH paths
      // (a decoy on the miss), so the SQLite write happens either way; (2) the
      // mail send is fire-and-forget (not awaited), so the SMTP round-trip is
      // never on the response path.
      if (id) {
        recordAuthFail(clientKey, `reset request for id=${id}`); // budget the trigger
        const rec = cfg.users.get(id);
        // An EXTERNAL identity has no password to reset — its credentials live
        // at the IdP. Minting a reset token for one would turn "controls this
        // mailbox" into "can set a local password on an SSO account", a
        // password-login door into an identity the provider is supposed to
        // own. Treated exactly like a miss (decoy token, no mail), so the
        // route still reveals nothing about which ids exist.
        const local = rec !== null && !isExternalId(rec.id);
        // Always issue a token (decoy for the miss) → identical write cost.
        // The decoy subject is an ESCAPE, not a literal NUL byte in the
        // source: a raw control character made this whole file read as
        // binary, so grep matched nothing in it and said so silently.
        const token = cfg.users.issueToken(
          "reset",
          local ? id : "\u0000decoy",
          RESET_TTL_MS,
        );
        if (local && rec.email) {
          void Promise.resolve(
            cfg.sendMail({
              to: rec.email,
              subject: `Reset your ${cfg.appTitle} password`,
              text:
                `Your password reset token (valid 15 minutes): ${token}\n\nPOST { token, password } to /__aio/auth/reset.`,
            }),
          ).catch((e) => log.warn(`[aio] auth: reset mail send failed — ${e}`));
        }
      }
      return json(200, { ok: true });
    }

    case "reset": {
      const b = body();
      const token = str(b?.token), password = str(b?.password);
      if (!token || !password) {
        return json(400, { error: "token_and_password_required" });
      }
      const stored = cfg.users.consumeToken("reset", token);
      if (!stored) return json(401, { error: "invalid_or_expired_token" });
      // No reset token is ever minted for an external identity (see
      // reset/request) — this refuses one that predates that rule rather than
      // letting it install a password on an IdP-owned account.
      if (isExternalId(stored.subject)) {
        return json(403, { error: "external_identity" });
      }
      try {
        await cfg.users.setPassword(stored.subject, password);
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
      // Proof of mailbox control: the email is verified. Sessions, tokens and
      // the lockout are `setPassword`'s job (above) — one decider.
      cfg.users.markVerified(stored.subject);
      log.warn(
        `[aio] auth: password reset completed for id=${stored.subject}`,
      );
      return json(200, { ok: true });
    }

    case "totp/setup": {
      if (cfg.totp === false) return json(403, { error: "totp_disabled" });
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      // Enrolling is not the same as RE-enrolling. This route overwrote the
      // stored secret unconditionally, so a stolen session could stage a new
      // secret, add it to the attacker's own authenticator and pass
      // /totp/enable with a valid code — silently replacing the owner's second
      // factor and locking them out of their own account. Turning TOTP
      // OFF already requires the password; turning it over to a new device
      // must not be easier than turning it off.
      if (cfg.users.totpSecret(user.id)?.enabled) {
        return json(409, {
          error: "totp_already_enabled",
          hint:
            "disable TOTP first (requires the password), then set it up again",
        });
      }
      const secret = generateTotpSecret();
      cfg.users.setTotpSecret(user.id, secret); // staged until /totp/enable
      return json(200, {
        secret,
        uri: totpUri(secret, user.id, cfg.appTitle),
      });
    }

    case "totp/enable": {
      if (cfg.totp === false) return json(403, { error: "totp_disabled" });
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      // TURNING A FACTOR ON IS EXACTLY AS HARD AS TURNING IT OFF.
      //
      // This route used to need only a session. So a stolen session token —
      // by itself, with no password — could enrol the ATTACKER's
      // authenticator, and from that moment the owner's own password login
      // demanded the attacker's device. Nothing cleared it: not a completed
      // email password reset, not `am auth passwd`. Account destruction
      // (`am auth rm`) was the only way back. Enabling was strictly easier
      // than disabling, which inverts the whole point of a second factor.
      //
      // Same shape as totp/disable: password re-auth, on the same per-IP
      // budget (this route verifies a password, so it must not be an
      // unthrottled PBKDF2 pump either).
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const code = str(b?.code), password = str(b?.password);
      if (!password) return json(400, { error: "password_required" });
      const staged = cfg.users.totpSecret(user.id);
      if (!code || !staged) return json(400, { error: "setup_first" });
      const ok = await cfg.users.verify(user.id, password);
      if (ok === "locked") return json(423, { error: "account_locked" });
      if (!ok) {
        recordAuthFail(clientKey, `totp enable failed for id=${user.id}`);
        return json(401, { error: "invalid_credentials" });
      }
      if (!(await verifyTotp(staged.secret, code))) {
        return json(401, { error: "invalid_code" });
      }
      cfg.users.enableTotp(user.id);
      log.warn(`[aio] auth: TOTP enabled for id=${user.id}`);
      return json(200, { ok: true });
    }

    case "totp/disable": {
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      // Verifies a password → same per-IP budget as every other such route.
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = body();
      const password = str(b?.password);
      if (!password) return json(400, { error: "password_required" });
      const ok = await cfg.users.verify(user.id, password);
      if (ok !== null && ok !== "locked") {
        cfg.users.disableTotp(user.id);
        return json(200, { ok: true });
      }
      recordAuthFail(clientKey, `totp disable failed for id=${user.id}`);
      return json(401, { error: "invalid_credentials" });
    }

    default:
      return json(404, { error: "unknown_auth_route" });
  }
}
