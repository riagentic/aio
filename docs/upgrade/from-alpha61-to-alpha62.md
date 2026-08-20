# Upgrading from alpha61 to alpha62

Nothing breaks in your app's code. Two things can make an existing app **look**
different or a build **refuse** where it used to succeed, and both are cases
where the old behaviour was shipping something wrong — so they are worth 60
seconds each.

## Your stylesheet now owns the whole visual stage

alpha61 shipped a default theme and said your CSS always wins. That was true of
**conflicts** and misleading about everything else: a cascade layer settles a
disagreement, and where your CSS said nothing there was no disagreement to
settle. So `:where(main){max-width:72rem; margin-inline:auto}` applied to an app
whose `<main>` declared `padding` and no `max-width`, and its content rendered
as a centred column with an empty band beside it.

**Now**: with no `style.css`, the full default look ships exactly as before. The
moment your app has one, every visual default steps aside and only the inert
`--aio-*` custom properties remain (variables paint nothing unless something
references them).

If you liked alpha61's behaviour — the default look applied alongside your own
CSS — ask for it explicitly:

```ts
await aio.run({ cells: [app], ui: { theme: "full" } });
```

Boot says so, once, when that combination is in effect. And if you want to build
**on** the default look without depending on the framework for it:

```sh
am theme adopt      # → src/aio-theme.css, imported from your style.css
```

From then on the rules are a file in your repo that no aio version can change.

## A standalone Android build can now be refused

An APK is a Kotlin WebView plus your bundle — there is no Deno runtime in it. A
dynamic `await import("./x.server.ts")` (the documented way to reach server-only
code from a cell method) is correct on every other target and impossible there,
so that build used to succeed and ship an app whose UI rendered and whose
buttons did nothing.

`deno task build --targets=android` now refuses when your app reaches
server-only code, naming each module and its importer. Three ways forward:

- **`--android --remote`** — the APK is a _client_ of a server running
  elsewhere, which is where that code belongs and runs. Usually the right
  answer.
- **A separate entry** (`--entry=src/client/app.ts`) whose graph is pure client.
- **`--allow-server-only`** — you assert those paths are guarded and never taken
  on Android.

Unchanged: every other target, and `--android --remote`.

## Two new boot lines you should not ignore

- **`version: this app pins aio X but is RUNNING Y`.** If `dep/aio` is a symlink
  to a checkout, your app's "installed version" is whatever that tree is this
  minute. One app declared alpha55 and ran alpha61 plus uncommitted work. Fix
  with `am pin <declared>` (get what you declared) or `am pin --latest` (record
  what you are running). A `path:` pin is exempt — that one says "whatever that
  tree is" on purpose.
- **`config: ignoring <file>`** — your `deno.json` exists and does not parse.
  Comments are fine now (see below); this means a real syntax error.

## `deno.json` may have comments, and `deno.jsonc` works

Deno reads both; aio hand-parsed the file with `JSON.parse` in thirteen places,
so a single `//` comment killed builds with an unattributed `SyntaxError`. Now
one reader handles both filenames and JSONC. Nothing to change — this only ever
un-breaks things.

## If your tests assert on rendered markup

A component that renders `null` now leaves a comment placeholder (`<!---->`)
holding its position, the same slot a `null` child has used since alpha30-ish.
That is what lets a component that becomes visible appear **where it was
written** instead of appended last.

```ts
root.innerHTML; // "<!---->" — was ""
root.children.length; // 0 — comment nodes are not elements
root.querySelector("aside"); // null
```

Assert on **elements** (`children`, `querySelector`) rather than exact
`innerHTML` and absence reads the same either way. Five of aio's own tests said
`innerHTML === "<div></div>"` where they meant "no element"; they now say the
latter.

## New, nothing to do

- `am theme adopt` — take aio's stylesheet into your app as a file you own.
- `testComponent` is importable from `aio/testing`, beside `testCell`/`testUI`.
- `tls: "auto" | false | { cert, key }` as a config key, so a compiled binary in
  a service unit can declare its transport without shell flags.
- `build.ts --out=` — where artifacts land, so orchestrated builds stop fighting
  over `dist/`.
- Labelled build targets with `kind`, and the `server-app` target (an exposed
  server that also serves its page).
- `ui.entry` reaches the build (`build.ui` / `--ui=`), and a bundle that
  disagrees with the running config is refused rather than served.
