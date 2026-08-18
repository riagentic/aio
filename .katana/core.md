# core
## Core aio (hardness)

- every public API has ONE way to do the common thing; a second spelling for the
  same job exists only as a documented deprecated alias with a removal entry
- protocols are optimal and reliable, no hidden errors, no "why this doesn't
  work" questions
- nothing in the framework acts on a value the app did not write or the docs did
  not name: no implicit magic key, no inferred behavior a reader of the app's
  own source cannot predict
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
