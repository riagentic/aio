# Upgrading from alpha72 to alpha73

**Nothing in your app code breaks.** This release is about what aio _says_ —
every line it prints to a person, in one vocabulary — plus three tiny additions
to the public surface and one flag on `am`.

```sh
am pin --latest && am fix   # or: deno task upgrade
```

## What changes without you doing anything

### Every aio surface now speaks one language

`am`, the build, the dev log, error reports, the linter, the installers and the
gate scripts each had their own idea of what a warning, a success and a table
look like — five glyph vocabularies, five colour palettes, and one surface
(`am doctor`) that answered a person with `JSON.stringify(x, null, 2)`.

There is now one presentation vocabulary
([`src/diagnostics/fmt.ts`](../../src/diagnostics/fmt.ts)) and everything
composes from it:

| Was                                    | Is                                           |
| -------------------------------------- | -------------------------------------------- |
| `[build] ✓ dist/app.js`                | `✓ dist/app.js  161.0 KB`                    |
| `⚠ UNPINNED — a clone of this repo …`  | a wrapped block with the fix on its own line |
| `{ "ok": true, "findings": [] }`       | an aligned check list and a tally            |
| `app pid=490037 port=56647 started ws` | a table                                      |
| `1 op(s)` · `3 item(s)` · `2 build(s)` | `1 op` · `3 items` · `2 built`               |
| `┏━━ AIO ERROR ━━┓`                    | the failing source line, with a caret        |

The rules it follows are the ones aio already had, applied everywhere:

- **Colour is decoration.** `NO_COLOR`, `FORCE_COLOR` and "is stdout a terminal"
  decide it in ONE place, and turning it off changes no character of a message —
  only whether escapes surround it. The installers (`install.sh`, `run.sh`,
  `install.ps1`, `run.ps1`) honour it now too; they used to paint escapes into
  every pipe and CI transcript unconditionally.
- **Prose wraps to your terminal.** Blocks are measured against the real width,
  so a warning no longer runs off the right edge with the remedy on it.
- **`--json` is untouched.** The two branches share no formatter, so every
  script and agent that parses `am … --json` sees exactly what it saw in
  alpha72.

### Errors show the code that failed

An `AioError` printed in dev now carries the source line with a caret under the
column, read from disk at report time:

```
✗ METHOD_THREW  cell todo · action addItem

  Cannot read properties of undefined (reading 'push')

  src/cell.ts:14:20
    13 │ addItem(s, text) {
    14 │   s.items.push(text)
       │           ^

  → state.items has no default. Give it one in cell({ state }).

  cid 7f3a1c
```

Best-effort by construction: no excerpt for a file the process cannot read, or
one inside `dep/aio`/`node_modules`. The compact production line
(`formatErrorCompact`) is unchanged.

### `deno compile` stops printing its module tree

The build passes `-q` to `deno compile`, which was emitting an "Embedded Files"
tree of every module in the bundle — several hundred lines for an app with three
of its own. Compile **diagnostics** are unaffected: a compile that fails still
says why.

### A scaffolded app is formatted

`am create` now runs the app's own `deno fmt` over what it just wrote, before
the first commit. New projects used to open with a formatting diff over code the
user had not written.

### The boot report is one log entry

The ~26 lines of `web`, `ws`, `id`, `version`, `bind`, `data`, … each carried
their own timestamp, level and category — about a thousand characters of prefix
for twenty-six facts. They are one entry now: your terminal shows an aligned
block, and `app.log` receives them as **structured data** (`web=…`, `bind=…`)
instead of twenty-six lines of prose. Anything that greps the log for a field
name gains; anything that grepped for the literal string `"  web       http…"`
should grep for `web=` instead.

## New

### `bytes`, `dur`, `count` on `aio`

The three unit formatters every aio surface prints through, exported from the
core entry because both halves of an app need them and they are pure and
isomorphic:

```ts
import { bytes, count, dur } from "aio";

bytes(219442); // "214.3 KB"
dur(48_780_000); // "13h 33m"
count(1, "app"); // "1 app"   ·   count(4, "app") → "4 apps"
```

They are public because they were being copied instead — six private byte
formatters and three uptime formatters lived in aio itself, one rounding KB to
whole numbers and one rounding 90 minutes to `2h`, so one number read three
ways.

### `am instances --long`, and a shorter `am help`

- `am instances` is a table. The paths nobody compares across rows (socket, data
  home, cwd) moved behind `--long`.
- `am help` lists every command on one line each, derived from the same text
  `am help <command>` prints in full. `am help --all` is the old wall.
- `am help tables` answers — `tables` ran but had no help entry, and a new gate
  now checks every registered command against the help text.

## Retire

Nothing. No config key, no export and no CLI flag was removed in this release.

The private log prefixes `[build]`, `[compile]`, `[cli]`, `[android]`, `[ios]`,
`[electron]`, `[appimage]`, `[ship]`, `[fleet]` and `[service]` are gone from
**output**. They were never API, and nothing in aio or its tests matched on
them; if you grep build output for `[build]`, match the glyph or the message
instead.
