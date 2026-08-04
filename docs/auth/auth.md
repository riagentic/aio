# Authentication & Security

## Remote access (`--expose`)

By default, the server binds to `127.0.0.1` (localhost only). Use `--expose` to
share with other devices on your local network:

```sh
deno task dev --expose
```

**What happens:**

1. Server binds to `0.0.0.0` (all network interfaces)
2. A self-signed TLS cert is auto-generated (cached in `~/.<appId>/data/tls/`,
   regenerated if deleted)
3. Main server listens on HTTPS — `wss://` WebSocket included
4. **No framework auth by default** — any device on the LAN can connect (the app
   does its own user auth, or is deliberately open for a trusted network)

**Choosing the key** — the `key` option, three modes plus the default:

```ts
await aio.run(); // default: NO framework auth (open on the LAN)
await aio.run({ key: true }); // a key generated ONCE and persisted
// (same across restarts — "one key, use forever")
await aio.run({ key: "team-2024" }); // a fixed key you choose
await aio.run({ key: false }); // explicit: no framework auth
```

`key: true` persists the key in the data dir, so it doesn't churn on every
restart. `users` / `resolveUser` (below) still take precedence for multi-user
auth.

**Pairing the aio client** — when a key is set, `--expose` prints a **pair
code** on startup. In the aio client, click the app under "Apps on your network"
and type the 6-digit code; the client pulls the profile (cert + key) once and
connects forever after. The code is attempt-limited and session-scoped — restart
to issue a fresh one. (For headless/scripted setups, `am profile` exports a
`.aioapp` file you import instead — see [the client](../clients/electron.md).)

```
[12:00:00][INFO] tls: self-signed cert at ~/.<appId>/data/tls/tls-cert.pem
[12:00:00][WARNING] tls: self-signed — browsers show a security warning, and non-browser clients (curl, deno/node fetch, the aio CLI client) REFUSE the connection outright unless they trust this exact cert. Hand it out with `am profile --app=<appId>`, point a client at it with DENO_CERT=<certPath> (curl: --cacert), or pass --tls-cert=/path.pem --tls-key=/path.pem for a CA-signed one
[12:00:00][INFO] running at https://0.0.0.0:8000 (dev, browser)
[12:00:00][INFO] share: https://0.0.0.0:8000?token=a1b2c3d4-...
[12:00:00][INFO] pair code: 048583  (enter it in the aio client → Add app)
```

Replace `0.0.0.0` with your machine's LAN IP when sharing. The token is passed
via `?token=` query parameter or `Authorization: Bearer` header.

**Browser trust flow (self-signed cert):**

1. Open the share URL in the remote browser
2. Browser shows a security warning ("Your connection is not private")
3. Click "Advanced" -> "Proceed to [IP] (unsafe)" (one-time per cert)
4. The cert is cached by the browser — no warning on subsequent visits

**Bring your own cert (CA-signed, no browser warning):**

```sh
deno task dev --expose --tls-cert=/etc/ssl/myapp.pem --tls-key=/etc/ssl/myapp.key
```

**Security notes:**

- Token auth is intended for trusted local networks (LAN demos, testing on
  phones, team tools) — not internet exposure
- Origin validation is skipped when exposed (the token replaces it)
- With `key: true` the token is a persisted `crypto.randomUUID()` (stable across
  restarts); with `key: "..."` it's your fixed string
- **Token-in-URL risk**: `?token=...` appears in server logs, browser history,
  and HTTPS `Referer` headers. For sensitive deployments use
  `Authorization: Bearer <token>` header instead. AIO logs a warning at startup
  when `--expose` is active with token auth.
- When TLS is active, the internal trojan API on localhost also requires the
  same token — unauthenticated localhost access is no longer permitted
- Electron windows on the same machine accept the self-signed cert automatically
  (no warning)

## Multi-user auth

Four auth modes:

1. **Public** (default, incl. `--expose`) — no framework auth, all clients are
   anonymous
2. **Single key** (`key: true` / `key: "..."`) — persisted or fixed token, all
   users are anonymous but verified; pair the aio client with the printed code
3. **Per-user tokens** (`users` config) — static token -> user mapping with
   identity
4. **Dynamic resolution** (`resolveUser` config) — custom hook for JWT, OAuth,
   database lookup, or any async verification

