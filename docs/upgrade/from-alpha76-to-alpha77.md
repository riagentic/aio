# Upgrading from alpha76 to alpha77

**Nothing breaks.** The public surface was frozen on 2026-09-04
(`docs/basics/semver-policy.md`): every export, signature, flag, config key and
wire frame of alpha76 is byte-identical here, and `check:api` refuses the first
release where that stops being true. There is no step to perform.

```sh
am pin --latest
```

## What got better

Everything below is a defect that was silent on alpha76 and is fixed here with a
test that is red on alpha76. The full account is `CHANGELOG.md`.

- **The visual app manager (`amui`) is served its app again.** The dev server's
  import scanner read `await import('/app.js')` inside the framework's own HTML
  template as a real import and served the diagnostic page instead. The scanner
  reads code only (strings, templates and comments never contribute an edge), a
  missing mapping in a chunk the browser never eagerly loads no longer blocks,
  and `/__aio/trojan/graph` reports the verdict so nobody has to guess from
  HTML.
- **Buffered patches are no longer applied twice after a snapshot** (both
  transports, connect/`subs`/`resync`), a starved client reaches
  `/__aio/health`, a failed force round records its debt, and the first document
  of a connection receives one initial state, not two.
- **A write drained at shutdown reaches SQLite.** The persistence hint is folded
  before the shutdown gate; under load the dirty hint survives a re-arm so
  windows stay O(change).
- **A resend past the tombstone sweep is refused, not applied twice** —
  `stale-beyond-retention`, dropped on the client via `onDrop`/`onRejected`.
  Raise `offline.retention` if clients may stay offline longer than 24 h.
- **A packaged Electron window keeps `cfg`/`proto` across a reload**; the
  `--no-sandbox` fallback applies where userns is actually restricted and
  nowhere else; a slow first load is no longer reported as a stall.
- **Renderer:** a controlled number input keeps a half-typed decimal; every
  documented `use` shape works and cleans up; `onChange` keeps firing when
  `onInput` appears beside it; `<form nativeSubmit>` opts out of interception; a
  stale socket's `onclose` no longer kills its successor; a protocol mismatch is
  terminal; the missing-keys warning counts only array children and names the
  parent it fired in.
- **Build and `am`:** the generated systemd unit parses (no trailing comments);
  the `cli` target carries its build stamp and `v8Flags` and is smoke-run;
  `aio doctor`, `am pin` and `am start` read `deno.jsonc` and run from the
  directory the launch record claims.
- **The audit rounds committed after alpha76** — silent data loss on refused
  persistence windows, `am persist` reporting success while nothing reached
  disk, `auth: true` serving the app directory to anonymous callers, a lost
  broadcast round with nobody owed a full state, one in-app route change
  freezing an Electron window's downlink — are all in this release; see the
  CHANGELOG's last section.

## Retire

Workarounds an app may still carry for bugs fixed here — each safe to delete
now, with the version that fixed it.

| workaround                                                                                  | fixed in |
| ------------------------------------------------------------------------------------------- | -------- |
| an `import` moved out of a template literal or comment to keep the dev validator quiet      | alpha77  |
| `key` props on hand-written sibling `<div>`s added only to silence the missing-keys warning | alpha77  |
| a `type` prop written before `onChange` on a file input so the picker fires                 | alpha77  |
| `Number()` round-trips or `onBlur` commits to keep a decimal typeable in a number input     | alpha77  |
| `data-native-submit` where `nativeSubmit` was written and did nothing                       | alpha77  |
| a manual `use` cleanup (calling the returned function yourself on unmount)                  | alpha77  |
| a client-side dedupe of incoming patches after reconnect                                    | alpha77  |
| a forced `resync` after every `subs` change                                                 | alpha77  |
| a home-page reload in Electron to recover a frozen window after a route change              | alpha77  |
| a `deno.json` kept beside a `deno.jsonc` so `doctor`/`am pin` would read it                 | alpha77  |
| hand-editing the generated systemd unit to strip the trailing `# …` comments                | alpha77  |
