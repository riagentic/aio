# Testing

Verifying cells and UIs work correctly.

- [UI Testing](ui-testing.md) — testUI semantic surface, am surface/trigger,
  AI-agent loop
- [Cell Testing](cell-testing.md) — testCell, assertions, async, fuzz
- [Linter](linter.md) — aiol static analysis, CI integration

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