### Per-user tokens

```ts
import { aio, type AioUser, cell } from "aio";

const users: Record<string, AioUser> = {
  "alice-secret-123": { id: "alice", role: "admin" },
  "bob-secret-456": { id: "bob", role: "viewer" },
};

const myCell = cell("myCell", {
  state: { publicData: {}, secret: {} },
  methods: {/* ... */},
  ui: {
    include: ["publicData", "secret"],
    forUser: (exposed, user?) =>
      user?.role === "admin" ? exposed : { publicData: exposed.publicData },
  },
});

await aio.run({ cells: [myCell], users });
```

**Token flow:**

- Browser: append `?token=alice-secret-123` to URL
- Or use `Authorization: Bearer alice-secret-123` header
- Token verified via timing-safe comparison (prevents timing attacks)
- Resolved `AioUser` available in hooks (`onAction`, `onEffect`, `onConnect`,
  `onDisconnect`)
- WebSocket connections without valid token are rejected with 401

**Startup log** (with `users`):

```
[12:00:00][INFO] share (alice/admin): http://0.0.0.0:8000?token=alice-secret-123
[12:00:00][INFO] share (bob/viewer): http://0.0.0.0:8000?token=bob-secret-456
```

### Dynamic user resolution (`resolveUser`)

For apps that need JWT verification, database lookups, or external auth
providers, use the `resolveUser` hook instead of static tokens:

```ts
import { aio, type ResolveUserFn } from "aio";
import { myCell } from "./cell/my-cell.ts";
import { verifyJwt } from "./jwt.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

const resolveUser: ResolveUserFn = async (token, state) => {
  // Example: verify JWT and return user
  try {
    const payload = await verifyJwt(token, JWT_SECRET);
    return { id: payload.sub, role: payload.role };
  } catch {
    return null; // reject — 401
  }
};

await aio.run({ cells: [myCell], resolveUser });
```

**How it works:**

- Token is extracted from `?token=` query param or `Authorization: Bearer`
  header (same as static `users`)
- `resolveUser(token, state)` is called with the extracted token and current app
  state
- Return `AioUser` to authenticate, `null` to reject (401)
- Supports async — return a `Promise<AioUser | null>` for JWT verification,
  database lookups, etc.
- If both `resolveUser` and `users` are set, `resolveUser` takes precedence

**Type:**

```ts
type ResolveUserFn<S = unknown> = (
  token: string,
  state: S,
) => AioUser | null | Promise<AioUser | null>;
```

### `AioUser` type

```ts
type AioUser = { id: string; role: string };
```

### Per-user action authorization

`beforeReduce` receives the `AioUser` from the WebSocket connection as an
optional third parameter. Use this for per-user action authorization:

```ts
await aio.run({
  cells: [myCell],
  beforeReduce: (action, state, user?) => {
    if (action.type.startsWith("admin:") && user?.role !== "admin") return null;
    return action;
  },
});
```

The `user` parameter is `undefined` for server-side dispatches (effects,
schedules, etc.).

### Declarative cell access (`access`)

Instead of string-matching action types in `beforeReduce`, declare who may act
on a cell over the network directly on the cell:

```ts
cell("orders", {
  state: { items: [] },
  access: true, // any authenticated user ("admin" = that role; predicate = custom)
  methods: {/* … */},
});

cell("billing", {
  state: { invoices: [] },
  // predicate sees (user, method): read for everyone logged in, writes admin-only
  access: (user, method) => method.startsWith("get") || user?.role === "admin",
  methods: {/* … */},
});
```

A denied network action is dropped before dispatch and audit-logged
(`[aio] auth: …`). Server-side code (effects, schedules, your own calls) always
bypasses `access` — the server trusts its own code.

**Row-level access.** The predicate also receives the method's call args, so
"edit only your own row" is one line — no per-method owner re-check:

```ts
cell("docs", {
  state: { byId: {} as Record<string, Doc> },
  // (user, method, ...args) — args are the method's arguments
  access: (user, _method, docId) =>
    docs.byId[docId as string]?.owner === user?.id,
  methods: {
    rename(s, docId: string, title: string) {/* … */},
  },
});
```

### Who is calling? (`serverUser`)

