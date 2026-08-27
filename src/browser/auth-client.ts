// auth-client.ts — client-side auth API (AUTH-2), browser-safe, zero deps.
//
// Thin typed wrapper over the framework login endpoints (/__aio/auth/*).
// In the browser the session rides the HttpOnly cookie the server sets, so
// after login/signup a page reload (or WS reconnect) is authenticated; the
// returned token serves non-cookie clients (CLI, native, tests).
//
//   import { authClient } from "aio";
//   const user = await authClient.login("alice", "password123");
//   await authClient.logout();

import type { AioUser } from "../protocol/protocol-types.ts";

export interface AuthClientResult {
  user: AioUser;
  /** Bearer token — same session the cookie carries; for non-cookie clients. */
  token: string;
}

/** Login answer when the account has TOTP 2FA enrolled — complete it with
 *  `totp(pending, code)` within 5 minutes. */
export interface TotpChallenge {
  totpRequired: true;
  pending: string;
}

async function post(
  base: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  return await fetch(`${base}/__aio/auth/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Server error CODE → a sentence a person can act on.
 *
 *  The endpoints answer in machine codes (`password_too_short`,
 *  `oidc_bad_aud`) because a code is what a client should branch on. But
 *  `orThrow` put that code straight into `Error.message`, and an app that does
 *  the obvious thing — `catch (e) { setError(e.message) }` — showed the user
 *  `invalid_or_expired_token`. Every login form built on aio therefore had to
 *  carry its own copy of this table, or ship the snake_case.
 *
 *  So the code is translated ONCE, here, and kept on `.code` for the branch.
 *  Anything unlisted falls back to the raw code — a new server code shows up
 *  ugly rather than as a wrong sentence. */
const AUTH_ERROR_TEXT: Record<string, string> = {
  // Credentials & account state
  invalid_credentials: "Incorrect username or password.",
  account_locked:
    "This account is locked after too many failed attempts. Try again later or ask an administrator to unlock it.",
  too_many_attempts: "Too many attempts. Wait a moment and try again.",
  email_unverified:
    "This account's email address has not been verified yet. Check your inbox for the verification link.",
  login_required: "You are not signed in.",
  signup_disabled: "This app does not accept new sign-ups.",
  external_identity:
    "This account signs in through an external provider — use that provider's button rather than a password.",
  // Input the caller can fix
  password_too_short: "Password must be at least 8 characters.",
  invalid_id: "That username cannot be used — pick another.",
  user_exists: "That username is already taken.",
  invalid_email: "That email address is not valid.",
  email_required: "An email address is required.",
  password_required: "A password is required.",
  id_and_password_required: "Enter both a username and a password.",
  old_and_new_required: "Enter your current password and the new one.",
  token_and_password_required:
    "The reset link is incomplete — request a new one.",
  token_required: "The link is incomplete — request a new one.",
  no_email_on_account:
    "This account has no email address, so it cannot be reset by email.",
  // Tokens & 2FA
  invalid_or_expired_token: "That link has expired. Request a new one.",
  invalid_code: "That code is not correct.",
  pending_and_code_required:
    "Enter the 6-digit code from your authenticator app.",
  pending_expired: "The sign-in took too long. Start again.",
  setup_first: "Set up two-factor authentication before confirming it.",
  totp_disabled: "Two-factor authentication is turned off for this app.",
  // Server-side configuration — not the user's fault, and saying so saves a
  // support round-trip
  mail_not_configured:
    "This app cannot send email, so it cannot verify addresses or reset passwords. (Server config: auth.sendMail is not set.)",
  cross_origin: "The request came from an unexpected origin and was refused.",
  unknown_auth_route: "That auth endpoint does not exist.",
  // OIDC — a misconfigured provider, phrased so the operator knows where to look
  oidc_bad_aud:
    "Sign-in failed: the provider issued this token for a different app. (Server config: the OIDC clientId does not match.)",
  oidc_bad_iss:
    "Sign-in failed: the token came from an unexpected provider. (Server config: check the OIDC issuer.)",
  oidc_bad_signature:
    "Sign-in failed: the provider's token could not be verified.",
  oidc_bad_token:
    "Sign-in failed: the provider returned a token this app could not read.",
  oidc_expired:
    "Sign-in took too long and the provider's token expired. Try again.",
  oidc_no_sub: "Sign-in failed: the provider did not identify the user.",
  oidc_unknown_kid:
    "Sign-in failed: the provider signed with a key this app does not know.",
  oidc_alg_unsupported:
    "Sign-in failed: the provider used an unsupported signing algorithm.",
};

/** An auth failure carrying BOTH halves: a readable `message` for a UI and the
 *  raw server `code` for a branch. */
export class AuthError extends Error {
  /** The server's machine-readable code (`"invalid_credentials"`, …), or
   *  `"http_<status>"` when the endpoint answered without one. */
  readonly code: string;
  /** The HTTP status the endpoint returned. */
  readonly status: number;
  constructor(code: string, status: number) {
    super(
      AUTH_ERROR_TEXT[code] ??
        (code.startsWith("http_")
          ? `The auth server answered ${status} with no reason given.`
          : `Sign-in failed (${code}).`),
    );
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

async function orThrow<T>(resp: Response): Promise<T> {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const code = (data as { error?: string }).error ?? `http_${resp.status}`;
    throw new AuthError(code, resp.status);
  }
  return data as T;
}

/** Build an auth client. `base` defaults to same-origin (browser); pass an
 *  explicit `http(s)://host:port` for CLI/native/test callers. */
export function createAuthClient(base = ""): {
  me(token?: string): Promise<AioUser | null>;
  signup(
    id: string,
    password: string,
    email?: string,
  ): Promise<AuthClientResult | { verificationSent: true }>;
  login(
    id: string,
    password: string,
  ): Promise<AuthClientResult | TotpChallenge>;
  totp(pending: string, code: string): Promise<AuthClientResult>;
  logout(token?: string): Promise<void>;
  changePassword(
    oldPw: string,
    newPw: string,
    token?: string,
  ): Promise<AuthClientResult>;
  requestReset(id: string): Promise<void>;
  reset(token: string, password: string): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  totpSetup(token?: string): Promise<{ secret: string; uri: string }>;
  /** Confirm enrollment. The ACCOUNT PASSWORD is required: turning a second
   *  factor ON must be exactly as hard as turning it off, or a stolen session
   *  alone can enrol the thief's authenticator and lock the owner out. */
  totpEnable(code: string, password: string, token?: string): Promise<void>;
  totpDisable(password: string, token?: string): Promise<void>;
} {
  return {
    /** Current identity (cookie or explicit token), or null. */
    async me(token?) {
      const resp = await fetch(`${base}/__aio/auth/me`, {
        credentials: "same-origin",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const { user } = await orThrow<{ user: AioUser | null }>(resp);
      return user;
    },
    /** Create an account (open signup). Logs straight in unless the app
     *  requires email verification first. */
    async signup(id, password, email) {
      return await orThrow(await post(base, "signup", { id, password, email }));
    },
    /** Throws Error("invalid_credentials") on a wrong password; resolves with
     *  a TotpChallenge when a second factor is needed. */
    async login(id, password) {
      return await orThrow(await post(base, "login", { id, password }));
    },
    /** Complete a TOTP challenge from login. */
    async totp(pending, code) {
      return await orThrow<AuthClientResult>(
        await post(base, "totp", { pending, code }),
      );
    },
    /** Revoke the current session (cookie or explicit token). */
    async logout(token?) {
      await orThrow<{ ok: true }>(await post(base, "logout", undefined, token));
    },
    /** Rotate the password — every other session is revoked. */
    async changePassword(oldPw, newPw, token?) {
      return await orThrow<AuthClientResult>(
        await post(base, "password", { old: oldPw, new: newPw }, token),
      );
    },
    /** Always resolves — the server never reveals whether the id exists. */
    async requestReset(id) {
      await orThrow(await post(base, "reset/request", { id }));
    },
    async reset(token, password) {
      await orThrow(await post(base, "reset", { token, password }));
    },
    async verifyEmail(token) {
      await orThrow(await post(base, "verify", { token }));
    },
    /** Begin TOTP enrollment — returns the secret + otpauth:// URI (QR). */
    async totpSetup(token?) {
      return await orThrow<{ secret: string; uri: string }>(
        await post(base, "totp/setup", undefined, token),
      );
    },
    async totpEnable(code, password, token?) {
      await orThrow(await post(base, "totp/enable", { code, password }, token));
    },
    async totpDisable(password, token?) {
      await orThrow(await post(base, "totp/disable", { password }, token));
    },
  };
}

/** Same-origin auth client — the one browsers use. */
export const authClient: ReturnType<typeof createAuthClient> =
  createAuthClient();
