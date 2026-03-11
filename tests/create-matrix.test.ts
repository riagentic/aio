// create-matrix.test.ts — verify template matrix: descriptions, file counts, types, stripping
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { _test } from '../utils/create.ts'

const {
  APP_TYPES, getTemplates, getCliTemplates, applyAppType, clientOnlyFiles, denoJson,
  templateEmpty, templateMinimal, templateMedium, templateLarge,
} = _test

// ── Dynamic descriptions ──

Deno.test('getTemplates: UI types show correct file counts', () => {
  const ui = APP_TYPES.find(t => t.id === 'browser')!
  const tpls = getTemplates(ui)
  assert(tpls[0].desc.includes('2 files'))
  assert(tpls[1].desc.includes('7 files'))
})

Deno.test('getTemplates: headless types show correct file counts', () => {
  const hl = APP_TYPES.find(t => t.id === 'cli')!
  const tpls = getTemplates(hl)
  assert(tpls[0].desc.includes('1 file'))
  assert(tpls[1].desc.includes('6 files'))
})

// ── CLI templates ──

Deno.test('CLI templates: correct file counts (1, 3, 5, 7)', () => {
  const tpls = getCliTemplates()
  const counts = tpls.map(t => Object.keys(t.fn('T')).length)
  assertEquals(counts, [1, 3, 5, 7])
})

Deno.test('CLI templates: all have src/client.ts', () => {
  for (const t of getCliTemplates()) {
    assert('src/client.ts' in t.fn('T'), `${t.label} missing src/client.ts`)
  }
})

Deno.test('CLI templates: state types match server templates', () => {
  const tpls = getCliTemplates()
  // Empty: { count: number }
  assert(tpls[0].fn('T')['src/client.ts'].includes('count: number'))
  // Minimal: { counter: number }
  assert(tpls[1].fn('T')['src/state.ts'].includes('counter: number'))
  // Medium: todo + TodoItem
  const medState = tpls[2].fn('T')['src/state.ts']
  assert(medState.includes('todo:') && medState.includes('TodoItem'))
  // Large: TodoState + UserState
  const lgState = tpls[3].fn('T')['src/state.ts']
  assert(lgState.includes('TodoState') && lgState.includes('UserState'))
})

// ── Headless stripping ──

Deno.test('applyAppType: strips .tsx for headless types', () => {
  const hl = APP_TYPES.find(t => t.id === 'cli')!
  for (const fn of [templateEmpty, templateMinimal, templateMedium, templateLarge]) {
    const files = applyAppType(fn('T'), hl, 'T')
    const tsx = Object.keys(files).filter(f => f.endsWith('.tsx'))
    assertEquals(tsx, [], `has .tsx files: ${tsx}`)
  }
})

Deno.test('applyAppType: injects headless: true for cli/service/remote-service', () => {
  for (const id of ['cli', 'service', 'remote-service']) {
    const t = APP_TYPES.find(a => a.id === id)!
    const files = applyAppType(templateEmpty('T'), t, 'T')
    assert(files['src/app.ts'].includes('headless: true'), `${id} missing headless: true`)
  }
})

Deno.test('applyAppType: remote server types have auth hint', () => {
  for (const id of ['remote-browser', 'remote-service']) {
    const t = APP_TYPES.find(a => a.id === id)!
    const files = applyAppType(templateEmpty('T'), t, 'T')
    assert(files['src/app.ts'].includes('users:'), `${id} missing auth hint`)
  }
})

// ── deno.json ──

Deno.test('denoJson: remote-cli has dev task running client.ts', () => {
  const t = APP_TYPES.find(a => a.id === 'remote-cli')!
  const json = JSON.parse(denoJson('T', t))
  assert(json.tasks.dev?.includes('client.ts'), 'dev task should run client.ts')
})

Deno.test('denoJson: remote-electron dev uses --url', () => {
  const t = APP_TYPES.find(a => a.id === 'remote-electron')!
  const json = JSON.parse(denoJson('T', t))
  assert(json.tasks.dev?.includes('--url'), 'dev task should use --url')
})

Deno.test('denoJson: remote-android dev uses --no-electron', () => {
  const t = APP_TYPES.find(a => a.id === 'remote-android')!
  const json = JSON.parse(denoJson('T', t))
  assert(json.tasks.dev?.includes('--no-electron'), 'dev task should use --no-electron')
})

// ── clientOnlyFiles ──

Deno.test('clientOnlyFiles: remote-electron produces app.ts with aio.run', () => {
  const t = APP_TYPES.find(a => a.id === 'remote-electron')!
  const files = clientOnlyFiles(t, 'T')
  assert('src/app.ts' in files)
  assert(files['src/app.ts'].includes('aio.run'))
})

Deno.test('clientOnlyFiles: remote-android produces app.ts + App.tsx', () => {
  const t = APP_TYPES.find(a => a.id === 'remote-android')!
  const files = clientOnlyFiles(t, 'T')
  assert('src/app.ts' in files)
  assert('src/App.tsx' in files)
})
