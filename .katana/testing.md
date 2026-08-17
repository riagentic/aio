# Testing

- aio framework is properly tested and all errors are fixed
- every single aio functionality is covered with real tests
- src/ line coverage never drops below the ratchet floor in
  scripts/check-coverage.ts (CI gate `deno task check:coverage`); the floor only
  moves up
- examples in examples/ are tested
- examples with ui are tested by ui functional tests proving that app is usable
  by a user
- aio test coverage is 100% or whatever is realistically possible
- aio has ui tests to cover all major use cases
- on the maintainer's Linux machine, a UI test's windows open in Xephyr
  (`scripts/xephyr.sh`, display `:77`) and never on the real desktop — the
  harness finds it or starts it detached (`src/testing/test-display.ts`). This
  protects the developer's session; it is NOT a requirement imposed on other
  users of the framework, who may have no Xephyr (they get the warning and the
  real display) and no session at all in CI (headless, nothing to steal)
