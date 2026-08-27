# Upgrading from alpha68 to alpha69

Nothing in your app code changes. This is the release where **updating** stopped
being a feature that had been tested in pieces and became one proven end to end:
a real compiled binary now replaces itself and serves the new build in CI, on
every run (`tests/updates-artifact-e2e.test.ts`).

## What to do

- **Publish with one command.** `deno task publish` is scaffolded into new apps
  and restored into existing ones by `am fix`. It does build → sign → **lay out
  the channel directory a client actually fetches**, which is the step that used
  to live only in prose. `deno task ship` stays for the once-ever corners
  (`ship keygen`, `ship github`).
- **Do not redirect `ship keygen`.** `deno task ship keygen > key.json` captures
  the printed _summary_ — valid JSON, a `publicKey`, and no private half — so
  `--key` on it later fails with a WebCrypto error that names nothing. Run
  `deno task ship keygen` with no redirect (it writes
  `~/.aio/keys/<app>-release-key.json` and prints that path), or
  `ship keygen --stdout` to pipe the real pair into a CI secret. The docs taught
  the redirect; they no longer do, and the loader now says exactly this when it
  meets such a file.
- **`build.v8Flags` and `build.channel` are recognised keys.** Both were read by
  the framework and missing from the config allowlist, so `lint:aio` — a release
  gate — reported a correctly configured app as wrong. If you removed either to
  get a green lint, put it back.
- **If you use `updates:`, give every persisted cell a `version`.** The data
  gate only protects cells that declare one — an unversioned cell is invisible
  to it, and a release that changes its shape is offered as compatible. The
  first `version: 1` is free: it stamps the shape already on disk, runs no hook,
  and logs `stamping <cell> at version 1`. `deno task lint` now lists the cells
  that need it.
- **Publishing more than one platform now works.** `am publish` stamps the host
  artifact's data contract into every platform's manifest, and files each
  manifest under the platform it is actually for — previously they all claimed
  the building machine's platform and overwrote each other, and cross-compiled
  ones carried no contract at all, which blocked every install that had data.
- **`updates.backupPath` is on the cell.** If you show the user where their data
  went before a migration, read it there instead of grepping the log.
- **Work belongs in `canApply`.** It is awaited, runs before a byte is
  downloaded, and fails closed carrying its own message — and it is the only
  seam that covers the button, `auto: true` AND the terminal prompt. A backup
  taken behind the button is a promise the other two break in silence.
- **`CheckResult` / `CheckOptions` now come from `aio/updates`.** If you
  imported them from `aio/testing` in production code, move the import; the
  testing entry keeps exporting them for stub runtimes.
- **`server` and `server-app` can be published.** They emit a systemd unit
  beside the binary, and `am publish` read the two files as two rival releases —
  refusing with a message whose suggested fix was already in effect. Companion
  files are now recognised as companions and reported, not published.

## Five security defaults that are stricter

These are the ones that can break a deployment rather than a line of app code.
Each closes a hole that was proven reachable, and each refusal names the config
key that widens it again.

- **A reverse-proxied app must list its domain.** A request whose `Host` header
  is a foreign domain is refused with a 403 naming the fix. Allowed without
  configuration: no `Host` at all, any IP literal, `localhost` / `*.localhost`,
  the address the app is bound to, and this machine's own hostname. If you serve
  through nginx/Caddy at `app.example.com`, add it to `allowedOrigins` — the
  same key, and the same spellings, the WebSocket origin check already uses.
  This closes a DNS-rebinding hole that let `evil.com` read raw state out of a
  local dev app.
- **A non-loopback `host` counts as exposure.** `host: "0.0.0.0"` (or any name
  that is not loopback) now takes the `--expose` path: a key is generated,
  auto-TLS applies, origin checking is strict. Exposure had two deciders and one
  of them was silent — an app reachable from the network with no credential at
  all is precisely the state `--expose` exists to make loud. An unparsable name
  fails closed. `--host=127.0.0.1` and the default change nothing. Behind a
  proxy that terminates TLS, `tls: false` (or `--no-tls`) is the documented way
  out, and the boot line says so at the moment it applies. Every warning names
  the key you actually wrote — `host: "0.0.0.0"`, not a `--expose` you never
  typed.
