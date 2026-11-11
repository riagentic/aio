# Upgrading from 1.0.26-beta to 1.0.27-beta

Nothing is removed, renamed or changed in behaviour. `mod.ts` and the
`deno.json` exports are unchanged. An app upgrades with no edit by hand.

```sh
am pin v1.0.27-beta
am fix
```

## Behaviour you may notice

- **Stack traces from the boot** name the new files (`boot-config.ts`,
  `boot-storage.ts`, `boot-dispatch.ts`, `boot-transport.ts`) and show one more
  frame where `aio.ts` forwards to a moved step. What runs, and in what order,
  is unchanged.

## Retire

Nothing: this release fixes no app-visible bug, so no workaround becomes
unnecessary.
