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

import type { AioUser } from "../server/aio-types.ts";

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

async function orThrow<T>(resp: Response): Promise<T> {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      (data as { error?: string }).error ??
        `auth request failed (${resp.status})`,
    );
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
  totpEnable(code: string, token?: string): Promise<void>;
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
    async totpEnable(code, token?) {
      await orThrow(await post(base, "totp/enable", { code }, token));
    },
    async totpDisable(password, token?) {
      await orThrow(await post(base, "totp/disable", { password }, token));
    },
  };
}

/** Same-origin auth client — the one browsers use. */
export const authClient: ReturnType<typeof createAuthClient> =
  createAuthClient();
