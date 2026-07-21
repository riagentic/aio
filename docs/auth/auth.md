# Authentication & Security

## Remote access (`--expose`)

By default, the server binds to `127.0.0.1` (localhost only). Use `--expose` to
share with other devices on your local network:

```sh
deno task dev --expose
```

**What happens:**

1. Server binds to `0.0.0.0` (all network interfaces)
2. A self-signed TLS cert is auto-generated (cached in `.aio-tls/`, regenerated
   if deleted)
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
[12:00:00][INFO] tls: self-signed cert at .aio-tls/tls-cert.pem
[12:00:00][WARNING] tls: self-signed — remote browsers will show a security warning. Trust the cert, or use --cert=/path.pem --key=/path.pem for a CA-signed cert
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
deno task dev --expose --cert=/etc/ssl/myapp.pem --key=/etc/ssl/myapp.key
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
