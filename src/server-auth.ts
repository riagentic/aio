// Authentication helpers — timing-safe comparison, token extraction, user resolution.
// Extracted from server.ts — no side effects, pure functions.
import type { AioUser } from "./aio.ts";

// Constant-time string comparison — prevents timing attacks on token auth
// Compares full length even on mismatch to avoid leaking token length
export function _timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let result = ab.length ^ bb.length; // length difference contributes to result
  for (let i = 0; i < len; i++) result |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return result === 0;
}

/** Extract token from query param or Authorization header */
export function _extractToken(url: URL, req: Request): string | null {
  const qToken = url.searchParams.get("token");
  if (qToken) return qToken;
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

/** User resolver function — built once from resolveUser hook or static users map */
export type UserResolverFn = (
  token: string,
) => AioUser | null | Promise<AioUser | null>;

/** Build a unified user resolver from config (AIO-171).
 *  resolveUser hook takes precedence over static users map. */
export function _buildUserResolver(config: {
  resolveUser?: UserResolverFn;
  users?: Record<string, AioUser>;
}): UserResolverFn | null {
  if (config.resolveUser) return config.resolveUser;
  if (config.users) {
    const users = config.users;
    return (token: string) => {
      for (const [t, user] of Object.entries(users)) {
        if (_timingSafeEqual(token, t)) return user;
      }
      return null;
    };
  }
  return null;
}
