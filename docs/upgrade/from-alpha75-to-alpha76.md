# Upgrading from alpha75 to alpha76

**This is the last release before beta, and the last one that breaks
compatibility.** Beta freezes the public surface all the way to 1.0, so anything
still marked "deprecated through beta" would have become permanent. Six
spellings that carried that label — with no removal date and no registry row —
go out here, together with the one config key whose CLI flag had already been
renamed without it.

Run `aiol --safe-fix` in the app: it rewrites every one of them that can be
rewritten mechanically, including the flags written into your `deno.json` tasks.
`am pin` refuses to move an unfixed app to alpha76 and names the file:line; the
escape hatch is `am pin v1.0.0-alpha75 && am fix`.

```sh
aiol --safe-fix && am pin --latest && am fix
```

## Breaking

| old                                      | now                                  | rewritten by              |
| ---------------------------------------- | ------------------------------------ | ------------------------- |
| `return schedule.after(…)` from a method | `s.$do(schedule.after(…))`           | `aiol --safe-fix`         |
| `return [schedule.…, own.…]`             | `s.$do(schedule.…, own.…)`           | `aiol --safe-fix`         |
| `{ deps: ["p"], fn: (s, p) => … }`       | `{ deps: ["p"], fn: (s, [p]) => … }` | `aiol --safe-fix`         |
| `aio.run({ killExisting: true })`        | `aio.run({ takeover: true })`        | `aiol --safe-fix`         |
| `--kill-existing`                        | `--takeover`                         | `aiol --safe-fix` (tasks) |
| bare `--server-url`                      | `--connect`                          | `aiol --safe-fix` (tasks) |
| `--zero-port`                            | delete it (it did nothing)           | `aiol --safe-fix` (tasks) |
| `--backup-logs`                          | delete it (it is the default)        | `aiol --safe-fix` (tasks) |

### `return` carries values; `s.$do(...)` carries effects

This is the one worth reading. A method that returned an effect had its effect
run **and resolved its caller with `undefined`** — the return channel could only
ever mean one of the two things, and it silently meant "effect". So
`const plan = await planner.plan()` handed you nothing while the code looked
right, and `return` could never be taught to carry an effect-shaped value later.

```ts
// before
tick(s) {
  s.n++;
  return schedule.after("tick", 1000, self("tick"));
}

// after
tick(s) {
  s.n++;
  s.$do(schedule.after("tick", 1000, self("tick")));
}
```

`s.$do(...)` takes any number of effects, works identically in sync and async
methods, and leaves `return` free for the value the caller is awaiting — a
method can now do both in one call.

Because this is read at CALL time rather than at boot, it follows the registry's
dev/prod split: a dev boot or a test **throws** with the migration, and
production logs the same line at error level (once per method) and still runs
the effect — an upgraded app says so on every run rather than silently dropping
a timer. The `CellEffect` type stays exported: it is the type of an effect
VALUE, which is what `s.$do` takes.

### Selector deps arrive as one tuple

```ts
// before                                  // after
{ deps: ["prices"], fn: (s, prices) => … }  { deps: ["prices"], fn: (s, [prices]) => … }
```

The tuple is what lets a deps selector also take its own arguments
(`fn: (s, [prices], id) => …` → `cell.byId(id)`), which the spread form made
impossible. Detected by shape at cell creation: dev throws, prod logs the
registry line once per selector and still spreads, because a selector silently
handed a tuple where it expected a slice renders the wrong number rather than
failing.

### One word for taking over a running instance

The flag has been `--takeover` since alpha52; the config key was still
`killExisting`. That mattered for exactly the case config keys exist for — a
compiled service binary, which cannot be passed a flag and so was forced to
write the deprecated spelling.

```ts
aio.run({ cells, singleton: true, takeover: true });
```

`aio.run({ killExisting })` refuses in dev, logs and honours the old key in prod
(a service that silently stopped taking over its own lock would fail to boot
rather than fail loudly), and `aiol --safe-fix` renames it.

### Two flags that did nothing

- `--zero-port` — `--help` printed **"No-op (accepted)"** for it. Zero TCP ports
  has been the default for a local Electron app since alpha66; the opt-OUT is a
  named port, `--port=N`. Delete the flag.
- `--backup-logs` — keeping previous logs (rotating to `.1`, `.2`, …) is the
  default. `--no-backup-logs` is the flag that changes anything. Delete it.

