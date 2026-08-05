# Upgrade: alpha46 → alpha47

A second bug-hunt release: 17 more defects, found by pointing randomized
differential fuzzers at the **renderer** and the **build**, two areas the
previous pass did not reach.

**No code changes required.** Nothing was removed, no option renamed. Every
change below either fixes something that was already broken or makes a silent
failure loud.

## The one that could have cost you work

`deno task build` with `out:` pointing at a directory that **contains** your app
deleted your sources and reported success:

```jsonc
{
  "entry": "apps/web/main.ts",
  "build": { "targets": { "cli": {} }, "out": "apps" }
}
```

`✓ 1/1 build(s) → apps/`, exit 0, and `apps/web/` was gone. The guard compared
against a fixed list of forbidden directories instead of testing containment, so
only an exact match was refused. It now refuses in **both directions** — a dir
that is, contains, or sits inside your app dir, `src`, `.git` or `.aio` —
compared by path segment, so `apps` and `appsX` are not confused.

If you keep a build output directory anywhere near your sources, this is the
release to take.

## Your UI may render differently — correctly

Four renderer defects committed the **wrong DOM silently**:

- **An unkeyed sibling reorder did nothing at all.** Any list mixing text and
  elements where two text children share a value — `{" "}` separators, repeated
  labels, equal numbers — could re-order in the model and stay byte-identical on
  screen. The diff located old text nodes by scanning for matching content
  instead of using their position.
- **Removing bare text was a no-op.** `<>{"loading"}</>` replaced by an element
  left `loading` in the DOM, accumulating on every toggle.
- **An empty Fragment had no anchor in SSR output**, so after `hydrate()`
  content inserted into it landed in the wrong place (rows above their header).
  `mount()` was always correct — this was hydration-only.
- **A component returning a bare string could write into a sibling's text
  node.**

If your UI relied on any of these looking right by accident, it will now follow
the model. Keyed lists were unaffected — 3 000 randomized keyed programs found
zero defects before the fix.

## Your build may rebuild where it used to say "cached"

The freshness cache decided what a bundle depended on by walking the project for
`.ts`/`.tsx`/`.css` files **from the current directory**. So an edit to an
imported `.js` or `.json`, or to a shared package in a sibling directory
(`apps/web` importing `../../packages/shared`), printed
`✓ dist/app.js cached — use --force to rebuild` and shipped the **old code** —
which `--compile` then embedded into the binary.

It now records the input list esbuild actually read (`.aio/bundle-inputs.json`)
and checks those. Expect a rebuild the first time; after that it is both correct
and no slower. **No record means not fresh** — a guess about dependencies is
what shipped stale code.

## A binary now knows its own identity

A compiled binary read its **title** and **client/target default** from the
`deno.json` in the directory it was _launched from_. Under systemd (which runs
from `$HOME`) or in any other project's folder, it served someone else's title
and could auto-download Electron despite `"target": "browser"`. All three
identity fields now resolve from the app's own `deno.json`, found relative to
the entry — the same rule `appVersion` already used.

## Other silent failures made loud

- Packaging a target no longer embeds whatever `dist/` happens to hold. Building
  `compile:android` then `compile:service` used to ship an Android bundle inside
  a server binary — a blank page. The shape stamp is now checked where the
  artifact is **packaged**, not only where it is rebuilt.
- `cli-client` compiles the entry you declared instead of always `src/client.ts`
  (it previously printed your entry and built a different one).
- `aio ship` derives its scan directory from your entry, and **refuses to sign**
  a capability manifest it could not measure — it used to emit "no permissions"
  for any non-`src/` layout.
- A `compile.include` path outside the project is refused instead of silently
  dropped (the asset was missing only in the user's hands).
- `dev:android` writes `<app>-dev.apk`, so a cleartext localhost-pointing dev
  build can no longer be mistaken for the shippable one.
- An untitled project in a directory named `My App` produces `my-app`
  consistently — `deno task compile` used to emit a binary literally named
  `My App`.
- The Electron build announces it when `deno install` rewrites your `deno.json`,
  instead of leaving an unexplained diff.

## Dev-only additions

The renderer's child-alignment tripwire now checks each child's **position**,
not just the count — every bug above except one was an order defect at a correct
count, which is why they shipped. Hydration mismatches caused by adjacent text
children are also reported in dev now; the underlying SSR change is deliberately
deferred to its own release.
