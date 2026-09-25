# Upgrading from 1.0.11-beta to 1.0.12-beta

Nothing is removed and nothing changes shape. No app needs a code change.

```sh
am pin --latest
```

## What you may notice

- **A `testUI` seed of a key the cell does not declare now warns.** In 1.0.11
  `testUI(App, { seed: { cell: { key } } })` took any key and silently dropped
  one the cell does not declare, so a typo (`gpuCount` for `gpus`) pinned
  nothing. The mount still runs; a `[aio] seed:` warning names the key and the
  cell's real keys. That includes an OPTIONAL key: a cell typed
  `state: {} as { draft?: string }` has no `draft` until something writes it. To
  make the seed land, declare it,
  `state: { draft: undefined } as { draft?: string }`. The type and the app's
  behaviour stay the same. `t.init(seed)` in `testCell` already refused unknown
  keys in 1.0.11; its message now names the same fix.

- **A new store key, `<appId>:__shapes`.** Every state write now also stores a
  fingerprint of each written cell's declared shape, in the same transaction as
  the cell's data. On the next boot, data that drifts from the declaration it
  was written under (one bad `am dispatch counter:increment abc` used to be
  enough) starts in dev with a warning that names each field and the fix, and
  that field gets its default back, as prod already did. A changed declaration
  with no migration still refuses in dev. A store written by 1.0.11 has no
  stamps until its first 1.0.12 write, and until then the dev drift check stays
  as strict as it was. A script that lists the raw keys of `state.db` sees one
  more `__` key next to `__schema` and `__versions`. 1.0.11 skips `__` keys, so
  going back to 1.0.11 still works.

- **`<Browser keepAlive>` no longer leaves a blank box.** It moved the
  `<webview>` into a hidden holder on unmount and back on the next mount, and
  Electron destroys a guest that is moved, so every remount showed a dead
  element (measured on Electron 44). It now remembers the page the guest was on,
  and the next mount under that id opens there, unless `src` changed in the
  meantime. Scroll, forms and JS state are not kept, because no guest survives
  an unmount. Cookies belong to the partition's session and are kept either way.

- **A write request that matches no route gets 405.** A `POST`/`PUT`/`DELETE`/
  `PATCH` to a path with no route used to get `200` and the app's HTML shell, so
  a mistyped API path looked like success. A browser form navigation still gets
  the shell, with a warning. A `routes` key containing `?` or `#` warns at boot
  (it can never match).

- **An async method that holds a row across an `await` can now be refused.**
  When ANOTHER action moved or removed rows of the same array during the await,
  `row.v = …` after it used to land on whichever row took the slot. It now
  throws, naming the other action. Re-find the row after the await
  (`s.items.find((r) => r.id === id)`), as `docs/state/methods.md` shows.

- **A tab whose session was revoked or expired says "Signed out".** It used to
  reconnect forever with the dead credential ("Reconnecting…"), and each try
  counted as a failed login. It now stops, `useUser()` reads `null`, and
  `<SignIn/>` renders; signing in (in this tab or another, on focus) resumes it.

- **The default icon may change colour.** Its hue now comes from the appId (as
  the theme's accent always did) instead of the display title, so an app whose
  title differs from its id gets an icon that matches its buttons.

- **Cross-built `server` targets: one systemd unit per Linux binary.** A server
  target built for several platforms crashed on a unit-name collision. Units are
  now written for Linux platforms only, named like their binary
  (`myapp.service`, `myapp-linux-arm64.service`).

- **Project components start as their `kind`.** A `"kind": "server"` component
  starts with `--client=server-only` instead of the project's default client
  (the documented relay example could not start). Electron components keep the
  project's client. An explicit `--client`/`--headless`/`--service` still wins.

- **A dev warning: dark OS, light page.** Under `ui.theme: "tokens"` (the
  default), the kit's colours turn dark-mode on a dark OS, but nothing paints
  the page, so light text lands on white. Dev now says so once
  (`[aio] Dark OS, light page…`). One line fixes it: `ui.theme: "auto"`, or
  `:root { color-scheme: light dark }` — see "Dark OS, light page" in
  `docs/ui/theme.md`. A framework-side fix is planned for 1.0.13.

- **An embedded page gets no permissions.** A `<webview>` guest (a `<Browser>`
  panel) or a foreign-origin frame used to be granted clipboard read, camera,
  microphone, geolocation and notifications. It is now denied all but
  fullscreen, and the log says so once per permission and origin
  (`[aio:electron] permission "…" DENIED to embedded page …`). Your app's own
  page is unchanged. A page that needs a permission belongs in a window
  (`__aioIPC.openWindow`) — see "Security" in `docs/clients/webview.md`.

- **New, opt-in: `"build": { "minify": true }`.** The compiled binary ships the
  server code minified — no comments, short local names — instead of readable
  source. Off by default; nothing changes unless you set it. See
  [Hide the server source](../build/targets.md#hide-the-server-source-buildminify).

- **Electron fuses are off in every desktop package.** The shipped Electron
  ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`. Nothing
  changes for an app started normally. The self-contained Windows exe unpacks
  its Electron once more, into a new `…-fused` cache folder.

- **Under `--profile`/`--home`, a `dbPath` outside the profile home refuses to
  boot.** In 1.0.11 it opened the everyday database while the lock, logs and
  `meta.json` moved to the profile's home. The line names both paths. Derive
  your paths from the new `resolveHome()` in `aio/server`:
  `join(resolveHome({ appId }).home, "data", "state.db")`. Without a profile,
  nothing changes.

## Retire

If you deleted `state.db`, or started in prod, only to get past a dev boot that
refused data a bad dispatch had written, you no longer need to for data written
by 1.0.12.
