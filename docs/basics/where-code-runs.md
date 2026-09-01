# Where does this code run?

aio has one syntax and six places it executes. Almost nothing in a source file
says which one you are in — that invisibility is what makes the framework
pleasant, and it is also where the expensive bugs live. This page is the map.

Read this page when something works in `deno task dev` and not in the artifact,
when a `Deno.*` call is suddenly undefined, or when a read returns nothing.

## The six contexts

| Context                | Side           | Reached by                                                    | `Deno.*` | Reads hidden (`visible.exclude`) fields | Reads are tracked | The thing that surprises people                                        |
| ---------------------- | -------------- | ------------------------------------------------------------- | -------- | --------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| a component body       | client context | AIR renders it                                                | no       | no — the read **throws**                | **yes**           | the only window where a read subscribes                                |
| an event handler       | client context | a click, a lifecycle hook, a timer, anything after an `await` | no       | no — the read **throws**                | no                | reads here do not subscribe — the body already returned                |
| a sync method          | server context | `cell.method()`                                               | no       | no                                      | no                | under `sync`/`localFirst`/`scope:"client"` it ALSO runs in the browser |
| an async method        | server context | `await cell.method()`                                         | yes      | yes                                     | no                | a call ceiling; `serialize` holds a per-cell mutex                     |
| a `*.server.ts` module | server context | `await import()` from server code only                        | yes      | yes                                     | no                | a STATIC import of one is refused, loudly                              |
| a worker isolate       | server context | a method on a `worker: true` cell                             | yes      | yes                                     | no                | its own isolate — no shared module state, no peer cells                |

Every one of those rows is a rule some app learned by shipping. The rest of this
page is each row, with the error you will actually see.

**These are the names.** The table is not prose — it is
`src/diagnostics/contexts.ts`, and a gate checks the two match row for row.
Every error, every lint finding and `am where` name a context in exactly these
words, so a name you read once is the name you will see again. Two of them are
worth saying out loud, because the same idea used to have five spellings across
the source (`browser`, `renderer`, `standalone`, `isolate`, `client context`):

- **client context** — wherever your UI runs: a browser tab, the Electron
  window, a standalone/Android build, `testUI`. When a message means _the side_,
  it says this. When it means a browser specifically, it still says browser.
- **server context** — the app process: methods, effects, `routes`, worker
  isolates.

## Component body — the only tracked window

A read subscribes **only** while the component body is running synchronously.
That is the whole rule, and its consequences are covered in
[Reactivity tracking](../ui/reactivity-tracking.md), including the two shapes
that look like reads and are not: a read deferred past an `await`, and a **cache
hit that returns before touching the cell**.

No `Deno.*`, and no filesystem: this code is in a browser. A component that
needs server work calls a method.

## Event handler / `onMount` — same isolate, different moment

Handlers, `onMount`, `onCleanup`, `afterRender`, `setTimeout` and anything past
an `await` all run _after_ the body returned. They can read and write state
freely; what they cannot do is **subscribe**. If a UI is stale, this is the
first thing to check.

## Sync method — and it may run twice

A sync method is a reducer: `(state, args) => void`, no `await`, no I/O. On the
server that is all it is.

If the cell is `sync: true`, adopted by `localFirst`, or `scope: "client"`, the
**same function also runs in the browser** as an optimistic replay. Two things
follow, and both have cost real time:

- A side effect in the reducer happens **twice** — once in the replay, once for
  real. Effects are the exception: during a replay `s.$do` swallows them,
  because they already ran on the server.
- A read of a `visible.exclude` field is correct-looking TypeScript that
  **throws when the reducer replays in the browser** — the field is not there.

Both are decidable from the cell definition, so `aiol` refuses them rather than
letting you find out live. See [Cell contexts](../state/cell-contexts.md) for
the full per-option table.

## Async method — the server, with a ceiling

`Deno.*`, the filesystem, the network, `@std/*`, the full state including hidden
fields. This is where server work belongs.

Two things it is easy to be wrong about:

- **A call ceiling.** An awaited method that exceeds it rejects _while it keeps
  running_, and under `serialize` it is still holding the cell's mutex — so
  every later call burns its own ceiling waiting for it. The error says all of
  that at the moment it fires, and names `long:` and `timeout: "warn"` as the
  two ways out.
- **`transaction`** gives the method a snapshot across `await`s. That is what
  makes an async method's state reads coherent, and it is on by default.

## `*.server.ts` — the context in the filename

The one place aio makes the boundary visible, and the model for the rest: put
server-only code in a `*.server.ts` module and reach it with a **dynamic**
import. The bundler marks those external, so they never enter the browser
bundle.

```ts
// helpers.server.ts — Deno APIs are fine here
export const readNotes = (p: string) => Deno.readTextFile(p);

// cell file — a dynamic import, and dead code in the browser
async open(s, path: string) {
  const io = await import("./helpers.server.ts");
  s.text = await io.readNotes(path);
}
```

A **static** `import` of one is a refused build _and_ a refused dev boot, with
the import chain named `file:line` — it used to be a blank page in the artifact.
Naming beat documenting here, decisively: one app's fix for a blank-screening
bundle was renaming seven files, not changing a line of logic. Full rules in
[Imports and the browser bundle](../build/imports.md).

## Worker isolate — its own everything

`worker: true` runs the whole cell on its own Deno thread. It has `Deno.*` and
its own state, and it has **no shared module state** with the main isolate and
no access to peer cells — a read of another cell's state throws and names it.
`sync`, `scope: "client"`, `listensTo`, `machine` and `selectors` are refused
alongside it, because each of those is evaluated in the main reduce.

## Ask the framework

```sh
am where src/ui/Panel.tsx
```

It answers from the module graph the dev server already walks: which context the
file is in, the import chain from the UI entry that put it there, and the rules
that follow. `--json` for a script.

The verdict is derived, not guessed — a file the walk never reached is not in
the client graph, and that is a fact about the graph. The four answers:

| Verdict            | Means                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `browser-eager`    | statically imported from the UI — the browser links it at boot       |
| `browser-deferred` | reached only through a dynamic import; the browser may never load it |
| `server-only`      | not in the client graph                                              |
| `unreached`        | nothing the UI loads imports it — server context, or dead code       |

A `*.server.ts` filename overrides all four: it is server-only by name, and the
bundler marks it external.

## When you are lost

Ask, in this order:

0. **`am where <file>`** — it answers from the graph, with the chain.
1. **Does this file end in `.server.ts`?** Then it is server-only and it must be
   reached by a dynamic import.
2. **Is it a cell method?** `async` ⇒ server. Sync ⇒ server, _plus_ the browser
   if the cell is `sync`/`localFirst`/`scope: "client"`.
3. **Is it inside a component body?** Then it is the browser, and it is the only
   place a read subscribes.
4. **Is it anywhere else in a `.tsx` file?** Browser, untracked.

## Related

- [Cell contexts](../state/cell-contexts.md) — the per-option table: what
  `visible`, `persist`, `sync`, `worker` and `scope` each mean in each context,
  and every combination aio refuses
- [Reactivity tracking](../ui/reactivity-tracking.md) — what counts as a tracked
  read, and the four ways one stops being one
- [Imports and the browser bundle](../build/imports.md) — `*.server.ts`, dynamic
  imports, and what the graph validator refuses
- [Cell visibility](../state/cell-visibility.md) — `visible` / `ui`, and why a
  hidden read throws instead of returning `undefined`
- [Common pitfalls](pitfalls.md)
