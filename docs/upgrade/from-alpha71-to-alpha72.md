# Upgrading from alpha71 to alpha72

**Nothing in your app code breaks.** This release is additive: one new config
key (`security`), one new UI key (`ui.dir`), one new config array (`plugins`),
one new merge strategy (`"text"`), ten new components on `aio/ui`, and a
response finisher that changes how bytes travel without changing what they say.

```sh
am pin --latest && am fix   # or: deno task upgrade
```

## What changes without you doing anything

### Your app is served compressed, and revalidates

Measured on an alpha71 compiled counter binary: `GET /app.js` shipped **161,905
bytes** with `Cache-Control: no-cache` and no validator — so "revalidate"
degraded to a full re-download on every page load, and nothing was ever
compressed.

The same binary on alpha72:

```
GET /app.js  Accept-Encoding: br, gzip
  → 56,131 bytes, content-encoding: br, etag: "3gxd-…"

GET /app.js  If-None-Match: "3gxd-…"
  → 304 Not Modified, 0 bytes
```

**Your app's bytes are unchanged.** Only the transfer encoding is new, which is
what a transfer encoding is for. A client that sends no `Accept-Encoding` gets
exactly what alpha71 sent, byte for byte. The finisher never touches: a non-200,
a stream (`text/event-stream`, `application/x-ndjson`, `multipart/*`), an
already-encoded body, an incompressible content type, a response carrying
`Cache-Control: no-transform`, or a response that already has its own `ETag`.

Turn it off with `security: { compress: false }` if you terminate compression at
a proxy.

### Your app sends security headers

```
X-Content-Type-Options: nosniff                 (as before)
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: base-uri 'self'; object-src 'none';
                         frame-ancestors 'self'; form-action 'self'
```

Each default is chosen so it **cannot break an app that works today**:

- The CSP has **no `default-src`** — every off-origin stylesheet, font, image
  and script still loads exactly as before. It closes `<base>` hijacking, plugin
  objects, cross-origin framing and form exfiltration, none of which any aio app
  does.
- The frame policy is **derived from `allowedOrigins`**. An aio page in a
  cross-origin iframe already could not work: the WS upgrade carries the
  embedder's `Origin` and is refused unless allow-listed. So the one
  configuration where framing works is the one that declared it, and that is the
  input the policy reads. With `allowedOrigins` set, `frame-ancestors` carries
  the list and `X-Frame-Options` (which cannot express one) is omitted.
- `Strict-Transport-Security` is sent **only** behind an operator-supplied
  certificate (`--tls-cert`), never behind aio's own local CA.
- No `Permissions-Policy` is guessed: restricting camera or geolocation by
  default breaks the app that uses them.

