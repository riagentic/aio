# Effort towards aio beta

Two kinds of line live here, and they are not the same kind of thing.

A **rule** is a `- ` bullet: it can be failed, so an audit returns a
measurement. A rule with no instrument yet is still a rule — the audit reads
the code and is a user of it, which is how every defect so far was found.

**Direction** is prose. It decides what to build and which way to lean when two
designs are both defensible. It is not scored, because scoring an adjective
produces an opinion wearing a verdict's clothes.

## Compatibility

- aio keeps backward compatibility, anything that break compatibility must be explicitly approved
- if any fix or improvements needs to break compatibility (ie existing application will not work correctly without code upgrade), there will be approval request with explanation why it's necessary (or needed) and it will be either approved or denied

`check:api` is the instrument: it reports BREAKING separately from additive and
refuses an unregenerated snapshot.

## State

- desk is clean — no open item in `todo.md`, and every row of the physical proof matrix is either proven or names what it is waiting for (a machine, a phone, 72 hours) rather than waiting on us
- the coverage floor holds, and only ever ratchets up (`check:coverage`)
- all tests are green (`test`, `test:build`, `test:onboard`, `test:e2e`, `test:electron`)

## Errors and messages

- aio is not hiding any errors or issues
- every refusal names its fix in the same message — the cause and the way out arrive together, or the reader goes to the source
- a value the framework accepts is a value it acts on: a flag, an option or a key that is parsed and then ignored is a defect, not a no-op

The instruments: `check:silent-catch` (a swallowed error must say why),
`check:placeholders` (a `${…}` that never interpolates), `check:vacuous` (a test
that cannot fail), `check:docs` (every error code documented).

## One spelling

- one concept has one spelling across CLI, config, API and docs
- every option works with zero config, and its default is stated where the option is documented

## Discoverability

- every test belongs to a task that a gate chain runs (`check:gated-tests`)
- every dependency request is bounded, so the same commit resolves the same way tomorrow (`check:lock`)
- a claim a doc makes is a claim some test holds (`check:docs` reads every "pinned by `tests/…`" as a promise)

## Direction

*aio is intuitive. aio is user friendly. aio provides great developer
experience. The architecture is sound, and as simple — yet powerful — as
possible, to ease reasoning and maintainability. aio should lead its user
towards efficient, responsive and maintainable applications rather than merely
permit them.*

These are the tie-breakers. When two designs both pass every rule above, the
one that a person could have guessed wins; when a feature and the size of the
API are in tension, the API wins; when a capability would let an app be written
badly, the framework refuses the shape rather than documenting the hazard.

Nothing here is scored. An audit that reports "aio is intuitive ✅" has
measured nothing, and an audit that reports "❌" has done no better — both are
one reader's taste with a glyph in front of it. What these lines are for is the
decision taken before there is anything to audit.

## Where the failures have actually come from

Prose, deliberately: these are patterns to recognise, not rules to score.
Every one of them passed a full green suite.

**Config that is statically knowable but validated only when it FIRES**, or
never. **Two deciders for one question** — an entry point's flag vocabulary and
the subset it forwards; a ledger of test names and the test names. **A caller
left behind by a contract change**: the artifact moved to `dist/` and three
callers kept scanning the project root, each reporting "nothing built" after a
successful build. **A test that no gate runs**, which is a test that is not
there. And **a green instrument that was never shown able to go red** — the
one that makes all the others invisible.
