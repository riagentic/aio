import { assertEquals, assertThrows } from '@std/assert'
import { validateMachine } from '../src/feature-machine.ts'

// ── helpers ─────────────────────────────────────────────────────────

const keys = (...names: string[]): Set<string> => new Set(names)
const throwMsg = (fn: () => void): string => (assertThrows(fn) as Error).message

// ── valid machines ──────────────────────────────────────────────────

Deno.test('valid: simple 2-state machine', () => {
  validateMachine('toggle', {
    initial: 'off',
    states: {
      off: { flip: 'on' },
      on:  { flip: 'off' },
    },
  }, keys('flip'))
})

Deno.test('valid: 3-state cycle', () => {
  validateMachine('traffic', {
    initial: 'green',
    states: {
      green:  { next: 'yellow' },
      yellow: { next: 'red' },
      red:    { next: 'green' },
    },
  }, keys('next'))
})

Deno.test('valid: complex multi-state with branching', () => {
  validateMachine('order', {
    initial: 'draft',
    states: {
      draft:     { submit: 'review' },
      review:    { approve: 'approved', reject: 'draft' },
      approved:  { ship: 'shipped', cancel: 'cancelled' },
      shipped:   { deliver: 'delivered' },
      delivered: { archive: 'archived' },
      cancelled: { reopen: 'draft' },
      archived:  { reopen: 'draft' },
    },
  }, keys('submit', 'approve', 'reject', 'ship', 'cancel', 'deliver', 'archive', 'reopen'))
})

// ── initial state validation ────────────────────────────────────────

Deno.test('throws: initial state not in declared states', () => {
  const m = throwMsg(() =>
    validateMachine('bad', {
      initial: 'missing',
      states: { idle: { go: 'idle' } },
    }, keys('go'))
  )
  assertEquals(m.includes("machine.initial 'missing' not in declared states"), true)
})

// ── unknown target ──────────────────────────────────────────────────

Deno.test('throws: transition to undeclared state', () => {
  const m = throwMsg(() =>
    validateMachine('nav', {
      initial: 'a',
      states: { a: { go: 'nowhere' } },
    }, keys('go'))
  )
  assertEquals(m.includes("unknown target 'nowhere'"), true)
})

// ── unknown action ──────────────────────────────────────────────────

Deno.test('throws: action key not in actionKeys', () => {
  const m = throwMsg(() =>
    validateMachine('x', {
      initial: 'a',
      states: {
        a: { bogus: 'b' },
        b: { back: 'a' },
      },
    }, keys('back'))
  )
  assertEquals(m.includes("references unknown action 'bogus'"), true)
})

// ── foreign actions (key contains ':') ──────────────────────────────

Deno.test('valid: foreign action with colon skips actionKeys check', () => {
  validateMachine('listener', {
    initial: 'idle',
    states: {
      idle:    { 'other:done': 'active' },
      active:  { reset: 'idle' },
    },
  }, keys('reset'))
})

// ── unreachable states ──────────────────────────────────────────────

Deno.test('throws: unreachable state from initial', () => {
  const m = throwMsg(() =>
    validateMachine('island', {
      initial: 'a',
      states: {
        a: { go: 'b' },
        b: { back: 'a' },
        c: { go: 'a' },
      },
    }, keys('go', 'back'))
  )
  assertEquals(m.includes("state 'c' unreachable from 'a'"), true)
})

Deno.test('throws: multiple unreachable states', () => {
  const m = throwMsg(() =>
    validateMachine('split', {
      initial: 'a',
      states: {
        a: { next: 'a' },
        b: { next: 'c' },
        c: { next: 'b' },
      },
    }, keys('next'))
  )
  assertEquals(m.includes("state 'b' unreachable"), true)
  assertEquals(m.includes("state 'c' unreachable"), true)
})

// ── dead-end detection (warns, does NOT throw) ──────────────────────

Deno.test('warns but does not throw: dead-end state', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  try {
    validateMachine('sink', {
      initial: 'a',
      states: {
        a: { go: 'b' },
        b: {},
      },
    }, keys('go'))
  } finally {
    console.warn = origWarn
  }
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]!.includes("state 'b' is a dead-end"), true)
})

Deno.test('no warning for states with transitions', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  try {
    validateMachine('loop', {
      initial: 'a',
      states: {
        a: { go: 'b' },
        b: { back: 'a' },
      },
    }, keys('go', 'back'))
  } finally {
    console.warn = origWarn
  }
  assertEquals(warnings.length, 0)
})

// ── multiple errors collected ───────────────────────────────────────

Deno.test('throws: multiple errors collected in single throw', () => {
  const m = throwMsg(() =>
    validateMachine('chaos', {
      initial: 'nope',
      states: {
        a: { bad: 'ghost' },
        b: { also_bad: 'phantom' },
      },
    }, keys())
  )
  assertEquals(m.includes("machine.initial 'nope' not in declared states"), true)
  assertEquals(m.includes("unknown target 'ghost'"), true)
  assertEquals(m.includes("unknown target 'phantom'"), true)
  assertEquals(m.includes("references unknown action 'bad'"), true)
  assertEquals(m.includes("references unknown action 'also_bad'"), true)
  assertEquals(m.includes("unreachable"), true)
})

// ── error message format ────────────────────────────────────────────

Deno.test('error message: starts with [feature:name] and joins with newlines', () => {
  const m = throwMsg(() =>
    validateMachine('myFeat', {
      initial: 'missing',
      states: { a: { go: 'a' } },
    }, keys('go'))
  )
  assertEquals(m.startsWith('[feature:myFeat]'), true)
  assertEquals(m.includes('machine validation failed:'), true)
  assertEquals(m.includes('\n  '), true)
})

Deno.test('error message: feature name is preserved in prefix', () => {
  const m = throwMsg(() =>
    validateMachine('some-long-name', {
      initial: 'x',
      states: { a: { go: 'a' } },
    }, keys('go'))
  )
  assertEquals(m.startsWith('[feature:some-long-name]'), true)
})
