tests/cell-reactive.test.ts · AIO-6.1 actions collision · PORTED (methods-form
collision, same capability) tests/live-proxy.test.ts · (all) · KEPT (false
positive — local `actions` arrays) tests/aio24-uds-ipc.test.ts · (all) · KEPT
(false positive — local arrays) tests/adapters-air.test.ts · (all) · KEPT
(internal __aio shape) tests/state-core.test.ts · (all) · KEPT (internal __aio
shape) tests/browser-sync.test.ts · (all) · KEPT (internal __aio shape)
tests/cell.test.ts · cell: action labels are cellName:actionKey format · PORTED
(methods carry the same `.type` catalog) tests/cell.test.ts · cell: action
creators produce { type, payload } · DELETED (machinery: explicit action-creator
payload catalog) tests/cell.test.ts · cell: default params preserved · PORTED
(behavioral: dispatch `{args: []}` → method default `by = 1`) tests/cell.test.ts
· cell: effect labels and creators · DELETED (machinery: effect-creator catalog)
tests/cell.test.ts · cell: selectors via compose · PORTED (methods cell +
selectors; isIdle reads a `status` state field) tests/cell.test.ts · cell:
machine validates action keys / target states / initial / reachability (4 tests)
· DELETED (machinery: machine table validation) tests/cell.test.ts · cell:
simple machine accepted · DELETED (machinery: `machine: false` config shape;
type-prefix covered by ported label test) tests/cell.test.ts · cell: foreign
actions in machine allowed · DELETED (machinery: foreign-action machine
declarations; methods-era cross-cell = direct calling, reactive.test.ts)
tests/cell.test.ts · compose: initialState includes __aio_status · DELETED
(machinery: machine status field) tests/cell.test.ts · compose: simple machine
has no _status · DELETED (machinery: machine status field) tests/cell.test.ts ·
compose: reduce routes action to correct cell · PORTED (methods cell, state
asserts; effect-creator assert dropped) tests/cell.test.ts · compose: machine
guard blocks invalid transitions · PORTED (as "guard ignores action in wrong
state" — no-op method, state untouched) tests/cell.test.ts · compose: state
machine transitions correctly · PORTED (as "status lifecycle transitions
correctly" — save/saved/saveFailed/retry/dismiss over `status` field with
method-top guards) tests/cell.test.ts · compose: multiple cells isolated ·
PORTED (methods cells) tests/cell.test.ts · compose: foreign action routing ·
DELETED (machinery: machine foreign-listener + foreign reduce-handler routing)
tests/cell.test.ts · compose: dependency order / cycle detection / unknown
dependency / duplicate cell name (4 tests) · PORTED (methods cells; compose
semantics unchanged) tests/cell.test.ts · testCell: increment from idle · PORTED
(state asserts; expect.effects/expect.status dropped — Style-B-era)
tests/cell.test.ts · testCell: save triggers persist effect · DELETED
(machinery: effect-creator emission; method-effect coverage lives in
async-method-effects.test.ts + ported ScheduleEffect test) tests/cell.test.ts ·
testCell: machine blocks invalid transition · PORTED (as "guard blocks save
while already saving" — second save ignored, status asserted) tests/cell.test.ts
· testCell: count is always a number (property-based) · PORTED (same
randomActions + invariants on methods cell) tests/cell.test.ts · testCell: full
lifecycle · PORTED (state asserts incl. status field) tests/cell.test.ts ·
aio.middleware freeze/devtools/perfBudget/validate×2/metrics (6 tests) · DELETED
(machinery: middleware — on the Style-B deletion list) tests/cell.test.ts ·
reduce: accepts ScheduleEffect in effects array · PORTED (sync METHOD returns
schedule.after → surfaces in composed effects) tests/cell.test.ts · compose:
machine:false does not receive foreign actions · DELETED (machinery: foreign
routing; isolation covered by ported "multiple cells isolated")
tests/cell.test.ts · compose: machine with foreign declaration DOES receive ·
DELETED (machinery: foreign-action machine routing) tests/cell.test.ts · onInit
getFullState / onInit own slice / persist 'all' / persist absent (4 tests) ·
PORTED (trivial `actions:{noop},machine:false` → `methods:{noop}` swap)
tests/cell.test.ts · mixed: methods+actions coexist / +effects compose /
collision method-action / method-effect / generator-action (5 tests) · DELETED
(machinery: mixed mode + its validation die with `actions:`/`generators:`)
tests/cell.test.ts · persist/ui internals, compose persist/ui filters,
cellDefaults, empty-methods stub, validateConfig ui keys (remaining tests) ·
KEPT (already methods-style) tests/cell-compose.test.ts · circuit breaker:
auto-disables after error threshold · BLOCKED: only error source reaching
countCellError/breaker is a SYNC throw from a Style-B `execute:` handler
(cell-compose-execute.ts:115-129); methods-era failures (async method rejection)
hit buildMethodsExecutor's .catch → reportError WITHOUT countCellError
(cell-methods-internals.ts:312-330); lifecycle throws reset/roll back so they
can't reach threshold. Needs src wiring (async-method error → countCellError)
before Style-B deletion; only breaker coverage in repo.
tests/cell-compose.test.ts · circuit breaker: below threshold keeps cell enabled
· BLOCKED: same as above tests/cell-compose.test.ts · errors: increment on
executor throw, visible in health() · BLOCKED: same — health() error counting
has no methods-era feeder tests/cell-compose.test.ts · errors: re-enable resets
error counter · BLOCKED: same tests/cell-compose.test.ts · (file left untouched
per deletion gate; deferred triage:
basic/multi-cell/validate/reduce-error-context tests already methods-style →
keep, though "reduce error … machine-guarded" carries a `machine:` that must
drop to a guard; fx effects test portable via sync-method schedule return; door
machine-guard ×2 portable via status-field guards; "validate: with machine"
deletable as machine interplay; registry "status returns _status from machine"
is machine machinery) tests/integration-reactive.test.ts · integration:
event-driven cell reacts to cell(methods) cell actions · DELETED (machinery:
machine foreign-listener + foreign reduce-handler routing; methods-era
cross-cell = direct calling, covered by reactive.test.ts "direct calling:
cross-cell") tests/integration-reactive.test.ts · integration: async
cell(methods) method with machine + sync methods · PORTED (machine → `phase`
field + method-top guards; added guarded-complete-ignored assert; __aio_status
asserts → phase asserts) tests/integration-reactive.test.ts · (other 4 tests) ·
KEPT (already methods-style) tests/machine-fn-targets.test.ts · (all 7 tests,
file removed) · DELETED (machinery: machine transition-fn targets +
validateMachine internals; methods-era conditional status is a plain state write
inside the method) tests/testcell-async.test.ts · awaiting a machine-blocked
async send resolves immediately · PORTED (as "awaiting a guard-blocked async
send resolves without doing the work" — machine gate → `gate` field + guard;
expect.status → state asserts) tests/testcell-async.test.ts · (other 9 tests) ·
KEPT (already methods-style) tests/async-method-effects.test.ts · machine-gated
cell: returned effect passes the __effects self-loop · PORTED (as "guarded cell:
async-returned effect still emitted" — machine → `phase` guard; still proves
async-returned ScheduleEffect emitted from a state-gated cell)
tests/async-method-effects.test.ts · (other 3 tests) · KEPT (already
methods-style) tests/client-scope.test.ts · 5.1: client cell — generators throw
at cell() time · DELETED (machinery: `generators:` config rejection — the key
itself dies with Style-B) tests/client-scope.test.ts · 5.1: client cell —
actions or machine throw at cell() time · DELETED (machinery:
`actions:`/`machine:` config rejection — same) tests/client-scope.test.ts ·
(other 3 tests) · KEPT (already methods-style) tests/reduce-breakdown.test.ts ·
(all) · KEPT (internal __aio shape — `actions:`/`reduce:`/`execute:` only inside
hand-built internals; false positive) tests/flow.test.ts · flow: basic flow
updates state · PORTED (async method computes + writes state) tests/flow.test.ts
· flow: cell with only generators (no reduce) · PORTED (async-methods-only cell)
tests/flow.test.ts · flow: mixed cell — reduce works independently · PORTED
(sync method) tests/flow.test.ts · flow: mixed cell — generator works alongside
reduce · PORTED (sync + async methods in one cell) tests/flow.test.ts · flow:
ctx.dispatch dispatches regular action · PORTED (async method calls sibling
method via bound cell) tests/flow.test.ts · flow: ctx.fail stops execution and
dispatches failed action · PORTED (throwing async method — later writes never
apply) tests/flow.test.ts · flow: ctx.sleep pauses then continues · PORTED
(sleep() helper) tests/flow.test.ts · flow: ctx.all (spread) runs calls in
parallel · PORTED (Promise.all) tests/flow.test.ts · flow: ctx.race picks first
to resolve · PORTED (race() helper) tests/flow.test.ts · flow: multiple
ctx.mutate calls execute in order · PORTED (staged writes across awaits)
tests/flow.test.ts · flow: ctx.waitFor pauses until matching action dispatched ·
PORTED (until() on state written by a sync method) tests/flow.test.ts · flow:
ctx.waitFor with timeout throws on expiry · PORTED (until timeoutMs + catch)
tests/flow.test.ts · flow: ctx.getState reads fresh state after step · PORTED
(live proxy fresh read after await) tests/flow.test.ts · flow: cancelOn stops
generator when matching action dispatched · PORTED (config cancelOn + s.$signal)
tests/flow.test.ts · flow edge: ctx.race with 3 near-simultaneous entries picks
exactly one · PORTED (race()) tests/flow.test.ts · flow edge: ctx.race — sync
call beats async · PORTED (race() with already-resolved branch)
tests/flow.test.ts · flow edge: ctx.waitFor with timeout=0 times out immediately
· PORTED (until timeoutMs:0) tests/flow.test.ts · flow edge: ctx.call with
timeout rejects on slow fn · PORTED (race() timeout sugar) tests/flow.test.ts ·
flow edge: ctx.call with retries recovers after failures · PORTED
(call({retries})) tests/flow.test.ts · flow edge: ctx.call exhausts retries then
throws · PORTED (call({retries}) + catch) tests/flow.test.ts · flow edge: cancel
mid-ctx.all prevents done · PORTED (cancelOn + $signal check after Promise.all)
tests/flow.test.ts · flow edge: ctx.all fails if any entry throws · PORTED
(Promise.all rejection caught in method) tests/flow.test.ts · flow edge:
ctx.race rejects when first entry rejects · PORTED (race() rejection caught in
method) tests/flow.test.ts · flow: ctx.getFullState reads other cell's state ·
PORTED (bound cell ref state getter read inside method) tests/flow.test.ts ·
flow: ctx.when resolves immediately when condition already true · PORTED (until
on already-true predicate) tests/flow.test.ts · flow: ctx.when resolves when
condition becomes true after dispatch · PORTED (until on other cell's bound
state) tests/flow.test.ts · flow: cancelling a flow waiting on ctx.when cleans
up listener · PORTED (cancelOn + until {signal: s.$signal}) tests/flow.test.ts ·
flow: multiple ctx.when listeners resolve independently · PORTED (independent
until waiters) tests/flow.test.ts · flow: ctx.when + ctx.waitFor in same flow ·
PORTED (two sequential until waits) tests/flow.test.ts · flow: ctx.when inside
ctx.race resolves when condition met · PORTED (until inside race())
tests/flow.test.ts · flow: basic flow dispatches step actions · DELETED
(machinery: __flow step-action protocol of the generator interpreter)
tests/flow.test.ts · flow: ctx.send dispatches via bound creator · DELETED
(machinery: ctx.* plumbing shorthand; capability covered by ported
method-triggers-method test) tests/flow.test.ts · flow: ctx.all (named) runs
calls in parallel and returns by name · DELETED (machinery: named
yield-descriptor variant; Promise.all port covers the capability)
tests/flow.test.ts · flow: throws if generator key not in actions · DELETED
(machinery: Style-B generator-key validation) tests/flow.test.ts · flow:
ctx.call works with sync functions · DELETED (machinery: call-descriptor sync-fn
handling; trivial/inherent in a method) tests/flow.test.ts · flow: error in
ctx.call dispatches error action · DELETED (machinery: __flow:error protocol;
capability covered by ported throwing-workflow test) tests/flow.test.ts · flow:
ctx.dispatch accepts action without payload · DELETED (machinery:
dispatch-descriptor payload-optional shape) tests/flow.test.ts · flow edge:
generator without ctx.done() auto-dispatches done · DELETED (machinery:
auto-done protocol; methods complete naturally) tests/flow.test.ts · flow edge:
restarting a flow cancels the previous instance · DELETED (machinery: flow-key
auto-cancel semantics of the generator runtime; explicit cancelOn replaces it)
tests/flow.test.ts · flow: ctx.getFullState reads own cell state · DELETED
(machinery: ctx plumbing; own-state read is inherent via the method draft)
tests/flow.test.ts · flow: ctx.getFullState returns fresh state after mutation
step · DELETED (machinery: ctx plumbing; covered by ported fresh-read test)
tests/flow.test.ts · flow: ctx.when with timeout throws on expiry · DELETED
(machinery: ctx.when timeout duplicates the ported until-timeout capability)
tests/flow.test.ts · flow: ctx.when predicate that throws is treated as false ·
DELETED (machinery: ctx.when error-swallowing; until() fails loud by design)
tests/flow.test.ts · flow: AIO-117 waitFor listener cleaned up on flow
cancellation · DELETED (machinery: _actionListeners internals of the flow
runtime) tests/flow.test.ts · flow: AIO-117 waitFor listener cleaned up in
finally on flow completion · DELETED (machinery: _actionListeners internals of
the flow runtime) tests/reactive.test.ts · cell(methods): machine guards on sync
methods · PORTED (status-field guard; asserts state fields, not machine status)
tests/reactive.test.ts · cell(methods): async Proxy writes gated by machine ·
PORTED (status-guarded async method stages writes) tests/reactive.test.ts ·
cell(methods): async writes blocked when method not in current machine state ·
PORTED (guard makes call a no-op in wrong state) tests/reactive.test.ts ·
cell(methods): machine validation rejects bad config · DELETED (machinery:
machine transition-table validation) tests/reactive.test.ts · cell(methods):
coexists with cell(actions) in composeCells · PORTED (two methods cells coexist)
tests/reactive.test.ts · cell(methods): foreign action listeners · DELETED
(machinery: machine foreign-transition table of Style B; cross-cell reaction
kept via direct-calling tests) tests/reactive.test.ts · cell(methods): __error
self-loop preserves machine state · DELETED (machinery: machine status
semantics; async-error capability kept in "__error action" test)
tests/reactive.test.ts · cell(methods): listensTo auto-generates machine for
foreign listeners · DELETED (machinery: machine auto-generation internals,
asserts __aio_status) tests/reactive.test.ts · cell(methods): listensTo ignored
when explicit machine provided · DELETED (machinery: explicit machine config)
tests/reactive.test.ts · call: rejects immediately when machine blocks the
target action · DELETED (machinery: machine-blocked dispatch rejection; guard
capability kept via ported gate test) tests/reactive.test.ts · cell(generators):
generator runs when action dispatched · PORTED (async method runs on dispatch)
tests/reactive.test.ts · cell(generators): generator mutates state via
ctx.mutate · PORTED (async method stages writes across awaits)
tests/reactive.test.ts · cell(generators): generator coexists with methods ·
PORTED (async workflow + sync method in one cell) tests/reactive.test.ts ·
cell(generators): A catalog includes generator action keys · PORTED (catalog
includes async method keys) tests/reactive.test.ts · cell(generators):
generators-only (no methods) works · PORTED (async-methods-only cell)
tests/reactive.test.ts · (4 kept call/direct-calling tests) · KEPT (removed
behavior-neutral `machine: false` config lines; no-machine is the default)
tests/memory.test.ts · memory: 10k dispatches — heap growth < 20MB · PORTED
(methods cell, same harness) tests/memory.test.ts · memory: 100 generator cycles
— no listener leak · PORTED (100 async-method cycles) tests/memory.test.ts ·
memory: waitFor listeners cleaned up after signal · PORTED (until() wait cycles
signalled by sync method) tests/memory.test.ts · memory: waitFor listeners
cleaned up on timeout · PORTED (until() timeout cycles) tests/memory.test.ts ·
memory: rapid state reset prevents unbounded growth · PORTED (methods cell
fill/clear) tests/stress.test.ts · (6 sync dispatch/throughput/payload tests) ·
PORTED (actions/reduce cells → methods cells, same harness + assertions)
tests/stress.test.ts · stress: 100 concurrent generators complete without
corruption · PORTED (100 concurrent async methods) tests/protocol.test.ts ·
protocol-cell: action type has cellName:actionKey format · DELETED (machinery:
Style-B action-catalog builder; type format asserted by kept methods-mode test)
tests/protocol.test.ts · protocol-cell: action creator returns { type, payload }
· DELETED (machinery: Style-B creator payload shape; methods-mode payload shape
kept) tests/protocol.test.ts · protocol-cell: action with no-arg returns empty
payload · DELETED (machinery: Style-B creator payload shape; methods no-arg
equivalent kept) tests/protocol.test.ts · protocol-cell: __aio internals contain
state, id, action/effect keys · PORTED (methods + effects config)
tests/protocol.test.ts · protocol-cell: effects catalog has correct types ·
PORTED (methods + effects config) tests/protocol.test.ts · protocol-cell:
generators appear as action creators in methods mode · DELETED (machinery:
generators config removed) tests/protocol.test.ts · protocol-cell: missing state
defaults to empty object · PORTED (methods config) tests/protocol.test.ts ·
protocol-cell: missing effects defaults to empty · PORTED (methods config)
tests/protocol.test.ts · protocol-cell: bound flag starts false · PORTED
(methods config) tests/protocol.test.ts · protocol-cell: multiple actions each
get unique types · PORTED (multiple methods each get unique types)
tests/protocol.test.ts · bridge: (all 4) · KEPT (bridge channel catalog —
protocol wire surface, not Style-B user config) tests/protocol.test.ts · aio
stub: middleware.logger returns noop function · DELETED (machinery: middleware
surface removed) tests/protocol.test.ts · aio stub: run returns resolved promise
· KEPT tests/protocol.test.ts · matchPath: (all 15) · KEPT (router, unrelated)
tests/error-flow.test.ts · (all) · DELETED (machinery: generator flow error
protocol — flows removed) tests/factory.test.ts · (all) · DELETED (machinery:
actions()/effects() catalog factory — factory.ts removed)
tests/middleware.test.ts · (all) · DELETED (machinery: composeMiddleware chains
— middleware removed; real uses are built-ins) tests/machine-fn-targets.test.ts
· (all) · DELETED (machinery: machine transition internals — file removed by
batch B) tests/headless-import.test.ts · export assertions · PORTED (dropped
actions/effects/composeMiddleware asserts)