- **`/__aio/health`, `/metrics`, `/vitals` and `/error` are not anonymous on an
  app with accounts.** They describe the app rather than serve it. A public app
  is unchanged — that is what `curl /__aio/health` is for. **If you point a
  liveness or readiness probe at `/__aio/health`, move it to `GET /`**, which
  answers 200 anonymously and needs no credential; the 401 says so too. Do not
  give your monitoring an account for this.
- **`access` cannot be escalated through `listensTo`.** A gated cell that
  listens to a less-gated cell's actions is refused at compose time, naming both
  cells.
- **`androidVersion()` refuses a project with no `"version"`** instead of
  inventing one, so two different builds cannot both call themselves the same
  version code.

## Three behaviours that change

None of these break an app that was written against what the docs say. Each was
code disagreeing with its own contract.

- **`resource().value` is cleared when a fetch fails.** Its doc always said
  "undefined while loading or after error"; the error branch never touched
  `data`, so an app rendering `{r.value ? <Rows/> : <Spinner/>}` showed stale
  rows beside a live error. `latest` is the one that deliberately keeps the last
  good value through a refetch — if you were relying on `value` for that, read
  `latest`.
- **`<Link>` no longer intercepts clicks the browser owns.** A modified or
  non-primary click, an anchor with `target` (other than `_self`) or `download`,
  another origin, or a non-http scheme now behaves as a plain anchor.
  `<Link target="_blank">` used to be navigated in place, and a cross-origin
  `<Link>` did nothing at all (`history.pushState` threw a SecurityError out of
  the click handler, with a framework "event handler error" as the only trace).
- **`<Markdown>` link and image targets are normalized before they are checked —
  a security fix.** The scheme guard used `trim()`; the URL parser a browser
  runs on an `href` also strips leading C0 control characters, so
  `[click](\u0000javascript:alert(1))` passed the check and resolved to
  `javascript:` in the browser. The check and the emitted value are now the same
  normalized string. If you rendered untrusted markdown, this is the reason to
  upgrade.

## Retire

| workaround you may have                                                              | fixed in    | what to do now                                                                      |
| ------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| A hand-written "copy these two files into `<base>/<channel>/`" release script        | **alpha69** | `deno task publish` — the layout is the command now                                 |
| A key file you rebuilt by hand after `keygen > key.json` produced a useless one      | **alpha69** | `deno task ship keygen` with no redirect; the loader names this case if you hit it  |
| `build.v8Flags` / `build.channel` deleted from `deno.json` to satisfy `lint:aio`     | **alpha69** | put them back — they were always read                                               |
| `am publish --target=…` guessing on a `server` app that refused either way           | **alpha69** | plain `am publish`; the `.service` unit no longer competes with the binary          |
| Cross-compiling Electron by hand because `--platforms=windows` always failed         | **alpha69** | `deno task build --targets=electron --platforms=windows`                            |
| `--allow-server-only` passed to `src/build.ts` directly because the fleet refused it | **alpha69** | `deno task build --targets=android --allow-server-only`                             |
| Your own sanitizer in front of `<Markdown>` for control-character URLs               | **alpha69** | the check normalizes the way the URL parser does, and emits what it checked         |
| An `onKeyDown` bolted onto `<Table onRowClick>` rows so keyboard users could act     | **alpha69** | rows are focusable and Enter/Space activate them                                    |
| A suppressed hydration "divergence" warning you knew was wrong                       | **alpha69** | it no longer fires on inline `style`, `readOnly`, or `style={cond ? {…} : null}`    |
| A wrapper around `<Link>` to make `target="_blank"` or a cross-origin href work      | **alpha69** | `<Link>` leaves clicks the browser owns to the browser                              |
| `// aiol-ok` over UI test files, or `lint:aio` switched off entirely                 | **alpha69** | test paths are excluded from the browser-bundle rule; turn the gate back on         |
| Filtering shutdown ERROR lines out of your log pipeline to find real ones            | **alpha69** | a clean exit prints none — a closed dispatch loop is classified before it is logged |
| Reading the pre-migration backup path out of the log to show it in a UI              | **alpha69** | `updates.backupPath`                                                                |
