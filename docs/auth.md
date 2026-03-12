# Authentication & Security

For the docs index, see [manual.md](manual.md).

## Remote access (`--expose`)

By default, the server binds to `127.0.0.1` (localhost only). Use `--expose` to share with other devices on your local network:

```sh
deno task dev --expose
```

**What happens:**
1. Server binds to `0.0.0.0` (all network interfaces)
2. A self-signed TLS cert is auto-generated (cached in `.aio-tls/`, regenerated if deleted)
3. Main server listens on HTTPS — `wss://` WebSocket included
4. A random access token is generated and printed to the console
5. All HTTP and WebSocket requests require the token

```
[12:00:00][INFO] tls: self-signed cert at .aio-tls/tls-cert.pem
[12:00:00][WARNING] tls: self-signed — remote browsers will show a security warning. Trust the cert, or use --cert=/path.pem --key=/path.pem for a CA-signed cert
[12:00:00][INFO] running at https://0.0.0.0:8000 (dev, browser)
[12:00:00][INFO] share: https://0.0.0.0:8000?token=a1b2c3d4-...
```

Replace `0.0.0.0` with your machine's LAN IP when sharing. The token is passed via `?token=` query parameter or `Authorization: Bearer` header.

**Browser trust flow (self-signed cert):**
1. Open the share URL in the remote browser
2. Browser shows a security warning ("Your connection is not private")
3. Click "Advanced" → "Proceed to [IP] (unsafe)" (one-time per cert)
4. The cert is cached by the browser — no warning on subsequent visits

**Bring your own cert (CA-signed, no browser warning):**
```sh
deno task dev --expose --cert=/etc/ssl/myapp.pem --key=/etc/ssl/myapp.key
```

**Security notes:**
- Token auth is intended for trusted local networks (LAN demos, testing on phones, team tools) — not internet exposure
- Origin validation is skipped when exposed (the token replaces it)
- The token is a `crypto.randomUUID()` — regenerated on each restart
- **Token-in-URL risk**: `?token=...` appears in server logs, browser history, and HTTPS `Referer` headers. For sensitive deployments use `Authorization: Bearer <token>` header instead
- Electron windows on the same machine accept the self-signed cert automatically (no warning)

## Multi-user auth

Three auth modes:

1. **Public** (default) — no auth, all clients are anonymous
2. **Single token** (`--expose`) — auto-generated UUID, all users are anonymous but verified
3. **Per-user tokens** (`users` config) — static token → user mapping with identity

### Per-user tokens

```ts
import type { AioUser } from 'aio'

const users: Record<string, AioUser> = {
  'alice-secret-123': { id: 'alice', role: 'admin' },
  'bob-secret-456':   { id: 'bob',   role: 'viewer' },
}

await aio.run({
  features: [myFeature],
  users,
  stateForUI: (state, user?) => {
    if (user?.role === 'admin') return state
    return { publicData: state.publicData }
  },
})
```

**Token flow:**
- Browser: append `?token=alice-secret-123` to URL
- Or use `Authorization: Bearer alice-secret-123` header
- Token verified via timing-safe comparison (prevents timing attacks)
- Resolved `AioUser` available in hooks (`onAction`, `onEffect`, `onConnect`, `onDisconnect`)
- WebSocket connections without valid token are rejected with 401

**Startup log** (with `users`):
```
[12:00:00][INFO] share (alice/admin): http://0.0.0.0:8000?token=alice-secret-123
[12:00:00][INFO] share (bob/viewer): http://0.0.0.0:8000?token=bob-secret-456
```

### `AioUser` type

```ts
type AioUser = { id: string; role: string }
```

### Per-user action authorization

Middleware and `beforeReduce` receive the `AioUser` from the WebSocket connection as an optional third parameter. Use this for per-user action authorization:

```ts
aio.middleware.create((action, state, next, user) => {
  if (action.type.startsWith('admin:') && user?.role !== 'admin') return null
  return next(action)
})
```

Or via `beforeReduce`:

```ts
await aio.run({
  features: [myFeature],
  beforeReduce: (action, state, user?) => {
    if (action.type === 'Admin' && user?.role !== 'admin') return null
    return action
  },
})
```

The `user` parameter is `undefined` for server-side dispatches (effects, schedules, etc.).

## Security model

A summary of aio's security posture and known limitations:

### What aio protects

| Threat | Protection |
|--------|-----------|
| Unauthorized WebSocket/HTTP access | Token auth (`--expose` or `users:`) — timing-safe comparison |
| Cross-origin browser requests (localhost) | `Origin` header validation — only same-origin allowed when not exposed |
| State leakage per user | `stateForUI(state, user?)` — server-side filtering per client |
| Trojan API abuse from web | `/__trojan/*` bound to `127.0.0.1` HTTP-only — unreachable from browser even with TLS |
| Reducer/effect crashes taking down server | All errors caught and logged, dispatch loop continues |
| XSS in error overlay | `escHtml()` sanitizes filenames, paths, and error text |

### Known limitations

| Limitation | Mitigation |
|-----------|-----------|
| Self-signed cert warning in browsers | One-time "trust" click; or use `--cert`/`--key` with a CA-signed cert |
| Token appears in URL (`?token=`) | Use `Authorization: Bearer <token>` header instead; avoid sharing URLs in logs |
| Token regenerates on restart | Compile targets pin the token via env or config; `am` tooling doesn't capture it |
| `users:` tokens are static secrets in source | Use environment variables: `'alice-token': Deno.env.get('ALICE_TOKEN')!` |
| `--expose` skips Origin check | Token replaces origin as the auth signal — acceptable for LAN, not internet |

### Intended deployment model

aio is designed for **trusted environments**: localhost tools, LAN dashboards, small teams, desktop apps. The security model is appropriate for:

- Personal tools running on your own machine
- Internal dashboards on a trusted LAN
- Demos and prototypes shared with colleagues

For internet-facing deployments, always put a TLS-terminating reverse proxy in front:

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
