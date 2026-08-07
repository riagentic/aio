# Example 5: Integrations — custom routes, uploads, external APIs, auth

How an aio app talks to the world outside its state channel: HTTP endpoints
(webhooks, file uploads), rate-limited external APIs, and pluggable auth.

## Custom HTTP routes

State flows through cells; everything else flows through `routes` — exact paths
or `/prefix/*` wildcards, matched after the framework's own endpoints (`/ws`,
`/__aio/*` are reserved):

```ts
await aio.run({
  appId: "hub",
  cells: [docs],
  routes: {
    // Webhook receiver — validate, then hand off to a cell method
    "/hooks/payment": async (req) => {
      const event = await req.json();
      if (!verifySignature(req.headers, event)) {
        return new Response("bad signature", { status: 401 });
      }
      docs.recordPayment(event.id, event.amount); // → reduce → broadcast
      return new Response("ok");
    },
  },
});
```

### `route()` — params, method guard, cookies, JSON

Raw `(req) => Response` handlers always work, but for typical API/auth endpoints
`route()` adds `:id` params, a method guard, cookie parse/serialize, and a JSON
helper — no library, same `routes` record:

```ts
import { aio, route } from "aio";

await aio.run({
  appId: "api",
  cells: [],
  routes: {
    "/api/users/:id": route((ctx) =>
      ctx.json({ id: ctx.params.id, ip: ctx.ip })
    ),

    "/login": route(async (ctx) => {
      const { user } = await ctx.req.json();
      ctx.setCookie("sid", `sess-${user}`, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
      });
      return ctx.json({ ok: true });
    }, { method: "POST" }),

    "/upload": route(async (ctx) => {
      const file = (await ctx.req.formData()).get("file"); // multipart just works
      return ctx.json({ received: (file as File)?.name });
    }, { method: "POST" }),
  },
});
```

`ctx` gives you `req`, `url`, `params`, `query`, `cookies`, `setCookie()`,
`json()`/`text()`/`redirect()`, plus `user` (the resolved caller, in per-user /
token modes) and `ip`. A `:param` route (`/x/:id`) matches like the existing
`/prefix/*`; queued `setCookie()`s are applied to whatever Response you return.

Cell methods and serverFns the handler calls don't need those threaded down —
they can read the same request from [`serverRequest()`](../auth/auth.md), which
also answers for calls arriving over the WebSocket.

## File uploads (outside the state channel)

Files don't belong in cell state (they'd be persisted, diffed, and broadcast).
Upload through a route, store on disk (or object storage), and keep only
**metadata** in the cell:

```ts
routes: {
  "/upload": async (req) => {
    const form = await req.formData();
    const file = form.get("file") as File;
    if (!file || file.size > 10_000_000) {
      return new Response("file required (≤10MB)", { status: 400 });
    }
    const id = crypto.randomUUID();
    await Deno.writeFile(`uploads/${id}`, new Uint8Array(await file.arrayBuffer()));
    files.add(id, file.name, file.size); // metadata → state → all clients
    return Response.json({ id });
  },
  "/uploads/*": async (req) => {
    const id = new URL(req.url).pathname.split("/").pop()!;
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("bad id", { status: 400 });
    try {
      return new Response(await Deno.readFile(`uploads/${id}`));
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
},
```

The UI uploads with plain `fetch("/upload", { method: "POST", body: form })` —
the state channel then syncs the metadata to every client automatically.

## External APIs with backoff

Own the polling loop with `schedule.backoff` — success resets, failure grows the
delay (see [scheduling](../state/scheduling.md)):

```ts
methods: {
  async refresh(s) {
    try {
      s.rates = await call(() => api.rates());
      s.attempt = 0;
      s.$do(schedule.after("rates:refresh", 60_000, self("refresh")));
    } catch {
      s.attempt = (s.attempt ?? 0) + 1;
      s.$do(schedule.backoff("rates:refresh", s.attempt, self("refresh"), { base: 5_000, max: 300_000 }));
    }
  },
},
// seed at boot
schedules: [{ id: "rates:refresh", after: 1, action: fx.refresh.action() }],
```

## Pluggable auth (any provider)

`resolveUser` turns any bearer token into a user — verify against your provider
(OIDC/JWT/sessions) and return `{ id, role }` or `null`:

```ts
await aio.run({
  appId: "portal",
  cells: [projects],
  resolveUser: async (token) => {
    const claims = await verifyJwt(token, JWKS); // your provider's keys
    return claims ? { id: claims.sub, role: claims.role ?? "viewer" } : null;
  },
});
```

Combine with `visible.forUser` / `visible: { exclude }` for per-role visibility
— see [auth](../auth/auth.md) and
[cell visibility](../state/cell-visibility.md).

## Production monitoring

`GET /__aio/metrics` serves Prometheus text (uptime, memory, connected clients,
per-cell errors, broadcast bytes) — point your scraper at it. See
[production](../debugging/production.md).
