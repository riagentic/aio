import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  createTT, record, undo, redo, travelTo,
  pause, resume, stateAt, toBroadcast, parseTTCommand,
  type TTState,
} from '../src/time-travel.ts'
import { createServer } from '../src/server.ts'
import { join } from '@std/path'

type S = { count: number }
type A = { type: string }

function makeTT(): TTState<S, A> {
  let tt = createTT<S, A>()
  tt = record(tt, { type: '__init' }, { count: 0 })
  return tt
}

// ── Pure function tests ──────────────────────────────────────────

Deno.test('tt: createTT returns empty state', () => {
  const tt = createTT<S, A>()
  assertEquals(tt.entries, [])
  assertEquals(tt.index, -1)
  assertEquals(tt.paused, false)
  assertEquals(tt.nextId, 0)
})

Deno.test('tt: record appends entry and increments id', () => {
  let tt = createTT<S, A>()
  tt = record(tt, { type: 'A' }, { count: 1 })
  assertEquals(tt.entries.length, 1)
  assertEquals(tt.entries[0].id, 0)
  assertEquals(tt.entries[0].action, { type: 'A' })
  assertEquals(tt.entries[0].state, { count: 1 })
  assertEquals(tt.index, 0)
  assertEquals(tt.nextId, 1)

  tt = record(tt, { type: 'B' }, { count: 2 })
  assertEquals(tt.entries.length, 2)
  assertEquals(tt.entries[1].id, 1)
  assertEquals(tt.index, 1)
  assertEquals(tt.nextId, 2)
})

Deno.test('tt: record caps at 200, evicts oldest', () => {
  let tt = createTT<S, A>()
  for (let i = 0; i < 210; i++) {
    tt = record(tt, { type: `A${i}` }, { count: i })
  }
  assertEquals(tt.entries.length, 200)
  // First entry should be id 10 (0-9 evicted)
  assertEquals(tt.entries[0].id, 10)
  assertEquals(tt.entries[tt.entries.length - 1].id, 209)
  assertEquals(tt.index, 199)
})

Deno.test('tt: record after undo truncates forward entries', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = record(tt, { type: 'B' }, { count: 2 })
  assertEquals(tt.entries.length, 3)

  tt = undo(tt) // index 1
  tt = record(tt, { type: 'C' }, { count: 10 })
  assertEquals(tt.entries.length, 3)  // __init, A, C (B truncated)
  assertEquals(tt.entries[2].action, { type: 'C' })
  assertEquals(tt.index, 2)
})

Deno.test('tt: undo decrements index and pauses', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = undo(tt)
  assertEquals(tt.index, 0)
  assertEquals(tt.paused, true)
})

Deno.test('tt: undo at index 0 is no-op', () => {
  const tt = makeTT()
  const after = undo(tt)
  assertEquals(after, tt)  // same reference — no-op
})

Deno.test('tt: redo increments index, stays paused', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = undo(tt)
  assertEquals(tt.paused, true)
  tt = redo(tt)
  assertEquals(tt.index, 1)
  assertEquals(tt.paused, true) // stays paused
})

Deno.test('tt: redo at end is no-op', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  const after = redo(tt)
  assertEquals(after, tt) // same reference
})

Deno.test('tt: travelTo by id, auto-pauses', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = record(tt, { type: 'B' }, { count: 2 })
  tt = record(tt, { type: 'C' }, { count: 3 })

  tt = travelTo(tt, 1) // id=1 → second entry (action A)
  assertEquals(tt.index, 1)
  assertEquals(tt.paused, true)
  assertEquals(stateAt(tt), { count: 1 })
})

Deno.test('tt: travelTo invalid id is no-op', () => {
  const tt = makeTT()
  const after = travelTo(tt, 999)
  assertEquals(after, tt)
})

Deno.test('tt: pause / resume toggle', () => {
  let tt = makeTT()
  assertEquals(tt.paused, false)

  tt = pause(tt)
  assertEquals(tt.paused, true)

  tt = resume(tt)
  assertEquals(tt.paused, false)
})

Deno.test('tt: resume truncates forward entries', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = record(tt, { type: 'B' }, { count: 2 })
  tt = record(tt, { type: 'C' }, { count: 3 })

  tt = travelTo(tt, 1) // back to index 1, paused
  assertEquals(tt.entries.length, 4) // all still there
  tt = resume(tt)
  assertEquals(tt.entries.length, 2) // __init + A (B, C truncated)
  assertEquals(tt.paused, false)
})

Deno.test('tt: stateAt returns correct state', () => {
  let tt = createTT<S, A>()
  assertEquals(stateAt(tt), null)

  tt = record(tt, { type: '__init' }, { count: 0 })
  assertEquals(stateAt(tt), { count: 0 })

  tt = record(tt, { type: 'A' }, { count: 42 })
  assertEquals(stateAt(tt), { count: 42 })

  tt = undo(tt)
  assertEquals(stateAt(tt), { count: 0 })
})

Deno.test('tt: toBroadcast omits state, includes action type', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'Inc' }, { count: 1 })
  tt = record(tt, { type: 'Dec' }, { count: 0 })

  const b = toBroadcast(tt)
  assertEquals(b.index, 2)
  assertEquals(b.paused, false)
  assertEquals(b.entries.length, 3)
  assertEquals(b.entries[0].type, '__init')
  assertEquals(b.entries[1].type, 'Inc')
  assertEquals(b.entries[2].type, 'Dec')
  // No state in broadcast
  for (const e of b.entries) {
    assertEquals((e as Record<string, unknown>).state, undefined)
  }
})

