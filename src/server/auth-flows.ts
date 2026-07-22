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
import { oidcCallback, type OidcConfig, oidcStart } from "./auth-oidc.ts";
import type { AioUser } from "./aio-types.ts";

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

const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

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
  const body = async (): Promise<Record<string, unknown> | null> => {
    try {
      const b = await req.json();
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
    });
  }
  if (cfg.oidc && route === "GET oidc/callback") {
    return await oidcCallback(req, url, {
      cfg: cfg.oidc,
      users: cfg.users,
      sessions: cfg.sessions,
      ttlMs: cfg.ttlMs,
      cookie: sessionCookie,
    });
  }

  if (req.method !== "POST") return json(404, { error: "unknown_auth_route" });
  if (!sameOrigin(req)) return json(403, { error: "cross_origin" });

  switch (route.slice(5)) {
    case "signup": {
      if (!cfg.signup) return json(403, { error: "signup_disabled" });
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = await body();
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
      const b = await body();
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
      if (cfg.totp !== false && rec?.totpEnabled) {
        const pending = cfg.users.issueToken("totp", id, TOTP_PENDING_TTL_MS);
        return json(200, { totpRequired: true, pending });
      }
      return issueSession(verified);
    }

    case "totp": {
      if (authFailBudgetExceeded(clientKey)) {
        return json(429, { error: "too_many_attempts" });
      }
      const b = await body();
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
      const b = await body();
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
      // Rotate: every existing session dies (stolen ones included); the
      // caller gets a fresh one in the response.
      cfg.sessions.revokeUser(user.id);
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
      const b = await body();
      const token = str(b?.token);
      if (!token) return json(400, { error: "token_required" });
      const stored = cfg.users.consumeToken("verify", token);
      if (!stored) return json(401, { error: "invalid_or_expired_token" });
      cfg.users.markVerified(stored.subject);
      return json(200, { ok: true });
    }

    case "reset/request": {
      if (!cfg.sendMail) return MAIL_OFF();
      const b = await body();
      const id = str(b?.id);
      // ALWAYS 200 — a reset probe must not reveal whether the account exists.
      if (id) {
        const rec = cfg.users.get(id);
        if (rec?.email) {
          const token = cfg.users.issueToken("reset", id, RESET_TTL_MS);
          await cfg.sendMail({
            to: rec.email,
            subject: `Reset your ${cfg.appTitle} password`,
            text:
              `Your password reset token (valid 15 minutes): ${token}\n\nPOST { token, password } to /__aio/auth/reset.`,
          });
        }
      }
      return json(200, { ok: true });
    }

    case "reset": {
      const b = await body();
      const token = str(b?.token), password = str(b?.password);
      if (!token || !password) {
        return json(400, { error: "token_and_password_required" });
      }
      const stored = cfg.users.consumeToken("reset", token);
      if (!stored) return json(401, { error: "invalid_or_expired_token" });
      try {
        await cfg.users.setPassword(stored.subject, password);
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
      // Proof of mailbox control: the email is verified, every session dies.
      cfg.users.markVerified(stored.subject);
      cfg.sessions.revokeUser(stored.subject);
      console.warn(
        `[aio] auth: password reset completed for id=${stored.subject}`,
      );
      return json(200, { ok: true });
    }

    case "totp/setup": {
      if (cfg.totp === false) return json(403, { error: "totp_disabled" });
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      const secret = generateTotpSecret();
      cfg.users.setTotpSecret(user.id, secret); // staged until /totp/enable
      return json(200, {
        secret,
        uri: totpUri(secret, user.id, cfg.appTitle),
      });
    }

    case "totp/enable": {
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      const b = await body();
      const code = str(b?.code);
      const staged = cfg.users.totpSecret(user.id);
      if (!code || !staged) return json(400, { error: "setup_first" });
      if (!(await verifyTotp(staged.secret, code))) {
        return json(401, { error: "invalid_code" });
      }
      cfg.users.enableTotp(user.id);
      return json(200, { ok: true });
    }

    case "totp/disable": {
      const user = caller();
      if (!user) return json(401, { error: "login_required" });
      const b = await body();
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