Anywhere on the server — cell methods, serverFns, effects — `serverUser()`
returns the authenticated caller of the current execution (survives `await`):

```ts
import { cell, serverUser } from "aio";

cell("cart", {
  state: { items: {} as Record<string, string[]> },
  access: true,
  methods: {
    addItem(s: { items: Record<string, string[]> }, sku: string) {
      const me = serverUser()!; // access:true guarantees a user
      (s.items[me.id] ??= []).push(sku);
    },
  },
});
```

`undefined` means anonymous client (public/shared-key mode) or server-origin
execution.

#### Testing a method that reads `serverUser()`

`t.as(user, fn)` sets the ambient caller for the calls inside it — no server, no
login round trip, no reaching into framework internals:

```ts
testCell(cart, "each user gets their own cart", async (t) => {
  await t.as({ id: "alice", role: "member" }, () => t.send.add("sku-1"));
  await t.as({ id: "bob", role: "member" }, () => t.send.add("sku-2"));

  assertEquals(t.getState().items["alice"], ["sku-1"]);
  assertEquals(t.getState().items["bob"], ["sku-2"]);
});
```

Call without it to assert the anonymous path — that is what a public client
gets, and it is the case guards most often forget:

```ts
await t.send.add("sku-1"); // serverUser() === undefined inside the method
```

### Where from? (`serverRequest`)

The companion ambient: `serverRequest()` reports the transport facts of the call
in flight — the things a caller can't forge — in cell methods, serverFns and
effects, across `await`s, with no parameter threading:

```ts
import { cell, serverRequest } from "aio";

cell("login", {
  state: { tries: {} as Record<string, number> },
  methods: {
    attempt(s: { tries: Record<string, number> }, user: string, pw: string) {
      const req = serverRequest();
      const ip = req?.ip ?? "unknown"; // rate-limit key the client can't set
      if ((s.tries[ip] = (s.tries[ip] ?? 0) + 1) > 5) {
        throw new Error("slow_down");
      }
      const locale = req?.headers.get("accept-language") ?? "en";
      const sid = req?.cookies.sid; // parsed for you
    },
  },
});
```

| Field                | Notes                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `ip`                 | Remote IP as the server sees it (`undefined` on transports without one) |
| `headers`, `cookies` | Request headers + parsed cookies                                        |
| `url`, `method`      | Full URL; `"GET"` for a WS upgrade                                      |
| `via`                | `"http"` (route) or `"ws"` (frame on a live socket)                     |

Over WS the facts are the **connection's** (the upgrade request), not the
individual frame's. `undefined` means nothing requested this execution —
schedules, boot, internal dispatch.

It is deliberately **read-only**. To _set_ a cookie, status or header, use
[`route()`](../examples/05-integrations.md) — one write path, not two.

### serverFn access

Server functions accept the same rule vocabulary; inside the body,
`serverUser()` identifies the caller:

```ts
export const api = serverFns("api", {
  refund: async (orderId: string) => {/* … */},
}, { access: "admin" });
```

The predicate form receives the invoked function name and its args too —
`(user, fn, ...args) => boolean` — for per-function or row-level checks.

### Sessions (`sessions: true`)

Static tokens never expire and can't be revoked. The built-in session store
(SQLite in the data dir, tokens hashed at rest) adds the missing lifecycle:

```ts
const app = await aio.run({ cells: [/* … */], sessions: true }); // 30-day TTL

// login (e.g. in a serverFn after verifying credentials):
const token = app.sessions!.issue({ id: "alice", role: "user" });
// the client then connects with ?token= / Authorization: Bearer

app.sessions!.refresh(token); // sliding expiry
app.sessions!.revoke(token); // logout — cuts access immediately
app.sessions!.revokeUser("alice"); // kick every session (breach response)
```

Session tokens resolve ahead of `users`/`resolveUser` and compose with both.
`sessions: { ttlMs: 3_600_000 }` overrides the default TTL.

### Built-in password auth (`auth: true`)

The full login system — no external identity provider required:

```ts
const app = await aio.run({ cells: [/* … */], auth: true });
// endpoints now live:
//   POST /__aio/auth/signup { id, password } → 201 { user, token } (+cookie)
//   POST /__aio/auth/login  { id, password } → 200 { user, token } (+cookie)
//   POST /__aio/auth/logout                  → revokes + clears cookie
//   GET  /__aio/auth/me                      → { user | null }
```

