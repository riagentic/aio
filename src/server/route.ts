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

/** THE reserved-namespace predicate — one decider, asked twice.
 *
 *  `/__aio/*` (health, metrics, vitals, snapshot, the trojan, the dev module
 *  routes the shell imports) and `/ws` belong to the framework. That was
 *  enforced at boot against the PATTERN TEXT only, so the rule held for
 *  `"/__aio/x"` and evaporated for any pattern that MATCHES those paths without
 *  naming them: a plain SPA catch-all (`"/*"`, or `"/:page"`) silently ate
 *  `/__aio/health`, `/__aio/metrics`, `/__aio/snapshot` AND every
 *  `/__aio/**.ts` module the dev shell imports — i.e. the whole dev UI, with no
 *  error anywhere. Two deciders for "is this path the framework's": a string
 *  prefix on the pattern at boot, and whatever matched first at request time.
 *
 *  Now both ask this. At boot it refuses a pattern inside the namespace (loud,
 *  as before); at dispatch it keeps a wildcard from capturing it. */
export function isReservedRoutePath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/__aio");
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
 *  + exported for tests.
 *
 *  A `:param` is URL-DECODED — that is what makes `/users/a%20b` yield `"a b"`
 *  — so its value can hold characters the path did not visibly contain,
 *  including `/` (from `%2F`) and `..`. Correct for a value, dangerous for a
 *  path: a handler that joins one onto the filesystem escapes its directory.
 *  aio never does that itself (params go straight to the app's handler), and
 *  docs/examples/05-integrations.md says so where an app author will read it.
 *  The trailing `*` capture is deliberately NOT decoded: it is a path, not a
 *  value, and decoding it would invent segment boundaries. */
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
    // HEAD rides with GET, as HTTP says it must. `{ method: "GET" }` answered
    // 405 to HEAD, so every uptime monitor, link checker and `curl -I`
    // reported the endpoint down — and Deno strips a HEAD body anyway, so the
    // handler could always have run.
    const asked = req.method.toUpperCase();
    const effective = asked === "HEAD" && methods?.includes("GET")
      ? "GET"
      : asked;
    if (methods && !methods.includes(effective)) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: methods.includes("GET") && !methods.includes("HEAD")
            ? [...methods, "HEAD"].join(", ")
            : methods.join(", "),
        },
      });
    }
    const url = new URL(req.url);
    const pending: string[] = []; // queued Set-Cookie values
    const withCookies = (res: Response): Response => {
      if (pending.length === 0) return res;
      try {
        for (const c of pending) res.headers.append("Set-Cookie", c);
      } catch {
        // `Response.redirect()` and `Response.error()` return a response whose
        // headers are IMMUTABLE per the fetch spec, so appending threw — out
        // of the handler, into a 500, with the session cookie lost. That is
        // the textbook login shape (`setCookie(...); return
        // Response.redirect("/dashboard")`), and this helper's own docstring
        // promises setCookie always takes effect. Rebuild the response with
        // mutable headers and carry everything across.
        const headers = new Headers(res.headers);
        for (const c of pending) headers.append("Set-Cookie", c);
        pending.length = 0;
        return new Response(res.body, {
          // `Response.error()` has status 0 and no Location. Turning it into a
          // 302 invented a redirect to nowhere — a wrong-but-plausible answer
          // where 500 is the honest one. (The input is nonsense server-side;
          // the reply should say so rather than guess.)
          status: res.status === 0
            ? (res.type === "error" ? 500 : 302)
            : res.status,
          statusText: res.statusText,
          headers,
        });
      }
      pending.length = 0; // applied — don't let the outer wrap re-apply
      return res;
    };
    /** Merge caller headers over a default content type.
     *
     *  `{...init.headers}` was wrong for two of the three legal `HeadersInit`
     *  forms: a `Headers` instance has no own enumerable properties, so every
     *  header the caller set vanished silently, and the `[["k","v"]]` tuple
     *  form spread into `{"0": [...]}` — a bogus header named `0`. */
    const mergeHeaders = (
      contentType: string,
      init?: ResponseInit,
    ): Headers => {
      const h = new Headers(init?.headers);
      if (!h.has("Content-Type")) h.set("Content-Type", contentType);
      return h;
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
            headers: mergeHeaders("application/json; charset=utf-8", init),
          }),
        ),
      text: (body, init) =>
        withCookies(
          new Response(body, {
            ...init,
            headers: mergeHeaders("text/plain; charset=utf-8", init),
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
