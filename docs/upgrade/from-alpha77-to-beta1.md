# Upgrading from alpha77 to beta1

**Nothing breaks.** The public surface was frozen on 2026-09-04
(`docs/basics/semver-policy.md`): every export, signature, flag, config key and
wire frame of alpha77 is byte-identical here, and `check:api` refuses the first
release where that stops being true. There is no step to perform.

```sh
am pin --latest
```

Beta is a **quality** statement, not a new stability promise — the promise did
not change, and does not until 2.0.0.

## What got better

beta1 answers nine field reports from nine real apps, read end to end with every
finding verified against the code. The full account is `CHANGELOG.md`; this is
what you will notice.

### Two doors that were documented and unreachable

- **`route()` ships from `aio/server`**, with `RouteContext`, `RouteMatch`,
  `RouteOptions`, `RawRouteHandler`, `CookieOptions`, `parseCookies` and
  `serializeCookie`. If you hand-rolled `:id` parsing —
  `new URL(req.url).pathname.split("/")[2]` — you can delete it, along with the
  traversal guard you had to remember to write.
- **`aio/log`** is the logger as a leaf: 13 modules against the barrel's 260. If
  a non-UI process of yours imports `log` from `"aio"`, this is a one-line
  change that removes the vdom renderer, the build system, the Electron target
  and the CRDT engine from its module graph.

### Things the framework now tells you

All of these are **dev-only** and cost a production build nothing.

- **A read inside `afterRender`/`onMount` that the render body did not make**
  now warns, naming the value, the component and the consequence. That effect
  runs once and never again — the bug that reports itself as "it works
  sometimes".
- **Unreadable text** is reported by a contrast walk of the committed DOM.
- **A `#id` in your stylesheet that matches no element** warns once and names
  `#root`, which is what aio mounts into.
- **A short `am dispatch`** carries `short` in its reply instead of only warning
  into the server log.
- **A renderer log line names where it was written**, not
  `console-intercept.ts:73`.

### New surface

- **`am eval '<js>'`** — geometry, computed styles, and a fetch from the page's
  own origin. Needs `--cdp`, like `am shot`.
- **`am instances` reports `cdpPort`.** Stop grepping `ss -ltnp`: on a machine
  with two aio apps that resolves silently into the other one's DOM.
- **`build.css`** runs your CSS toolchain before every dev reload and every
  build; `am create --css=tailwind` wires it. See
  [docs/ui/css-toolchain.md](../ui/css-toolchain.md).
- **`t.expect.rejects` / `t.expect.throws`** — a refusal is a first-class
  assertion now.
- **`t.fuzz({ n, seed?, skip? })`** — a replayable, filterable `randomActions`.
- **`t.init()` reaches all the way down** — a nested object no longer has to be
  supplied whole.
- **A literal route pattern types its own params.** `useRoute("/users/:id")`
  gives `params.id`, and `params.idd` is a compile error. Your existing calls,
  including `useRoute<{ id: string }>(…)`, are unchanged.
- **`docs/AGENTS.md`** — five verbs for driving an app with no human in the
  loop.
- **`s.$do(notify({ title, body?, tag?, silent?, route? }))`** — a desktop
  notification, from a method: every connected UI client shows it (browser,
  Electron, PWA), a click focuses the app and follows `route`, and a server with
  no client says so. `requestNotificationPermission()` (`aio/air`) for the
  browser's gesture rule. See [notifications](../clients/notifications.md).
- **`ui.tray`** — a system tray icon for Electron: `true`, or
  `{ tooltip, menu, closeToTray }`; menu items dispatch `"cell:method"` through
  the page or navigate to a `route`. Browser and Android ignore it.
- **`spawn(cmd, { stdin: true })`** — `handle.stdin.write()` / `close()`; off by
  default so a child that reads a pipe still gets EOF at once.
- **`app.loadSnapshot(json, { force: true })`** on the public handle — the
  override the operator doors already honoured.

### Fewer false alarms

