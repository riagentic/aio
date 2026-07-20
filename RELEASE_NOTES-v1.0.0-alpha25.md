# v1.0.0-alpha25 — source-first onboarding + feature freeze

Install once, create, run, ship — four lines, no JSR.

## Onboarding is four lines

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
am create my-app
cd my-app && deno task dev
deno task compile        # · deno task electron · deno task android
```

- `install.sh` git-clones aio → `~/.local/lib/aio`, checks out the **last tagged
  release**, and installs `am` from the clone. No JSR, no publish, no login.
- `am create` links the app to that clone via a portable `dep/aio` symlink.
- `am update` = fetch + checkout the latest tag. Windows: `irm …/install.ps1 | iex`.

A working counter (or `--template=todo`) app — runnable and buildable to a
binary, Electron desktop, or Android APK.

## Feature freeze

alpha25 is the last feature-adding release. The framework is complete:
persistence + state + UI, batteries included. From here it's **fix, test, and
field-report** only.

## Why we left JSR

JSR range resolution is broken for `1.0.0-alphaN` naming (prereleases sort
lexically → `@^1.0.0-alpha` resolves to `alpha9`, not the newest), and the
publish flow is untestable before publishing. Source-first sidesteps all of it.
`--jsr` remains available for pinned consumption if you want it.

## Upgrade

No app changes. Re-run the installer (or `am update`) to get alpha25.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
