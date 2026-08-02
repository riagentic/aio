// route.ts — ergonomic HTTP routes.
//
// `routes: {}` already hands a raw `Request` to a handler that returns a
// `Response`, so cookies, status, and multipart (`req.formData()`) all work.
// What apps re-rolled every time: `:id` path params, a method guard, cookie
// parse/serialize, and a JSON-response helper. `route()` adds exactly that on
// top of the existing mechanism — same `routes` record, richer handler.
//
//   routes: {
//     "/users/:id": route((ctx) => ctx.json({ id: ctx.params.id })),
//     "/login": route(async (ctx) => {
//       const { user, pass } = await ctx.req.json();
//       ctx.setCookie("sid", await mkSession(user), { httpOnly: true, path: "/" });
//       return ctx.json({ ok: true });
//     }, { method: "POST" }),
//     "/upload": route(async (ctx) => {
//       const form = await ctx.req.formData(); // multipart just works
//       return ctx.json({ files: [...form.keys()] });
//     }, { method: "POST" }),
//   }
//
// Raw `(req) => Response` handlers keep working unchanged — `route()` is opt-in.

import type { AioUser } from "./aio-types.ts";

/** Extra info the server dispatcher passes a matched route handler. Raw
 *  `(req) => Response` handlers ignore it; `route()` reads it. */
export interface RouteMatch {
  params: Record<string, string>;
  user?: AioUser;
  ip?: string;
}

/** A routes-map value — a raw request handler, optionally given the match. */
export type RawRouteHandler = (
  req: Request,
  match?: RouteMatch,
) => Response | Promise<Response>;

/** Options for {@link Cookie} serialization. */
export interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Everything a {@link route} handler gets — the request plus the ergonomics
 *  apps otherwise hand-roll. */
export interface RouteContext {
  /** The raw request — use it for `req.json()`, `req.formData()`, headers, … */
  req: Request;
  url: URL;
  /** Path parameters from the pattern, e.g. `/users/:id` → `{ id: "42" }`. */
  params: Record<string, string>;
  /** Query string params (`url.searchParams`). */
  query: URLSearchParams;
  /** The authenticated caller, when the server resolved one (per-user / token
   *  modes). `undefined` for anonymous / public routes. */
  user?: AioUser;
  /** The client's address, when the runtime exposed it. */
  ip?: string;
  /** Parsed request cookies. */
  cookies: Record<string, string>;
  /** Queue a Set-Cookie header — applied to whatever Response you return. */
  setCookie(name: string, value: string, opts?: CookieOptions): void;
  /** Build a JSON Response (sets content-type + any queued cookies). */
  json(data: unknown, init?: ResponseInit): Response;
  /** Build a text/plain Response (+ any queued cookies). */
  text(body: string, init?: ResponseInit): Response;
  /** A redirect Response (default 302) (+ any queued cookies). */
  redirect(location: string, status?: number): Response;
}

/** {@link route} options — currently the HTTP method guard. */
export interface RouteOptions {
  /** Allow only this method (or these). A mismatch → 405. */
  method?: string | string[];
}

/** `decodeURIComponent` that never throws. Path segments and cookie values are
 *  attacker-controlled: a malformed escape (`%zz`) raises URIError, and this
 *  runs on the request path — for cookies, on EVERY request, since
 *  `serverRequest()` parses them. A bad escape must stay a literal, never take
 *  a route (or a WS upgrade) down with it. */
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Match a route pattern (with `:param` segments and a trailing `*`) against a
 *  pathname. Returns the captured params, or null when it doesn't match. Pure
 *  + exported for tests. */
export function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  // Fast path: a literal pattern (no ':' or '*') is a plain equality check.
  if (!pattern.includes(":") && !pattern.includes("*")) {
    return pattern === pathname ? {} : null;
  }
  const pSegs = pattern.split("/");
  const uSegs = pathname.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;
    if (p === "*") {
      // Trailing wildcard: capture the rest under `params["*"]`.
      params["*"] = uSegs.slice(i).join("/");
      return params;
    }
    const u = uSegs[i];
    if (u === undefined) return null; // pattern longer than path
    if (p.startsWith(":")) {
      if (u === "") return null; // a param must be non-empty
      params[p.slice(1)] = decodeSafe(u);
    } else if (p !== u) {
      return null;
    }
  }
  return uSegs.length === pSegs.length ? params : null;
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeSafe(part.slice(eq + 1).trim());
  }
  return out;
}

/** Serialize one Set-Cookie value from a name/value + options. */
export function serializeCookie(
  name: string,
  value: string,
  o: CookieOptions = {},
): string {
  // A cookie NAME goes into the header verbatim (only the value is encoded), so
  // a name built from untrusted input could otherwise append its own
  // attributes — `sid; Path=/; HttpOnly` — or a whole second cookie. RFC 6265
  // token chars only; anything else is a programming error, loudly.
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(
      `[aio] invalid cookie name ${JSON.stringify(name)} — RFC 6265 token ` +
        `characters only (no spaces, ";", "=", or control characters)`,
    );
  }
  let s = `${name}=${encodeURIComponent(value)}`;
  if (o.path) s += `; Path=${o.path}`;
  if (o.domain) s += `; Domain=${o.domain}`;
  if (o.maxAge !== undefined) s += `; Max-Age=${Math.floor(o.maxAge)}`;
  if (o.expires) s += `; Expires=${o.expires.toUTCString()}`;
  if (o.httpOnly) s += `; HttpOnly`;
  if (o.secure) s += `; Secure`;
  if (o.sameSite) s += `; SameSite=${o.sameSite}`;
  return s;
}

/** Wrap a context-aware handler into a routes-map value. `route()` handles the
 *  method guard, builds the {@link RouteContext} (params, cookies, helpers),
 *  and applies any queued Set-Cookie headers to the returned Response. */
export function route(
  handler: (ctx: RouteContext) => Response | Promise<Response>,
  opts: RouteOptions = {},
): RawRouteHandler {
  const methods = opts.method === undefined
    ? null
    : (Array.isArray(opts.method) ? opts.method : [opts.method]).map((m) =>
      m.toUpperCase()
    );
  return async (req: Request, match?: RouteMatch): Promise<Response> => {
    if (methods && !methods.includes(req.method.toUpperCase())) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: methods.join(", ") },
      });
    }
    const url = new URL(req.url);
    const pending: string[] = []; // queued Set-Cookie values
    const withCookies = (res: Response): Response => {
      for (const c of pending) res.headers.append("Set-Cookie", c);
      pending.length = 0; // applied — don't let the outer wrap re-apply
      return res;
    };
    const ctx: RouteContext = {
      req,
      url,
      params: match?.params ?? {},
      query: url.searchParams,
      user: match?.user,
      ip: match?.ip,
      cookies: parseCookies(req.headers.get("cookie")),
      setCookie: (name, value, o) =>
        void pending.push(serializeCookie(name, value, o)),
      json: (data, init) =>
        withCookies(
          new Response(JSON.stringify(data), {
            ...init,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...(init?.headers ?? {}),
            },
          }),
        ),
      text: (body, init) =>
        withCookies(
          new Response(body, {
            ...init,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...(init?.headers ?? {}),
            },
          }),
        ),
      redirect: (location, status = 302) =>
        withCookies(
          new Response(null, { status, headers: { Location: location } }),
        ),
    };
    // The handler may still build its own Response directly — apply queued
    // cookies to it too, so setCookie() always takes effect.
    return withCookies(await handler(ctx));
  };
}
