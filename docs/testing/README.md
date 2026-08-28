# Testing

Verifying cells and UIs work correctly.

- [UI Testing](ui-testing.md) — testUI semantic surface, am surface/trigger,
  AI-agent loop
- [Cell Testing](cell-testing.md) — testCell, assertions, async, fuzz
- [Testing two apps at once](multi-app.md) — `testApps`: the service +
  rich-client shape, where the client is itself an aio app
- [Cassettes](cassettes.md) — `openCassette`: record a real device/network
  session once, replay it in CI forever
- [Proving the tests](proving-the-tests.md) — `check:mutations` breaks each
  load-bearing invariant on purpose and requires a named test to go red;
  `check:vacuous` catches tests that pass while asserting nothing;
  `check:dead-wiring` catches exports that nothing in `src/` ever reaches
- [Linter](linter.md) — aiol static analysis, CI integration
- [Onboarding lab](onboarding-lab.md) — `deno task lab`: the real one-liners on
  a fresh Ubuntu container, plus "does MY repo build and run on a clean
  machine?" for any path or GitHub link
- [VM labs](vm-labs.md) — `am lab windows|macos`: a REAL Windows or macOS
  desktop in a container, driven by hand from a browser, with the app's `dist/`
  mounted in. The manual tier next to `test:wine` and `deno task lab`

## What each boot gate proves

Four gates say "the client boots", and they prove different things. Read the
claim, not the name:

| Gate                                   | Proves                                                                                                                                                                                             | Does not prove                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `testUI(App, …)`                       | the component renders and its methods dispatch, under happy-dom, module by module as Deno loads them                                                                                               | that the _bundled_ graph loads in a browser                   |
| `smoke()`                              | every eagerly-linked client module is served (200) by a real boot, with the static chain that loads it                                                                                             | that any of them _evaluates_ without throwing                 |
| graph validation (dev / `check:graph`) | the walk (missing files, static server-only imports) **and** the prod graph: bundled, audited and its module scope _evaluated_ — see [dev mode](../build/dev-mode.md#dev-evaluates-the-prod-graph) | render-time errors; the app is not mounted                    |
| `deno task build`                      | the same audit and evaluation on the artifact's own `dist/app.js`, before it can compile                                                                                                           | anything after `mount()` — that is `testUI` and `testBrowser` |

None of them is a real browser. `testBrowser` (`deno task test:e2e`) is, and the
onboarding lab drives the built app over CDP. If a project's own task promises
more than its gate proves — a "browser check" that is a static walk — the doc
lies; fix the wording or add the gate.

## Sanitizers stay on

Deno's leak sanitizers (`sanitizeOps`, `sanitizeResources`, `sanitizeExit`) are
the one thing that tells a test it left a timer, a socket, a file or a child
process behind, and tests are the strictest environment aio runs in — so a test
never turns one off without saying why. `deno task check:sanitizers` holds the
count of unexplained opt-outs at zero: an opt-out must carry
`// aio-ok: <the specific reason>` on its line or the line above, and the reason
names the resource the test cannot reach (a real browser driven over CDP, a
compiled binary that re-execs itself, a Wine or VM child). Everything else
cleans up — await what you started, close what you opened, `await using` what
has a disposer — and proves it by running green with the sanitizers on.

## Driving the app you are running

`am surface` and `am trigger` ([App Manager](../clients/app-manager.md)) are the
live-app half of the same idea as `testUI`: the running app publishes its
semantic surface, and you observe it and act on it from the shell — no driver,
no selectors, no screenshot diffing.

```sh
am surface --json            # components, elements, live text/value/checked
am trigger "App/Trail:up" click     # reply includes the fresh surface
```

Filed under Clients because that is where `am` is documented, but it belongs in
your dev loop, not your ops runbook: it is what lets you say "it works" rather
than "the tests pass".
