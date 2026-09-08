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

### Fewer false alarms

`aiol` stopped reporting six things that were correct: a visibility hint that
probed `ui:` (a key `cell()` throws on, so it could never be satisfied), the
update data gate reading only `persist: false` and not `"none"` or
`scope: "client"`, the timer rule flagging a component timer that IS cleared in
`onCleanup`, the `never[]` rule ignoring an outer `as State`, the post-await
rule flagging argument evaluation, and `// aiol-ok` counting only on the last
comment line. The renderer stopped asking `<summary>` for a keyboard handler it
already has, and stopped calling a `null` child an unkeyed sibling.

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
