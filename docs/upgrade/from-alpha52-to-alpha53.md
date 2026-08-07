# Upgrade: alpha52 → alpha53

Small and additive after the big one. **No code changes required** — one CLI
command changed meaning, and it refuses the old usage instead of guessing.

## 1. `am ui` opens amui (the old projection is `am state --ui`)

`am ui` used to print the server-side UI-state projection. It now **launches
amui**, the visual app manager:

```sh
am ui                      # Electron window (amui's default client)
am ui --client=browser     # …or a browser tab
```

The projection moved, unchanged:

```sh
am state --ui              # what the browser sees (cell `visible:` applied)
am state --ui alice        # …for one user
```

Typing the old form (`am ui alice`) exits 1 with a pointer to the new spelling —
it never opens a window by mistake. Scripts parsing `am ui` output are the only
thing to update; `--json` shape is unchanged under `am state --ui`.

## 2. `host` — bind exactly one interface (new, optional)

```sh
deno task dev --expose --host=192.168.1.20
```

```ts
await aio.run({ expose: true, host: "192.168.1.20" });
```

The flag wins over the config value. Everything aio prints or opens (boot
report, share link, the window it launches) names the address actually bound;
`localhost` appears only when the bind really answers there. Omit it for the
previous behaviour (`0.0.0.0` exposed, `127.0.0.1` not).

## 3. No-action improvements

- An app that raised `wsLimits.maxMessageBytes` now gets the same frame ceiling
  on the Electron/UDS hop (it was capped at 10MB there, and the connection reset
  mid-send instead of refusing).
- `aiol` renders `[manual]` (with the reason) for findings a safe-fix
  deliberately declines, instead of `[fixable]` items that never converge.
- `am fix` writes a `path:` pin when `dep/aio` links to a local checkout, so the
  repaired app no longer trips `aiol`'s pin check.
