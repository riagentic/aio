# Upgrade: 1.0.0-alpha34 → 1.0.0-alpha35

Purely additive. **No code changes are required** — nothing was removed or
renamed, and the wire protocol is unchanged (alpha34 and alpha35 clients and
servers interoperate). Everything below is something you _may_ adopt, plus one
behaviour change that only affects a linter warning.

## 1. Bump the pin

```jsonc
// deno.json
{
  "imports": {
    "aio": "https://raw.githubusercontent.com/riagentic/aio/v1.0.0-alpha35/mod.ts"
  }
}
```

`aio doctor` now tells you when this pin has drifted from the framework you are
actually running.

## 2. Optional: replace hand-rolled route plumbing with `route()`

If your routes hand-parse `:id` params, guard the method, or parse/serialize
cookies, that code can go. Raw handlers keep working — `route()` is opt-in per
route, not a mode.

```ts
// before
routes: {
  "/api/users/": async (req) => {
    if (req.method !== "GET") return new Response("nope", { status: 405 });
    const id = new URL(req.url).pathname.split("/").pop();
    return Response.json({ id });
  },
}

// after
import { route } from "aio";

routes: {
  "/api/users/:id": route((ctx) => ctx.json({ id: ctx.params.id })),
}
```

One behaviour worth knowing: custom routes now run inside the resolved-user
path, so in per-user / token modes `ctx.user` is populated for your own routes
too (previously only framework routes saw the caller).

## 3. Optional: drop the IP/header threading — `serverRequest()`

If a route currently passes the client IP or a header down into a cell method or
serverFn, it doesn't have to any more:

```ts
// before
routes: { "/vote": route((ctx) => poll.vote(ctx.params.id, ctx.ip)) }
methods: { vote(s, id: string, ip: string) {/* … */} }

// after
import { serverRequest } from "aio";

routes: { "/vote": route((ctx) => poll.vote(ctx.params.id)) }
methods: {
  vote(s, id: string) {
    const ip = serverRequest()?.ip ?? "unknown";
  },
}
```

It works for calls arriving over the WebSocket too (reporting the connection's
upgrade request), and returns `undefined` for server-origin work — schedules,
boot, internal dispatch — so a scheduled job can never inherit a stale request.
It is read-only: to _set_ a cookie, status or header, stay in `route()`.

## 4. Optional: tighten `access` to the row

The predicate now also receives the invoked method and its arguments. Existing
predicates are unaffected — they simply ignore the extra parameters.

```ts
cell("listings", {
  access: (user, _method, id: string) =>
    isOwner(user, id) || user?.role === "admin",
  methods: { edit(s, id: string, patch: Patch) {/* … */} },
});
```

## 5. Optional: retire your test-server boilerplate

```ts
import { freePort, testBrowser, testServer } from "aio/testing";

Deno.test("checkout", async () => {
  await using srv = await testServer({ cells: [cart] });
  const res = await srv.fetch("/api/health");
  await using browser = await testBrowser(`${srv.url}/`);
});
```

If your tests pick ports from a constant or a `Deno.pid` formula, move them to
`freePort()` — overlapping ranges eventually collide and fail whichever test
runs second.

## 6. Heads-up: `aiol` no longer counts documented cells

If you relied on `aiol` reporting cells that only exist in a doc comment or in a
code-generator's template literal (and on the `duplicate cell name` error that
came with them), that's gone — extraction now reads real code only. Your cell
count may drop; that number is now the true one. `aiol --no-hints` silences
hint-severity lines when you want a zero-noise run.

## New in the public API

`route`, `RouteContext`, `RouteOptions`, `CookieOptions`, `serverRequest`,
`ServerRequest`, `generateTotpSecret`, `totpUri`, `verifyTotp`, `Avatar`,
`Pagination`, `Confirm`, `ConfirmButton`, `toast`, `ToastHost`, `Markdown`,
`testServer`, `testBrowser`, `findChromium`, `freePort`, `JSX.Node`,
`JSX.Children`.