- Passwords: PBKDF2-HMAC-SHA-256 (WebCrypto, OWASP iteration count), per-user
  salt, timing-safe verify, no account enumeration (unknown ids burn a real
  hash). 8-character NIST minimum enforced.
- Sessions: issued from the AUTH-1 store on signup/login; the token doubles as
  an `HttpOnly; SameSite=Strict` cookie (+ `Secure` under TLS) so browsers
  authenticate the WS handshake without tokens in URLs.
- CSRF: SameSite=Strict cookie + an Origin same-host check on every POST.
- The app **shell is public** in auth mode (a browser must load the login UI
  before it has a session); `/ws` and `/__aio/snapshot` stay gated — state never
  flows unauthenticated.
- `auth: { signup: false }` disables open registration — seed accounts with
  `app.auth.create("root", password, "admin")`.
- Failed logins burn the per-IP budget below.

Client side, the typed wrapper drives the same endpoints:

```ts
import { authClient } from "aio"; // same-origin; createAuthClient(base) for CLI

const r = await authClient.login("alice", "password123");
if ("totpRequired" in r) await authClient.totp(r.pending, "123456"); // 2FA step
await authClient.logout();
```

### Drop-in login UI (`<SignIn/>` + `useUser()`)

The browser side is two imports — no auth UI to build:

```tsx
// snippet: fragment
import { SignIn, signOut, useUser } from "aio/air";

export default function App() {
  const user = useUser(); // reactive: undefined = resolving, null = anonymous
  if (user === undefined) return <p>…</p>;
  if (user === null) return <SignIn />; // login + signup + TOTP step built in
  return (
    <div>
      Hello {user.id}! <button type="button" onClick={signOut}>Sign out</button>
    </div>
  );
}
```

`<SignIn/>` handles login, signup (with optional email), friendly error text,
and the TOTP second-factor step; on success the page reloads and the session
cookie authenticates the WebSocket. It also **adapts to the server config
automatically** (via `/me` features): the signup toggle disappears when
`signup: false`, and a "Continue with SSO" button appears when OIDC is
configured — carrying the current page as the post-login return path. Props:
`title`, `signup: false`, `sso: false`, `ssoLabel`, `email: false`, `style`.

### Email verification & password reset

Plug in any mail transport — the framework does the tokens:

```ts
await aio.run({
  cells: [/* … */],
  auth: {
    requireVerified: true, // no login until the email is proven
    sendMail: ({ to, subject, text }) => sendWithSesOrSmtp(to, subject, text),
  },
});
```

- Signup (with `requireVerified`) mails a 24h one-shot verification token and
  issues **no session** until `POST /__aio/auth/verify { token }` proves the
  mailbox.
- `POST /__aio/auth/reset/request { id }` **always returns 200** (no account
  enumeration) and mails a 15-minute one-shot reset token when the account has
  an email. `POST /__aio/auth/reset { token, password }` sets the new password
  and **revokes every session**.
- `POST /__aio/auth/password { old, new }` (authenticated) rotates the password
  and all other sessions.
- Tokens are stored hashed and are strictly one-shot.

### TOTP two-factor (RFC 6238)

Any authenticator app (Google Authenticator, Aegis, 1Password…):

```ts
const { secret, uri } = await authClient.totpSetup(); // uri → QR code
await authClient.totpEnable("123456"); // code from the app confirms enrollment
```

After enrollment, `login` returns `{ totpRequired, pending }` — complete with
`authClient.totp(pending, code)` (5-minute window, one attempt per pending
token; a wrong code sends the user back to login). Disable requires the
password. `auth: { totp: false }` turns enrollment off app-wide.

### OIDC / social login (authorization code + PKCE)

Config-only — discovery, PKCE, and RS256 JWKS verification are built in:

```ts
await aio.run({
  cells: [/* … */],
  auth: {
    oidc: {
      issuer: "https://accounts.google.com",
      clientId: Deno.env.get("OIDC_CLIENT_ID")!,
      clientSecret: Deno.env.get("OIDC_CLIENT_SECRET"), // omit for pure PKCE
      role: (claims) => claims.email === "boss@corp.com" ? "admin" : "user",
    },
  },
});
// Point a "Continue with …" button at /__aio/auth/oidc/start — done.
```

