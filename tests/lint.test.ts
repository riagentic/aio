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

Deno.test('lint: warns on $p/$d reserved state keys with rename suggestion', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    const r = await lint({ $p: 'bad', count: 0 }, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('$p')), true)
    assertEquals(r.warn.some(w => w.includes('rename')), true)
  })
})

Deno.test('lint: App.tsx error shows exact filepath', async () => {
  await withTmpDir(async (dir) => {
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.fail.some(f => f.includes(join(dir, 'App.tsx'))), true)
  })
})

Deno.test('lint: hints on execute param order (first param named effect)', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'execute.ts'), 'export function execute(effect, app) {}')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('execute(app, effect)')), true)
  })
})

Deno.test('lint: no hint when execute param order is correct', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'execute.ts'), 'export function execute(app, effect) {}')
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.hint.some(h => h.includes('execute(app, effect)')), false)
  })
})

Deno.test('lint: warns on npm import in .tsx that won\'t work in browser', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import { marked } from 'marked'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('"marked"') && w.includes('won\'t work in browser')), true)
  })
})

Deno.test('lint: no warn for react/aio imports in .tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import { useAio } from 'aio'\nimport { useState } from 'react'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('won\'t work in browser')), false)
  })
})

Deno.test('lint: no warn for relative imports in .tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import { helper } from './utils.ts'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('won\'t work in browser')), false)
  })
})

Deno.test('lint: no warn for npm imports in .ts files (server-side)', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default function App() {}')
    await Deno.writeTextFile(join(dir, 'execute.ts'), "import { Database } from 'sqlite3'")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('won\'t work in browser')), false)
  })
})

Deno.test('lint: warns on multiple unmapped imports in .tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import { marked } from 'marked'\nimport hljs from 'highlight.js'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    const browserWarns = r.warn.filter(w => w.includes('won\'t work in browser'))
    assertEquals(browserWarns.length, 2)
  })
})

Deno.test('lint: no warn for import type in .tsx (erased by TS)', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import type { Options } from 'marked'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('won\'t work in browser')), false)
  })
})

Deno.test('lint: warns on bare side-effect import in .tsx', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import 'some-polyfill'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir)
    assertEquals(r.warn.some(w => w.includes('"some-polyfill"') && w.includes('won\'t work in browser')), true)
  })
})

Deno.test('lint: browser import check skipped in prod mode', async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, 'App.tsx'), "import { marked } from 'marked'\nexport default function App() {}")
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir, true)
    assertEquals(r.warn.some(w => w.includes('won\'t work in browser')), false)
  })
})
