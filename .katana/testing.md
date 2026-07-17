# Testing

- aio framework is properly tested and all errors are fixed
- every single aio functionality is covered with real tests
- src/ line coverage never drops below the ratchet floor in
  scripts/check-coverage.ts (CI gate `deno task coverage:check`); the floor only
  moves up
- examples in examples/ are tested
- examples with ui are tested by ui functional tests proving that app is usable
  by a user
- aio test coverage is 100% or whatever is realistically possible
- aio has ui tests to cover all major use cases
