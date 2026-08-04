## Core aio (hardness)

- aio is using as simple approaches as possible to complete the mission
- protocols are optimal and reliable, no hidden errors, no "why this doesn't
  work" questions
- straightforward approach everywhere so that child can reason about it (ho
  magic with millions of reasons why something doesn't work)
- connection between client is server is always working or visibly obvisous when
  not with true reason why it's not working
- no state leaks
- no space of unexpected errors
- no space for poor reactivity (like ui is not updated for unkonwn reason)
- robus, super serious error reporting, true state, all issues detected in
  advance

## WYSIDIWYSIP — what you see in dev is what you see in prod

- a dev build and a production build of the same app are 1:1 in UI and behavior
  — same shell markup, same `<head>` inputs, same stylesheet, same icon, same
  viewport, on every target (browser, electron, android, client); a target that
  structurally CANNOT carry an input (the packaged android-local shell is
  written at build time, before `aio.run()`'s `ui.head`/`viewport`/`showStatus`
  exist) is a documented limitation, never a silent drop
- the ONLY permitted dev/prod differences are (a) observe-only development
  tooling (live-reload, overlays, verbosity, am access) or (b) dev being
  STRICTER than prod — never a visual or functional divergence, no exceptions
- one decider per shared input: anything both dev serving and prod packaging
  need (app dir, UI entry, style.css, icon.png, shell HTML) is resolved by ONE
  rule in ONE place — a second hardcoded path or hand-rolled shell copy is the
  bug class, not a style nit (the "white border" report: dev served the
  stylesheet from the app dir, the build copied from a hardcoded `src/`, prod
  silently shipped without CSS)
- gate: `tests/shell-parity.test.ts` — dev-vs-prod shell byte-parity outside
  allowlisted observe-only scripts, electron/android shells delegate to the one
  shell builder, build app-dir decider == dev server rule
