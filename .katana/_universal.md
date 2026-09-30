# Universal katana rules

## Critical

- application cannot cause system instability, restart or freeze
- application always leaves at least 10% of RAM reserved and unused
- applicaiton always leave at least 10% of VRAM on GPU connected to monitors
  reserved and unused
- application always keep HW nad OS it is running on normaly functional and
  responsive
- application never introduces any security vulnerability
- application doesn't break privacy or expose or leak (logs included) private or
  confidential information

## Role

- prefer solutions that a domain expert would recognize as standard practice;
  novel approaches carry a written rationale
- every change ships with its tests green, and regressions get a regression test
  when fixed
- There is no overengineering, all is done as brilliantly simply
- Everything is easy to understand and grasp, complex stuff is broken down to
  simple, maintainable and easy to understand elements
- AI always tries to understand intention perfectly, then it reasonably analyze
  the problem and plans the solution, then when satisfied with design, it
  implements and test it

## AI and context

- prefer compact, information-dense artifacts (memory files, commit messages,
  reports) over verbose ones

## Functional approach

- All that can be done without introducing additional complexity with pure
  functional and immutable approach is done in this manner
- Everything is done in a way that reasoning about functionality, issues or bugs
  is trivial
- Everything has its own scope that never leaks data anywhere else
- Modules are optimally separated for optimal maintainability and reusability
- All that is designed is also ready for future isolation and separation as
  independent reusable project or component

## Testing

- Whatever is designed is also designed from aspect of flawless future
  testability and maintainability
- Whatever is designed is also tested with real tests that mimics real usage as
  close as possible
- ui tests are executed in xephyr (on linux) or similar solution where they
  don't steal focus when app window is opened due to running ui test

## Basic assertions

- app can start without errors
- if it's ui app, ui loads correctly (no blank screen or errors, etc.)
- all errors and warning from logs are resolved and fix correcty