The callback verifies the ID token (issuer, audience, expiry, signature via the
provider's JWKS), upserts the user by `sub` (existing users keep their
server-assigned role), issues a session cookie, and redirects to `/`. The state
parameter is a stored one-shot token carrying the PKCE verifier — replay is dead
on arrival.

### Account lockout

Independent of the per-IP budget: **5 consecutive wrong passwords lock the
account for 15 minutes** (login answers `423`), and even the correct password is
refused while locked. A successful login resets the counter. Timing is uniform
across unknown/locked/wrong paths — one PBKDF2 each, no enumeration.

### Operator console (`am auth`)

Direct auth.db access — no running server needed. This is how you seed the first
admin, or get back in when you're locked out:

```sh
am auth users                      # list accounts (role, email, 2FA, locked)
am auth create root --role=admin   # no --password → generates + prints one
am auth passwd alice               # reset a password (also clears lockout)
am auth unlock alice               # clear a lockout
am auth role alice editor
am auth revoke alice               # kill every session of a user
am auth verify alice               # mark email verified by hand
am auth rm alice
```

### Brute-force protection

Failed auth attempts are budgeted per client IP (10 per 5-minute sliding window
→ `429`), and every failure is audit-logged. Successful requests never consume
budget.

## Security model

A summary of aio's security posture and known limitations:

### What aio protects

| Threat                                    | Protection                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unauthorized WebSocket/HTTP access        | Token auth (`--expose`, `users`, or `resolveUser`) — timing-safe comparison for static tokens |
| Cross-origin browser requests (localhost) | `Origin` header validation — only same-origin allowed when not exposed                        |
| State leakage per user                    | Cell-level `ui: { include, forUser }` — server-side filtering per client                      |
| Trojan API abuse from web                 | `/__aio/trojan/*` bound to `127.0.0.1` HTTP-only — unreachable from browser even with TLS     |
| Reducer/effect crashes taking down server | All errors caught and logged, dispatch loop continues                                         |
| XSS in error overlay                      | `escHtml()` sanitizes filenames, paths, and error text                                        |

### Keeping secrets out of clients and disk

A secret state field (API key, session token) needs **both** excludes — they are
independent channels:

```ts
cell("settings", {
  state: { theme: "dark", apiKey: "" },
  persist: { exclude: ["apiKey"] }, // never written to disk
  ui: { exclude: ["apiKey"] }, // never synced to browsers
});
```

`/__aio/snapshot` (state export/import for tooling) returns **raw, unfiltered
state**. In multi-user mode (`users`/`resolveUser`) it therefore requires
`role: "admin"`; in single-token mode the token holder is the owner. Treat
snapshot files like backups: they contain everything, including fields hidden
from `ui`.

### Known limitations

| Limitation                                   | Mitigation                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-signed cert warning in browsers         | One-time "trust" click; or use `--cert`/`--key` with a CA-signed cert                                                                                                |
| Token appears in URL (`?token=`)             | Use `Authorization: Bearer <token>` header instead; avoid sharing URLs in logs                                                                                       |
| Token regenerates on restart                 | Compile targets pin the token via env or config; `am` tooling doesn't capture it                                                                                     |
| `users:` tokens are static secrets in source | Use environment variables: `'alice-token': Deno.env.get('ALICE_TOKEN')!`                                                                                             |
| `--expose` origin policy                     | Origin is always validated: localhost + the server's own host + `allowedOrigins` pass, everything else is 403; `strictOrigin: true` additionally requires the header |

### Intended deployment model

aio is designed for **trusted environments**: localhost tools, LAN dashboards,
small teams, desktop apps. The security model is appropriate for:

- Personal tools running on your own machine
- Internal dashboards on a trusted LAN
- Demos and prototypes shared with colleagues

For internet-facing deployments, always put a TLS-terminating reverse proxy in
front:

```nginx
# nginx example
location / {
  proxy_pass http://127.0.0.1:8000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

Caddy is simpler — `reverse_proxy localhost:8000` with automatic HTTPS.