Both are now refused rather than accepted, because argv is read before anything
boots: there is no half-started app to protect, and an operator who typed the
old word needs the new one, not a warning that scrolls past the boot banner.

### Bare `--server-url` is `--connect`

`--server-url` with no value opened the Electron connect page — a flag that
reads like it needs a value and does something else without one. The valued form
`--server-url=<url>` is unchanged and still means what it says.

### Six more, all mechanical or already-correct code

These are the last-chance-to-break items: each is cheap now and permanent after
beta. None needs a rewrite of app logic.

| what changed                                                    | what to do                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `s.$signal!` / `s.$commit!` / `s.$live!`                        | nothing — drop the `!` when you like                                     |
| a method's throw reaches the caller as the method's own message | drop any code that strips a `Cell '…' method '…' threw:` prefix          |
| `updates.current` is `string \| null`                           | render `updates.current ?? "unknown"`; `updates.currentUnknown` says why |
| `aio_broadcast_*_total` lost its `kind` label                   | drop the label from dashboards and alerts                                |
| `testUI` enforces each cell's `access`                          | pass `{ user }`, or `{ enforceAccess: false }` to drive a gated method   |
| the wire's `payload._callId` is server-minted                   | nothing — third-party clients now get values and rejections without it   |

#### `s.$signal`, not `s.$signal!`

`MethodDraftMeta`'s members were `Partial<>`, on the stated grounds that "strict
contravariance forbids a required-extra param on `Method<S>`". That is not true
— `$do`, required and sitting right beside them, was the standing disproof — and
what it bought was `s.$signal!.aborted` in every cancellable method aio shipped
or documented, on its way to being the permanent idiom. Every previous spelling
still compiles (`!`, `?.`, a bare `(s: MyState)` annotation, and an explicit
`Partial<MethodDraftMeta>` one), which is what made this cheap now and
impossible later.

#### A method's error is the method's words

```ts
// the method
throw new Error(`not an email address: ${email}`);

// what the caller saw          (alpha75)
"Cell 'contacts' method 'create' threw: not an email address: nope";
// what the caller sees now      (alpha76)
"not an email address: nope";
```

An app shows `e.message` to a user — `examples/contacts` does exactly that — so
the framework naming itself ended up in the UI, while `docs/state/the-bridge.md`
promised the opposite. The cell and method are not lost: they are on the
`AioError` `context` the caller receives, and the log line has always named
both.

#### `updates.current` is a version or nothing

It was typed `string` and held the whole 200-character refusal paragraph when
the version could not be derived, so `examples/updates` printed that paragraph
where its UI says "Running <version>" — and it crossed the wire to every client.
A field that is sometimes a version and sometimes an essay cannot be rendered
safely, so it is two fields now.

#### `testUI` enforces `access`

A `customer` clicking an admin-only button used to delete the product under the
harness while the identical click over a real socket answered `ACCESS_DENIED`. A
harness more permissive than production manufactures green-test-broken-prod, and
authorization is the worst possible subject for it. If a test needs to drive a
gated method on purpose — seeding a fixture, or testing the method rather than
the button — say so: `testUI(App, { enforceAccess: false })`.

## Where the refusals come from

Every one of these is a row in `src/state/removals.ts`, the one record of what
aio removed in 1.x. That is what makes the runtime refusal, the `aiol` finding,
`am pin`'s preflight and this guide say the same words — including the second
exit, which is always available: pin the version the code was written for and
keep shipping (`am pin v1.0.0-alpha75 && am fix`).

## Retire

Workarounds this release lets you delete:

- **A local variable to carry a method's value out past a returned effect.** The
  two could not share the return channel, so code that needed both wrote the
  value into state and read it back. Fixed in alpha76: `s.$do(effect)` and
  `return value` in the same method.
- **A wrapper selector that re-wraps deps to take an argument.** Parameterized
  deps selectors work directly as of alpha52's tuple form, which is now the only
  form.
- **`--zero-port` in a task or a launcher script.** It has been a no-op since
  alpha66 and is refused as of alpha76 — delete it.
- **`--backup-logs` in a task or a service unit.** It has been the default since
  alpha62 and is refused as of alpha76 — delete it.
- **A `killExisting`/`--takeover` translation in a deploy script**, if you kept
  one because the key and the flag disagreed. They are one word as of alpha76.
