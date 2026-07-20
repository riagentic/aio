# v1.0.0-alpha24 — onboarding that feels like magic

Install once, and `am` does the rest. Sync methods return values. The
server/client boundary guard becomes precise.

## Highlights

### `am` — the aio manager, one path from zero to shipped

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
am create my-app          # or --template=todo
cd my-app && deno task dev
```

- Installs Deno if missing, puts `am` on PATH (Windows: `install.ps1`).
- `am create` scaffolds a **runnable, git-initialized** app with a **passing**
  starter test, and builds to every target with one line each —
  `deno task compile | electron | android`.
- The app is pinned to the exact aio version `am` was installed at, so app and
  framework stay in lockstep.
- `am update` / `am uninstall` self-manage; your apps are never touched.

This replaces the old interactive scaffolder entirely — one path, no menus.

### Sync methods can return values (AIO-427)

```ts
methods: {
  addItem(s, item): string {
    const id = crypto.randomUUID()
    s.items.push({ ...item, id })
    return id
  },
}
const id = await cart.addItem(item)  // ← resolves with "…", inferred as string
```

No more making a method `async` just to hand a value back. Effects still route;
a returned draft slice is snapshotted so it survives the reducer.

### Precise server/client boundary (eager blocks, deferred warns)

The import guard now keys off *how* a server-only thing is reached from the UI:

- **Static** import of a `node:` builtin / omitted `aio` server-symbol
  (`createDB`, …) → **blocks** with the diagnostic page (it blank-screens the
  sandboxed renderer; `deno task compile` fails the same — dev==prod).
- **Dynamic `import()`** of the same → the documented escape hatch — **deferred,
  a warning, never a block.**

Apps that already lazy-load server-only modules (the recommended pattern) now
pass clean. `deno task check:graph` runs the same check in CI.

## Upgrade

No app changes required. Pin the new version:

```jsonc
"imports": { "aio": "jsr:@riagentic/aio@1.0.0-alpha24" }
```

`am`-installed projects get it via `am update`. As always in alpha, breaking
changes ship here and never in beta/final.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