`security: { headers: false }` restores exactly the alpha71 behaviour. Every
piece is individually switchable — see
[Response security headers](../auth/auth.md#response-security-headers).

### An app that will not stop is stopped anyway

Every shutdown phase was already bounded; the **exit** was not. One resource
nobody unref'd kept the event loop alive after Phase 7 and the `Deno.exit`
behind it never ran — measured in a full-suite run, an `--expose` app ignored
SIGTERM for 15 s (nearly 2× its own declared 8 s budget) and had to be
SIGKILLed, and a SIGKILLed app is one that did not finish writing.

`stopProcess()` now arms a watchdog and ends the process after
`DRAIN + TEARDOWN + 2s`, saying which runtimes were still stopping and exiting
**75, not 0** — a forced exit must not tell a supervisor the app stopped
cleanly. `am stop` and the lock takeover wait it out, so nothing SIGKILLs an app
one tick before it would have said why it was stuck.

### The state before your first dispatch is frozen

Committed state is frozen — immer's `autoFreeze` is never disabled, so a write
throws in dev and prod. The state at t=0 was the one exception:

```ts
// alpha71
app.state.count = 99; // before any dispatch: SUCCEEDED, and getState() said 99
app.state.count = 99; // after one dispatch: TypeError
```

Now both throw. **If your `onInit`, a boot-time effect, or a component that
renders before the first action was writing to state directly, it will now throw
where it used to silently work.** That write never reached persistence, never
broadcast and never survived a dispatch — so the throw is the first time you
find out about a bug you already had. Change it to a cell method.

### Your app stops when asked, even mid-boot

The SIGINT/SIGTERM handlers were installed near the END of boot. A signal
arriving before that point was **lost** — not early, lost: the listener replaces
the default disposition, and a signal landing during that setup reaches neither.
The app then ran forever, having been asked to stop.

**If you have ever seen an app ignore `am stop` or a `docker stop` right after
starting, this was it.** The handlers are now installed at the top of
`aio.run()`.

### Your app exits when it is done

Three background timers — the logger heartbeat, the vitals sampler, the
crash-checkpoint debounce — were started at boot and torn down only on the
shutdown path, and a pending timer holds the event loop:

```
libraryMode app:   app.close() returned in 53 ms, process unloaded at 5,054 ms
refused boot:      "persistence unavailable: file is not a database" … and then
                   it never exited at all
```

Now 49 ms and 103 ms. **If you added a `Deno.exit()` after `app.close()`, or a
timeout in a supervisor script, because an embedded aio app "took a while to go"
— that was this, and you can drop it.** Nothing about when your code runs
changes: the three timers still fire for exactly as long as the app is alive.

### An `include:` filter keeps your list's shape

`visible: { include: ["rows.title"] }` dropped `rows` from the client's view
entirely whenever no element had the path — which includes the empty list every
app starts with:

```ts
// alpha71, cell state { rows: [] }
state.rows.map(…)   // TypeError: state.rows is undefined
```

Now an array always projects to an array of the same length (`[]` stays `[]`,
and a row with none of the included fields is `{}`, which is what a MIXED array
already produced). The length is also what index-addressed deltas resolve
against, so the first `add rows[0]` after an empty start no longer forces the
client into a full resync to catch up. **If you wrote `state.rows ?? []` in a
component because an included list was sometimes undefined, that was this.**

### `logging: false` keeps the black box

It used to send the action log and the crash checkpoint to `.aio/log` relative
to the **current directory** — one `ERROR` per dispatch, and the two artifacts
whose whole job is to explain a crash silently not written. If you turned
diagnostics off to stop that noise, turn them back on.

### Your theme answers three more environments

Media queries only, so an app on a default machine renders byte-identically:

- `pointer: coarse` — 44px minimum on controls (aio builds APKs)
- `prefers-contrast: more` — borders to ink, muted text un-muted, elevation off
- `forced-colors: active` — borders and a `Highlight` focus ring restored

### New dev-mode a11y warnings

Five more, all observe-only and warn-once: a `<button>` with no `type`, an
`<a onClick>` with no `href`, a positive `tabIndex`, `aria-hidden` on something
still focusable, and `aria-disabled` with a live `onClick`. They print in dev
and change nothing at runtime. If a warning names your markup, it is naming a
real defect for someone using a keyboard.

## What you can now do

### `plugins: [...]`

A reusable piece of app — its cells, routes, schedules and observe-only hooks —
as one value:

```ts
import { definePlugin } from "aio";

const audit = definePlugin({
  name: "audit",
  cells: [auditLog],
  routes: { "/audit.json": () => Response.json(auditLog.entries) },
  onAction: (a) => auditLog.record(a.type),
});

await aio.run({ cells: [myCell], plugins: [audit] });
```

The app always wins over a plugin; a collision between two plugins throws at
boot naming both. See [Plugins](../basics/plugins.md).

### `merge: { body: "text" }`

A three-way merge for prose. Two peers editing different paragraphs both keep
their edit; the same paragraph is a real conflict, resolved by HLC and reported
through `onConflict`. See [CRDT sync](../persistence/crdt.md#text).

### `ui: { dir: "rtl" }`

Every stylesheet aio ships is written in logical properties, so one attribute
mirrors the whole default UI. `dir` is deliberately not derived from `lang`.

### Ten more components on `aio/ui`

`Switch`, `RadioGroup`, `Tabs`, `Menu`, `Progress`, `Alert`, `Tooltip`,
`Breadcrumb`, `Skeleton`, `EmptyState` — each implementing the WAI-ARIA keyboard
interaction for its role. See [the kit](../ui/kit.md#controls).

### `deno task bench:bundle`

```
bundle                   raw    gzip  brotli
AIR alone                152 KB    55 KB    48 KB
counter app              158 KB    57 KB    50 KB
```

Five docs quoted "~20 KB gzipped" and nothing had ever measured it. Now one
measurement, a ceiling that only goes down, and a gate that fails if a doc stops
matching what it measured.

## Retire

| workaround you may have                                                                                    | fixed in    | what to do now                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| A reverse proxy in front of a localhost app, purely for gzip                                               | **alpha72** | drop it — every compressible response is negotiated (`br`/`gzip`/`deflate`)                                             |
| A proxy or CDN rule adding `ETag`/`Cache-Control` to `/app.js`                                             | **alpha72** | drop it — the server sends a content-hash ETag and answers 304                                                          |
| Hand-written `X-Frame-Options` / `Referrer-Policy` / CSP in a `routes` handler or a proxy                  | **alpha72** | drop it — `security: {}` sends them, and a header your route sets still wins                                            |
| A `SIGKILL` after N seconds in a systemd unit or supervisor script, because the app sometimes did not exit | **alpha72** | keep the unit's own `TimeoutStopSec` as a backstop, but the app now ends itself after its budget and says why (exit 75) |
| A hand-rolled `<Switch>`, `<Tabs>`, `<Menu>` or `<Alert>` copied between apps                              | **alpha72** | `aio/ui` ships them, keyboard-complete                                                                                  |
| A `lww` string field plus app-level "last edit wins, sorry" UX for a note                                  | **alpha72** | `merge: { body: "text" }`, and handle `onConflict` for the paragraph that really did collide                            |
| Six edits across one config to add a shared piece of app (its cells, its route, its hook)                  | **alpha72** | one entry in `plugins: [...]`                                                                                           |
| A retry loop around `am stop` / `docker stop`, because an app sometimes ignored the first one              | **alpha72** | drop it — a signal during boot is no longer lost                                                                        |
| A `Deno.exit()` or a supervisor timeout after `app.close()`, because an embedded app "took a while to go"  | **alpha72** | drop it — close returns and the process leaves (5,054 ms → 49 ms)                                                       |
| `diagnostics: false` set only to silence `write failed: .aio/log/actions.jsonl`                            | **alpha72** | turn it back on — the path was the bug, not the feature                                                                 |
| A hand-maintained note of what the client bundle weighs                                                    | **alpha72** | `deno task bench:bundle`                                                                                                |
| `margin-left`/`text-align: left` overrides to un-break the kit in an RTL app                               | **alpha72** | delete them — the kit is written in logical properties; set `ui: { dir: "rtl" }`                                        |
| `state.rows ?? []` in a component, because a `visible: { include }` list read `undefined` while empty      | **alpha72** | drop the fallback — an included array projects to an array of the same length, empty included                           |

## Corrections to the documentation

Two things the docs said that the code never did:

- `docs/ui/air-comparison.md` said `useEffect` and `useMemo` **ignore** their
  dependency arrays. They have always honoured them. The compat table now says
  what `src/air/compat.ts` does, and lists what the layer does **not** cover
  (classes, Suspense, portals, `useReducer`, `useLayoutEffect`).
- The README said `am` "inspects and drives any running app". The control API is
  dev-only by design; against production `am` reports status, health, logs,
  data, installs and pins. The tool always said so; the README did not.