`aiol` stopped reporting six things that were correct: a visibility hint that
probed `ui:` (a key `cell()` throws on, so it could never be satisfied), the
update data gate reading only `persist: false` and not `"none"` or
`scope: "client"`, the timer rule flagging a component timer that IS cleared in
`onCleanup`, the `never[]` rule ignoring an outer `as State`, the post-await
rule flagging argument evaluation, and `// aiol-ok` counting only on the last
comment line. The renderer stopped asking `<summary>` for a keyboard handler it
already has, and stopped calling a `null` child an unkeyed sibling.

## Widened, not changed

`s.$do` now also accepts a `NotifyEffect`, and `loadSnapshot` an optional second
argument. Both are widenings of a parameter on a type only the framework
constructs (`@served`); every existing call compiles unchanged, and `check:api`
classifies them additive by a rule pinned in both directions
(`tests/api-served-widening.test.ts`).

## The one recorded surface change

`VERSION` is annotated `export const VERSION: string` rather than inferring the
literal `"1.0.0-beta1"`. It is a **widening** — `VERSION === "1.0.0-alpha76"`
was a compile error under the literal type and is now an ordinary comparison —
and it is recorded here because `check:api` requires a decision to be written
down rather than absorbed. Nothing to do: the only shape that could break is
`const x: "1.0.0-alpha77" = VERSION`.

Why it was worth taking once: with the literal inferred, **every release bump
reported itself as a breaking change**, at exactly the moment somebody is
cutting a release and inclined to regenerate without reading.

## Stricter now — where an alpha77 app can notice

None of these is a surface change. Each was silent, lenient or wrong on alpha77
and now says so — and each is listed because a test, a script or a habit could
have leaned on the old silence. The wire is protocol v3 as before; `hello.rate`
and the dev-only `patch` frame are additions an alpha77 peer ignores.

| what                                                                                                                           | alpha77                                                                           | beta1                                                                                                    | if it hits you                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `testCell`: a framework effect (`schedule.*`, `own.*`) that no dispatch ran (`settle()`) and no assertion read                 | green                                                                             | fails at the end of the test, naming the effect                                                          | read it (`t.getEffects()`, `t.expect.effects`), `settle()` it, or use `bootCells`/`testUI` |
| `POST /__aio/trojan/dispatch` for a write `validate` refused, a method the cell lacks, a cell never booted or breaker-disabled | `200 {"ok":true}`                                                                 | `409 {"ok":false}`; `am dispatch` exits 1                                                                | a script that read `ok` was reading a lie — read the reason it now carries                 |
| `am dispatch cell:method '{"args":[…]}'` (positional)                                                                          | parsed as one object argument, corrupting state                                   | refused, naming `--args=[…]`                                                                             | `--args='[…]'`; the literal object stays reachable as `--args='[{"args":[…]}]'`            |
| a `spawn()`ed child still running at shutdown                                                                                  | outlived the app, invisibly                                                       | killed in shutdown phase 7, logged with the command and the `own.set` line that would have tied it       | tie it with `own.set`; a child meant to outlive the app is not what `spawn()` is for       |
| `connectCli` offline queue                                                                                                     | flushed into whatever answered on that port; at 100 queued, refused the NEWEST    | verifies `appId` from `/__aio/health` before reopening; at cap evicts the OLDEST and rejects that caller | none, unless a script leaned on the old cap rule                                           |
| a method payload JSON cannot carry (a BigInt, a cycle)                                                                         | threw inside the transport online; queued offline, then lost everything behind it | refused at the call site, online and offline, naming the action                                          | fix the payload                                                                            |
| `onMount(() => fn)` returning a function                                                                                       | return value dropped                                                              | registered as the cleanup, exactly like `onCleanup(fn)`                                                  | if you ALSO wrote `onCleanup(fn)` beside it, delete one — it runs twice otherwise          |
| `<ErrorBoundary>` on a re-render throw                                                                                         | error propagated; the boundary caught only the first render                       | the fallback renders, with the error                                                                     | none — the documented contract, now kept                                                   |
| the HTTP accept loop dying (`EMFILE`, a low `ulimit -n`)                                                                       | process stayed up with nothing listening                                          | exits 1 with the reason, so a supervisor restarts it                                                     | none                                                                                       |
| a sync burst over the server's per-connection rate                                                                             | client closed and denylisted for a minute                                         | paced at 60 % of the advertised `rate`; it lands                                                         | none — slower, and it succeeds                                                             |
| `application/wasm`, and any compressible body over 8 MB                                                                        | sent raw                                                                          | gzip/br when accepted; streamed above 8 MB, so no `Content-Length`                                       | a progress bar reading `Content-Length` on a `.wasm` shows indeterminate                   |
| an `async visible.forUser`                                                                                                     | the cell reached every client as `{}`, silently                                   | still `{}`, with a `log.error` naming the cell and the fix                                               | make the filter synchronous                                                                |
| `am fix` on a three-part `"version"`                                                                                           | rewrote it to two parts                                                           | advises, writes nothing                                                                                  | none                                                                                       |
| `am restart`                                                                                                                   | dropped the app's launch flags                                                    | keeps them                                                                                               | to shed a flag: `am stop`, then `am start` without it                                      |
| draft root key `$call`, cell-stub property `$pending`                                                                          | —                                                                                 | reserved, like `$do` and `$live`                                                                         | a state field literally named `$call` is shadowed on the draft                             |

