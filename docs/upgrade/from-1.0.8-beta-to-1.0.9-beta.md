# Upgrading from 1.0.8-beta to 1.0.9-beta

Nothing breaks; the testing surface gains pressed, expanded, richer checked, and
attr — additive only, no removals.

**The public surface is additive only.** New reads on the testing surface
(`pressed`, `expanded`, a richer `checked`, and `attr`) — no removals and no
changed signatures elsewhere. The three new required members on
`UIElementHandle` are recorded via `update:api --allow-break` (no app constructs
that handle).

```sh
am pin --latest
```

**No app needs a code change.** Nothing here refuses to boot that booted before,
and nothing you call moved. This release is the polish round that closed the
remaining honesty gaps in `am`, finished the TLS verifier matrix (Conscrypt),
and made the UI harness tell the truth about ARIA toggles.

## Retire

Workarounds this release lets an app delete:

- **A hand-rolled parse of `am prune --json` / `am doctor --json` /
  `am lab --json` / `am restart --json` that skipped the first document or
  treated exit 0 as "it worked".** One document, and a real failure is exit 1
  (1.0.9-beta).
- **A sleep-then-hope, or a second process watch, after `am shot --video --json`
  before driving the scene** — waiting for the final document to know recording
  started. Progress announces on stderr as soon as the recorder is live
  (1.0.9-beta).
- **A regex or string match against a raw ENOENT / HTTP 404** from a mistyped
  update channel, written because the failure looked like a transport fault. The
  message names the channel path now (1.0.9-beta).
- **`ui.… .attr("aria-pressed") === "true"`** (or `"aria-expanded"` /
  `"aria-checked"`) in a UI test, or a comment explaining why
  `assertEquals(ui.Mute.pressed, false)` was unwritable. Use `.pressed` /
  `.expanded` / `.checked` (1.0.9-beta).
- **A custom `check()` path for `role="radio|checkbox|switch"`** that clicked
  and then read `aria-checked` by hand, because the harness refused or clicked a
  plain button. `check()` / `uncheck()` honour the ARIA pattern now
  (1.0.9-beta).

Nothing else — no API was removed, so no call site has to move.

## What got better

### `am` honesty

- `am prune --yes` reports what it actually removed and exits 1 when anything
  failed; `--json` is one document with `failed` + actual `freed`.
- `am doctor --json` puts findings and error in one object.
- `am lab --stop` / `--reset` fail on a real docker/rm failure instead of
  claiming `{stopped:true}` / `{reset:true}`.
- `am restart --json` keeps notes on stderr; stdout is the one start result.
- `am shot --video --json` announces "recording started" on stderr so a script
  can drive the scene into a live recorder.

### Updates

- A missing release manifest (HTTP 404 or missing `file://`) says
  `no release manifest at <url>` — the channel path — instead of a raw transport
  fault.

### testUI

- `.pressed` and `.expanded` are first-class booleans (`false` included).
- `.checked` follows `aria-checked` on `role="radio|checkbox|switch"` as well as
  native checkbox/radio.
- `check()` / `uncheck()` match that surface.
- `.attr("…")` remains for every other attribute.

### TLS matrix complete

- Android/Conscrypt 2.5.2 measured: ignores anchor name constraints and anchor
  EKU — same row as Java. No cert shape change; the intermediate verdict from
  1.0.8-beta stands. Probe: `tests/x509-conscrypt.test.ts`.

### Transport + harness

- Wire losses pinned for array-`undefined`, `NaN`/`±Infinity`, `Set`, `Date`,
  `BigInt` (refused), plus a real-Chromium sync-method replay differential.
- Flaky `am` / `spawn` suites rooted in harness fixtures (esbuild child,
  inherited pipes), not product — closed under load with sanitizers on.
- A boot that throws while binding a taken port tears down fully (the server
  phase is skipped when the transport never came up, and the dev watcher is
  stopped), and the test harness retries a lost `freePort()` race instead of
  failing the test. No app-visible behavior change — this is the boot-failure
  path and the test harness.

### Ratchets

- Silent-catch ceiling 322 → 319; browser server-only stubs prove the teachable
  throw; `blocking` on the page is a facade with no worker pool.
