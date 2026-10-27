# Upgrading from 1.0.25-beta to 1.0.26-beta

Nothing is removed or renamed. `mod.ts` and the `deno.json` exports are
unchanged apart from additions. An app upgrades with no edit by hand; the lines
below say what a few apps (and more tests) may notice.

```sh
am pin v1.0.26-beta
am fix
```

## Can refuse what worked before

- **Zip extraction** refuses a link whose target is an absolute path, and any
  entry under a link inside the archive. These could write outside the target
  folder.
- **`am logs` / `am errors --since 5`** (a bare number) is refused; add a unit
  (`5m`, `2h`) or pass an ISO date.
- **PAKE pairing** answers `503` ("busy") when too many exchanges are open at
  once; pair again a moment later.

## Behaviour you may notice

- **Tests: happy-dom 21.** `am fix` moves the pin to `^21` (a security advisory,
  GHSA-834v-8h66-3h79). happy-dom 21 no longer loads external CSS files or
  iframe pages by default (`enableCSSFileLoading`, `enableIframePageLoading`); a
  test that read a linked stylesheet's rules or an iframe's document turns them
  on in its `Window` settings.
- **`css`**: a nested selector without `&` (`.icon { … }` inside a `css` block)
  is now scoped to the class — `.c .icon` — as CSS Nesting reads it; it used to
  be emitted as a GLOBAL rule. `& :x` (a descendant) and `&:x` are now two
  classes. `@keyframes` and `@font-face` bodies are emitted as written (scoped,
  they never matched).
- **`useForm`**: `bind()` on a checkbox stores `checked` (a boolean); a radio
  warns and the docs show the manual pattern.
- **Dev reload** waits up to 5 s for in-flight method calls before it restarts;
  a method that never ends adds those 5 s to each save. Production is unchanged.
- **`perfBudget`** merges over the dev default instead of replacing it: a key
  the app leaves out keeps its dev value.
- **A hand-written WebSocket client** that reads `tt-state` frames sends `type`
  (as the page does) or `tt-cmd { cmd: "sub" }` first; aio's own page, panel and
  `useTimeTravel` do this already. `peer()` sockets never get them.
- **`ship github`** writes the new workflow (one Linux runner, `am publish`,
  release assets); rerun it to replace an older generated file, or keep yours.
- **`am publish`** refuses a dirty tree before building (it refused after) and
  names the files.

## Retire

Each of these was a workaround for something 1.0.26 does itself:

- Mirroring a GitHub release into a local folder and pointing `updates.source`
  at it as `file://` — `source: "github:OWNER/REPO"` (1.0.26).
- `git checkout -- deno.lock` after `am fix` in CI — `am fix` restores a
  committed lock that an early deno command pruned (1.0.26).
- Starting an AppImage again by hand after it updated itself — the relaunched
  app stays up (1.0.26).
- A hand-written GitHub Actions workflow for an aio app — `ship github`
  (`--no-pages` for release assets only) (1.0.26).
- Setting `perfBudget` keys an app does not care about only to keep the dev
  defaults — the app's budget merges over them (1.0.26).