Dev-only, never in a production build, all observe-only: an `App.tsx`-only edit
is a `patch` (the module is re-imported and swapped in — module-level code in
that one file runs again; `useLocal`, scroll and an embedded `<webview>`
survive), the `*.server.ts` did-not-reload notice, the watcher following a
path-imported framework, the boot line for a NEW state field, the short-argument
warning, the contrast walk, and the error overlay.

### How this was checked

An app scaffolded by alpha77's own `am create`, with `dep/aio` pointed at beta1:
`deno task check`, its starter test and `deno task build` are green, and the
browser binary runs. alpha77's five example apps boot on beta1, serve the shell,
answer `/__aio/health` and stop with `errors=0`. Across every file that declares
a public type, the only line removed since alpha77 is the `VERSION` literal
above.

## Retire

Workarounds an app may still carry for bugs fixed here — each safe to delete
now, with the version that fixed it.

| workaround                                                                                        | fixed in |
| ------------------------------------------------------------------------------------------------- | -------- |
| a hand-rolled `:param` parser (and its traversal guard) written because `route()` was unreachable | beta1    |
| a hand-declared `{ params: Record<string, string> }` for a raw route handler's second argument    | beta1    |
| a deep import of `dep/aio/src/diagnostics/logger.ts` to avoid the barrel                          | beta1    |
| an `onCleanup(...)` added beside `onMount` only because the returned cleanup was dropped          | beta1    |
| a hidden placeholder element rendered to silence "Mixed keyed and unkeyed children"               | beta1    |
| an `onKeyDown` on `<summary>`, `<label>` or `<option>` added only to silence the a11y warning     | beta1    |
| `visible: { publicFields: [...] }` on a field named `monkey`, `keyboard`, `seedling` or `privacy` | beta1    |
| a field renamed away from `passwordless` because the boot refused it                              | beta1    |
| `// aiol-ok` moved to the last line of a comment block, or an explanation deleted to make it work | beta1    |
| `version: 1` added to a `persist: "none"` or `scope: "client"` cell only to quiet the data gate   | beta1    |
| a `cfg()` helper written because `t.init()` could not take a partial nested object                | beta1    |
| `assertRejects` imported into a cell test because `t.expect.rejects` did not exist                | beta1    |
| a hand-written CDP client for geometry or computed styles (`am eval` does it)                     | beta1    |
| `ss -ltnp` scraping to find an app's DevTools port (`am instances` reports `cdpPort`)             | beta1    |
| a message prefix (`[gate]`, `[capture]`) added only to tell renderer log lines apart              | beta1    |
| `useRoute<{ id: string }>("/users/:id")` where the pattern is a literal — the type is inferred    | beta1    |
| `deno.json` `build.css` run by hand in a second terminal beside `deno task dev`                   | beta1    |