Deno.test('tt: parseTTCommand parses all commands', () => {
  assertEquals(parseTTCommand('__tt:undo'), { cmd: 'undo' })
  assertEquals(parseTTCommand('__tt:redo'), { cmd: 'redo' })
  assertEquals(parseTTCommand('__tt:pause'), { cmd: 'pause' })
  assertEquals(parseTTCommand('__tt:resume'), { cmd: 'resume' })
  assertEquals(parseTTCommand('__tt:goto:5'), { cmd: 'goto', arg: 5 })
  assertEquals(parseTTCommand('__tt:goto:0'), { cmd: 'goto', arg: 0 })
})

Deno.test('tt: parseTTCommand rejects garbage', () => {
  assertEquals(parseTTCommand('hello'), null)
  assertEquals(parseTTCommand('__tt:'), null)
  assertEquals(parseTTCommand('__tt:fly'), null)
  assertEquals(parseTTCommand('__tt:goto:'), null)
  assertEquals(parseTTCommand('__tt:goto:-1'), null)
  assertEquals(parseTTCommand('__tt:goto:abc'), null)
  assertEquals(parseTTCommand(''), null)
})

// ── Integration tests ────────────────────────────────────────────

const TT_PORT = 19840

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

Deno.test('tt integration: TT commands via WS protocol', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let state = { count: 0 }
  const ttCommands: string[] = []

  const server = createServer({
    port: TT_PORT,
    title: 'TTTest',
    getUIState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string; payload?: { by?: number } }
      if (a.type === 'INC') {
        state = { count: state.count + (a.payload?.by ?? 1) }
        server.broadcast()
      }
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    onTTCommand: (cmd, arg) => { ttCommands.push(arg !== undefined ? `${cmd}:${arg}` : cmd) },
    getTTBroadcast: () => ({ entries: [], index: 0, paused: false }),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${TT_PORT}/ws`)
    const received: string[] = []
    ws.addEventListener('message', (e) => { if (!(e.data as string).startsWith('__boot:')) received.push(e.data as string) })
    await new Promise<void>(r => { ws.onopen = () => r() })
    await waitFor(() => received.length >= 1) // initial state

    // Should receive TT metadata on connect
    await waitFor(() => received.some(m => m.startsWith('__tt:')))
    const ttMsg = received.find(m => m.startsWith('__tt:'))!
    const ttData = JSON.parse(ttMsg.slice(5))
    assertEquals(ttData.paused, false)

    // Send TT commands
    ws.send('__tt:undo')
    ws.send('__tt:redo')
    ws.send('__tt:goto:3')
    ws.send('__tt:pause')
    ws.send('__tt:resume')

    await waitFor(() => ttCommands.length >= 5)
    assertEquals(ttCommands, ['undo', 'redo', 'goto:3', 'pause', 'resume'])

    // Regular action should still work
    ws.send(JSON.stringify({ type: 'INC', payload: { by: 5 } }))
    await waitFor(() => state.count === 5)

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('tt integration: paused dispatch drops actions', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = undo(tt) // pauses

  assertEquals(tt.paused, true)
  // Simulating what aio.ts does: check paused before reducing
  const shouldSkip = tt.paused
  assertEquals(shouldSkip, true)
  // State stays at index 0
  assertEquals(stateAt(tt), { count: 0 })
})

Deno.test('tt integration: state restores correctly on undo/redo cycle', () => {
  let tt = makeTT()
  tt = record(tt, { type: 'A' }, { count: 1 })
  tt = record(tt, { type: 'B' }, { count: 2 })
  tt = record(tt, { type: 'C' }, { count: 3 })

  assertEquals(stateAt(tt), { count: 3 })

  // Undo all the way back
  tt = undo(tt); assertEquals(stateAt(tt), { count: 2 })
  tt = undo(tt); assertEquals(stateAt(tt), { count: 1 })
  tt = undo(tt); assertEquals(stateAt(tt), { count: 0 })

  // Redo forward
  tt = redo(tt); assertEquals(stateAt(tt), { count: 1 })
  tt = redo(tt); assertEquals(stateAt(tt), { count: 2 })
  tt = redo(tt); assertEquals(stateAt(tt), { count: 3 })

  // Jump to specific entry
  tt = travelTo(tt, 1) // __init=0, A=1
  assertEquals(stateAt(tt), { count: 1 })
})

Deno.test('tt integration: resume then record branches correctly', () => {
  let tt = makeTT()                                    // [__init:0]
  tt = record(tt, { type: 'A' }, { count: 1 })        // [__init, A]
  tt = record(tt, { type: 'B' }, { count: 2 })        // [__init, A, B]
  tt = record(tt, { type: 'C' }, { count: 3 })        // [__init, A, B, C]

  tt = travelTo(tt, 1) // go to A (index 1), paused
  assertEquals(tt.paused, true)
  assertEquals(tt.entries.length, 4) // all still exist

  tt = resume(tt) // truncate forward
  assertEquals(tt.entries.length, 2) // [__init, A]
  assertEquals(tt.paused, false)

  // New branch
  tt = record(tt, { type: 'D' }, { count: 10 })
  assertEquals(tt.entries.length, 3) // [__init, A, D]
  assertEquals(stateAt(tt), { count: 10 })
  assertEquals(tt.entries[2].action, { type: 'D' })
})
