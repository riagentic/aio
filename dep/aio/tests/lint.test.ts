import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { lint } from '../src/aio.ts'
import { join } from '@std/path'

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  try { await fn(dir) } finally { await Deno.remove(dir, { recursive: true }) }
}

Deno.test('lint: passes with valid state + config + App.tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() { return <div/> }')
    const r = await lint({ count: 0 }, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.fail.length, 0)
    assertEquals(r.ok.includes('App.tsx'), true)
    assertEquals(r.ok.includes('reduce'), true)
  })
})

Deno.test('lint: fails on null state', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    const r = await lint(null, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.fail.some(f => f.includes('null')), true)
  })
})

Deno.test('lint: fails when reduce is not a function', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    const r = await lint({}, { reduce: 'nope', execute: () => {} }, dir)
    assertEquals(r.fail.some(f => f.includes('reduce')), true)
  })
})

Deno.test('lint: warns when App.tsx missing export default', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'function App() {}')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('export default')), true)
  })
})

Deno.test('lint: hints on createRoot in App.tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() { createRoot() }')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('createRoot')), true)
  })
})

Deno.test('lint: hints on import React in App.tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import React from 'react'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('import React')), true)
  })
})

Deno.test('lint: fails when App.tsx missing', async () => {
  await withTmpDir(async (dir) => {
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.fail.some(f => f.includes('App.tsx not found')), true)
  })
})

Deno.test('lint: prod mode skips App.tsx check', async () => {
  await withTmpDir(async (dir) => {
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir, true)
    assertEquals(r.fail.length, 0)
    assertEquals(r.ok.includes('prod'), true)
  })
})

Deno.test('lint: hints on old dep/aio import paths', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'actions.ts'), "import { msg } from '../dep/aio/mod.ts'")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes("import from 'aio'")), true)
  })
})

Deno.test('lint: warns on $p/$d reserved state keys', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    const r = await lint({ $p: 'bad', count: 0 }, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('$p')), true)
  })
})

Deno.test('lint: hints on execute param order (first param named app)', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'execute.ts'), 'export function execute(app, effect) {}')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('execute(effect, app)')), true)
  })
})

Deno.test('lint: no hint when execute param order is correct', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'execute.ts'), 'export function execute(effect, app) {}')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('execute(effect, app)')), false)
  })
})
