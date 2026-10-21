# Upgrading from 1.0.22-beta to 1.0.23-beta

Nothing is removed or renamed, and no option changes meaning. There is nothing
to change by hand: an app that builds and tests on 1.0.22-beta builds and tests
on 1.0.23-beta.

```sh
am pin v1.0.23-beta
am fix
```

## What you may notice

- **The desktop splash no longer holds the window back.** In 1.0.22 the main
  window stayed hidden until the splash left (`minMs` after it appeared). Now
  the window shows the moment the app is ready, under the splash; the splash
  stays in front until `minMs`, then fades. A splash is not shown at all when
  the app is ready before it would appear.
- **The splash opens where the window will open** — centred on the window's
  saved bounds, else on the primary display — not on the screen under the
  pointer.
- **The download window and the Retry / Quit question open on the window's
  screen too**, drawn by aio (GTK on Linux, Windows Forms, Cocoa), not by
  `zenity` under the pointer.
- **The window shows once its page has painted** (at most 5 s after it is made),
  on the page's background — `electron.backgroundColor`, else the theme's — so a
  dark app no longer opens on a white rectangle.
- **Linux draws the splash with GTK 3**, so it looks as on Windows and macOS
  (`@2x` halved, your colours and bar); `yad` is no longer needed.
- **Runs from source show the splash too** (`deno task dev`, `--prod`,
  `am start`), but not after dev's restart on a save.
- **`--instance=.` and `--instance=..` are refused** — they named a folder
  outside `~/.aio-instances`.
- **`onGlobalKey("ctrl+s", fn)` now fires.** A chord string type-checked and
  never fired before; if one sat in your code doing nothing, it starts working.

## Worth a look

- **The splash look:** every part is yours — `size`, `fit`, `position`,
  `background`, `textPosition`, `align`, `margin`, `shadow`, `radius`, `border`,
  `windowShadow`, `maxMs`, `fadeMs`, `show`, `cancel`, `bar.height` /
  `bar.position` / `bar.radius`; `{version}` and `downloadText` in the text. See
  [Splash](../build/targets.md#splash-buildsplash).
- **A splash that set only `image` looks different after a rebuild:** the
  defaults are new — `{title}` centred over the image's lower part (white or
  near-black, whichever reads), 8 px corners, a 200 ms fade, a bar and a ✕ while
  Electron downloads. Set `text: false`, `radius: 0`, `progress: false` (…) for
  the 1.0.22 look; a key you set is kept exactly.
- **A "Save as…" dialog:** `pickSave({ title, defaultPath, filters })` from
  `aio/server`.
- **Your app needs Ctrl+R or Ctrl+P:** set `electron.shortcuts.reload` /
  `.print` to `false`; print with `print()` from `aio/air`.
- **Your page vetoes closing (`beforeunload`):** the veto is logged once;
  `electron: { confirmUnload: true }` asks the user Leave / Stay.
- **Media files on disk:** `serveFile(req, path)` serves them with Range.
- **A stored cell you removed warns on every boot:** `am persist --drop=<cell>`.
- **Demos and agents:** `am start --instance=X --fresh` for throwaway data; a
  compiled artifact takes `--instance=<name>` too.
- **Your app starts its own Worker** from a literal `new URL(…)`: the compile
  now embeds it — a `compile.include` line you added for it can stay.

## Retire

Each of these was a workaround for something 1.0.23 does itself:

- An in-page splash card shown over the window, and `minMs: 0` to keep the
  native splash from holding the window — the splash no longer holds it
  (1.0.23).
- `shift: false` / `mod: false` added to every `onGlobalKey` chord so a binding
  does not fire with an extra modifier — a chord string (`"mod+h"`) matches
  exactly (1.0.23).
- A hand-written HTTP Range handler for media files — `serveFile(req, path)`
  (1.0.23).
- A folder picker plus a name prompt plus an "exists, replace?" check for "Save
  as…" — `pickSave()` (1.0.23).
- Moving a picker out of a `serverFn` into a cell method only to survive the 30
  s timeout — a picker holds the timeout in both (1.0.23).
- `ref={(el) => el?.setAttribute("list", id)}` and similar casts for standard
  HTML attributes the JSX types lacked (1.0.23).
- Opening another app's `state.db` read-only to read its saved state —
  `am state --app=<id> --offline` (1.0.23).
- An app-level `onRestore` that only deletes a dev-debris cell key —
  `am persist --drop=<cell>` once (1.0.23).
- Isolating `HOME` / `XDG_*` by hand to run a compiled artifact beside a
  person's copy — `<artifact> --instance=<name>` (1.0.23).
- A `compile.include` line added only for an app's own `new Worker(new URL(…))`
  — embedded automatically (1.0.23); the line is harmless if kept.
