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

## Driving the app you are running

`am surface` and `am trigger` ([App Manager](../clients/app-manager.md)) are the
live-app half of the same idea as `testUI`: the running app publishes its
semantic surface, and you observe it and act on it from the shell — no driver,
no selectors, no screenshot diffing.

```sh
am surface 0 --json          # components, elements, live text/value/checked
am trigger 0 "App/Trail:up" click   # reply includes the fresh surface
```

Filed under Clients because that is where `am` is documented, but it belongs in
your dev loop, not your ops runbook: it is what lets you say "it works" rather
than "the tests pass".
