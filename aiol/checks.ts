// aiol — all lint checks organized by area

import type { Checker, FeatureInfo } from './types.ts'
import { join } from '@std/path'
import * as fix from './fixes.ts'
import { RESERVED_KEYS } from '../src/feature-types.ts'

// ══════════════════════════════════════════════════════════════════════
// 1. PROJECT CONFIG (deno.json)
// ══════════════════════════════════════════════════════════════════════

export const checkConfig: Checker = (ctx) => {
  const { denoJson: dj, report, pass } = ctx
  if (!dj) {
    report('error', 'config', 'deno.json not found — create one with appId, imports, and tasks', { fix: 'See quickstart.md' })
    return
  }

  // appId
  if (!dj.appId) report('warn', 'config', 'missing "appId" in deno.json — used for lock files, KV path, socket path', { fix: 'Add "appId": "my-app"', safeFix: fix.fixAddAppId })
  else if (!/^[\w-]+$/.test(dj.appId)) report('warn', 'config', `appId "${dj.appId}" has special characters — use alphanumeric + hyphens only`)
  else pass(`appId: ${dj.appId}`)

  // unstable: ["kv"]
  if (!dj.unstable?.includes('kv')) report('warn', 'config', 'missing "unstable": ["kv"] — required for state persistence', { fix: 'Add "unstable": ["kv"]', safeFix: fix.fixAddUnstableKv })

  // imports
  const imports = dj.imports ?? {}
  if (!imports['aio'] && !imports['@riagentic/aio']) report('error', 'config', 'missing "aio" import mapping — add "aio": "jsr:@riagentic/aio@..."')
  if (!imports['react'] && !imports['react-dom']) pass('headless (no React)')
  else {
    if (!imports['react']) report('warn', 'config', 'missing "react" import')
    if (!imports['@types/react']) report('hint', 'config', 'missing "@types/react" — add for JSX type checking', { safeFix: fix.fixAddTypesReact })
    if (!imports['esbuild']) report('warn', 'config', 'missing "esbuild" import — required for dev mode TSX transpilation', { safeFix: fix.fixAddEsbuild })
  }

  // compilerOptions for JSX
  const co = dj.compilerOptions ?? {}
  if (imports['react'] && co['jsx'] !== 'react-jsx') {
    report('hint', 'config', 'compilerOptions.jsx should be "react-jsx" for automatic JSX transform', { safeFix: fix.fixAddJsxConfig })
  }

  // nodeModulesDir
  if (!dj.nodeModulesDir) report('hint', 'config', 'missing "nodeModulesDir": "auto" — recommended for npm package resolution', { safeFix: fix.fixAddNodeModulesDir })

  // tasks
  const tasks = dj.tasks ?? {}
  if (!tasks['dev']) report('hint', 'config', 'no "dev" task — add "dev": "deno run -A src/app.ts"', { safeFix: fix.fixAddDevTask })
  if (!tasks['test']) report('hint', 'config', 'no "test" task — add "test": "deno test -A --unstable-kv tests/"', { safeFix: fix.fixAddTestTask })
  const compileTargets = Object.keys(tasks).filter(k => k.startsWith('compile:'))
  if (compileTargets.length) pass(`compile targets: ${compileTargets.join(', ')}`)
  else report('hint', 'config', 'no compile tasks defined — add compile:browser, compile:electron, etc. for production builds')
}

// ══════════════════════════════════════════════════════════════════════
// 2. FILE STRUCTURE
// ══════════════════════════════════════════════════════════════════════

export const checkStructure: Checker = async (ctx) => {
  const { projectDir, appEntry, appTsx, sourceFiles, report, pass, denoJson } = ctx
  const isHeadless = appEntry?.content.includes('headless') ?? false
  const tasks = denoJson?.tasks ?? {}
  const devTask = tasks['dev'] ?? ''
  const headlessFromTask = devTask.includes('--headless')

  // app.ts entry point
  if (appEntry) pass('entry: src/app.ts')
  else {
    // Check for common alternatives
    const altEntry = sourceFiles.find(f => f.relative === 'src/main.ts' || f.relative === 'main.ts')
    if (altEntry) report('hint', 'structure', `entry point is "${altEntry.relative}" — convention is "src/app.ts"`, { file: altEntry.relative })
    else report('warn', 'structure', 'no entry point found (src/app.ts) — create one with aio.run()')
  }

  // App.tsx
  if (!isHeadless && !headlessFromTask) {
    if (appTsx) {
      pass('UI: App.tsx')
      if (!appTsx.content.includes('export default')) {
        report('warn', 'structure', 'App.tsx missing `export default` — framework can\'t mount your component', { file: appTsx.relative })
      }
    } else {
      report('hint', 'structure', 'no App.tsx found — needed for browser/Electron UI (skip if headless)')
    }
  } else {
    if (appTsx) report('hint', 'structure', 'App.tsx exists but app runs headless — file is unused', { file: appTsx.relative })
    else pass('headless mode (no App.tsx)')
  }

  // Feature organization
  const featureFiles = sourceFiles.filter(f =>
    f.content.includes('feature(') && !f.name.endsWith('.test.ts') && f.name !== 'app.ts'
  )
  if (featureFiles.length > 3) {
    const inFeatureDir = featureFiles.filter(f => f.relative.includes('features/'))
    if (inFeatureDir.length < featureFiles.length / 2) {
      report('hint', 'structure', `${featureFiles.length} feature files scattered — consider organizing in src/features/`, { fix: 'See structure.md' })
    }
  }

  // Check for test directory
  const testsDir = join(projectDir, 'tests')
  const srcTests = sourceFiles.filter(f => f.name.endsWith('.test.ts'))
  try {
    await Deno.stat(testsDir)
  } catch {
    if (srcTests.length === 0) report('hint', 'structure', 'no tests/ directory and no .test.ts files found')
  }

  // appVersion
  if (appEntry) {
    if (appEntry.content.includes('appVersion')) pass('appVersion set')
    else report('warn', 'config', 'no appVersion in aio.run() — defaults to "0.1.0 (default)", set appVersion: "x.y.z"', { file: appEntry.relative })
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. FEATURE DEFINITIONS
// ══════════════════════════════════════════════════════════════════════

export const checkFeatures: Checker = (ctx) => {
  const { features, report, pass } = ctx

  if (features.length === 0) {
    report('hint', 'features', 'no feature() calls found — is this a legacy (reduce/execute) app?')
    return
  }

  pass(`${features.length} feature(s): ${features.map(f => f.name).join(', ')}`)

  // Duplicate names
  const names = new Map<string, FeatureInfo[]>()
  for (const f of features) {
    const list = names.get(f.name) ?? []
    list.push(f)
    names.set(f.name, list)
  }
  for (const [name, list] of names) {
    if (list.length > 1) {
      report('error', 'features', `duplicate feature name "${name}" — found in ${list.map(f => f.file.relative).join(', ')}`)
    }
  }

  for (const f of features) {
    const loc = { file: f.file.relative, line: f.line }

    // Empty state
    if (!f.hasState) report('warn', 'features', `feature "${f.name}" has no state — every feature needs initial state`, loc)
    else if (f.stateKeys.length === 0) report('warn', 'features', `feature "${f.name}" has empty state object {}`, loc)

    // No methods and no actions
    if (!f.hasMethods && !f.hasActions) {
      report('warn', 'features', `feature "${f.name}" has no methods and no actions — it can't change state`, loc)
    }

    // Both methods and actions (mixing styles)
    if (f.hasMethods && f.hasActions) {
      report('warn', 'features', `feature "${f.name}" has both methods and actions — pick one style`, loc)
    }

    // Reserved state keys
    const reserved = ['$p', '$d', '__proto__', 'constructor', 'prototype']
    for (const key of f.stateKeys) {
      if (reserved.includes(key)) {
        report('error', 'features', `feature "${f.name}" state has reserved key "${key}" — will cause data corruption`, loc)
      }
      if (key === '_status') {
        report('warn', 'features', `feature "${f.name}" state has "_status" key — this is managed by aio for machine state, will be overwritten`, loc)
      }
    }

    // Reserved key collisions — methods, actions, generators using reserved FeatureDef property names
    const allUserKeys = [...f.methodNames, ...f.actionNames]
    for (const key of allUserKeys) {
      if (RESERVED_KEYS.has(key)) {
        report('error', 'features', `feature "${f.name}" has ${f.hasMethods ? 'method' : 'action'} "${key}" — collides with reserved property. Reserved: ${[...RESERVED_KEYS].join(', ')}`, loc)
      }
    }

    // Feature name conventions
    if (!/^[a-z][\w-]*$/.test(f.name)) {
      report('hint', 'features', `feature "${f.name}" — convention is lowercase with hyphens (e.g., "user-profile")`, loc)
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. STATE & PERFORMANCE
// ══════════════════════════════════════════════════════════════════════

export const checkPerformance: Checker = (ctx) => {
  const { sourceFiles, features, appEntry, report, pass } = ctx

  // Check for useAio vs useFeature in TSX files
  for (const file of ctx.tsxFiles) {
    if (file.name === 'App.tsx') continue // root layout — useAio is OK
    const useAioCount = (file.content.match(/\buseAio\b/g) ?? []).length
    const useFeatureCount = (file.content.match(/\buseFeature\b/g) ?? []).length
    if (useAioCount > 0 && useFeatureCount === 0) {
      report('warn', 'perf', `${file.relative}: uses useAio() — prefer useFeature(ref) for scoped state + selective re-renders`, { file: file.relative, fix: 'Replace useAio() with useFeature(myFeature)' })
    }
  }

  // Check for sync I/O in source (outside test files)
  const syncApis = ['Deno.readTextFileSync', 'Deno.readDirSync', 'Deno.writeTextFileSync', 'Deno.statSync', 'Deno.removeSync', 'Deno.mkdirSync']
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts')) continue
    for (const api of syncApis) {
      if (file.content.includes(api)) {
        // Find line number
        const lineIdx = file.lines.findIndex(l => l.includes(api))
        report('warn', 'perf', `${file.relative}: sync I/O (${api}) blocks the event loop — use async version`, { file: file.relative, line: lineIdx + 1 })
      }
    }
  }

  // Check for setTimeout/setInterval in feature files (should use schedule)
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts') || file.name === 'app.ts') continue
    if (!file.content.includes('feature(')) continue
    if (file.content.includes('setTimeout') || file.content.includes('setInterval')) {
      report('hint', 'perf', `${file.relative}: setTimeout/setInterval in feature code — use schedule.after/every for observable, cancellable timers`, { file: file.relative })
    }
  }

  // Large state arrays — hint about SQLite
  for (const f of features) {
    for (const key of f.stateKeys) {
      // Check if state value looks like an array initializer with many items
      const arrayMatch = f.file.content.match(new RegExp(`${key}\\s*:\\s*\\[`))
      if (arrayMatch) {
        // Check for 'as' type annotation suggesting typed array
        const afterKey = f.file.content.slice(f.file.content.indexOf(arrayMatch[0]))
        if (/\[\s*\]\s+as\s+\w+\[\]/.test(afterKey)) {
          // Empty typed array — check if it's a list that could grow
          // Only hint for names that suggest collections
          if (/items|orders|entries|logs|messages|events|users|records|rows|list/i.test(key)) {
            report('hint', 'perf', `feature "${f.name}" state.${key} is a typed array — if it grows large (100+), consider SQLite`, { file: f.file.relative })
          }
        }
      }
    }
  }

  // Check for missing stateForUI
  if (appEntry && features.length > 0) {
    if (!appEntry.content.includes('stateForUI')) {
      const totalKeys = features.reduce((n, f) => n + f.stateKeys.length, 0)
      if (totalKeys > 10) {
        report('hint', 'perf', `${totalKeys} state keys across ${features.length} features — consider stateForUI to filter what's sent to browser`, { file: appEntry.relative })
      }
    } else {
      pass('stateForUI configured')
    }
  }

  // console.log in non-test source
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts')) continue
    const logLines = file.lines
      .map((l, i) => ({ line: l.trim(), num: i + 1 }))
      .filter(({ line }) => /\bconsole\.(log|dir|table)\b/.test(line) && !line.startsWith('//'))
    if (logLines.length > 0) {
      report('hint', 'perf', `${file.relative}: ${logLines.length} console.log call(s) — use log from 'aio' for structured logging`, { file: file.relative, line: logLines[0]!.num })
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 5. SECURITY
// ══════════════════════════════════════════════════════════════════════

export const checkSecurity: Checker = (ctx) => {
  const { sourceFiles, appEntry, report, pass } = ctx

  // Hardcoded tokens/secrets
  const secretPatterns = [
    { re: /token\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/, desc: 'hardcoded token' },
    { re: /password\s*[:=]\s*['"][^'"]{4,}['"]/, desc: 'hardcoded password' },
    { re: /secret\s*[:=]\s*['"][^'"]{8,}['"]/, desc: 'hardcoded secret' },
    { re: /api[_-]?key\s*[:=]\s*['"][^'"]{10,}['"]/i, desc: 'hardcoded API key' },
  ]
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts') || file.name.endsWith('.test.tsx')) continue
    for (const { re, desc } of secretPatterns) {
      const match = file.content.match(re)
      if (match) {
        const lineIdx = file.content.slice(0, match.index).split('\n').length
        report('warn', 'security', `${file.relative}:${lineIdx} — possible ${desc} — use environment variables instead`, { file: file.relative, line: lineIdx })
      }
    }
  }

  // --expose without auth
  if (appEntry) {
    const hasExpose = appEntry.content.includes('expose') || appEntry.content.includes('--expose')
    const hasUsers = appEntry.content.includes('users:') || appEntry.content.includes('users :')
    if (hasExpose && !hasUsers) {
      // Check if there's a token config
      if (!appEntry.content.includes('token')) {
        report('warn', 'security', 'app uses --expose without explicit user auth — auto-generated token will be printed to console but not persisted', { file: appEntry.relative })
      }
    }
    if (!hasExpose) pass('localhost-only (no --expose)')
  }

  // .env files committed
  try {
    Deno.statSync(join(ctx.projectDir, '.env'))
    report('warn', 'security', '.env file found — make sure it\'s in .gitignore')
  } catch { /* good — no .env */ }
}

// ══════════════════════════════════════════════════════════════════════
// 6. PERSISTENCE & DATABASE
// ══════════════════════════════════════════════════════════════════════

export const checkPersistence: Checker = (ctx) => {
  const { appEntry, sourceFiles, report, pass } = ctx

  if (!appEntry) return

  const hasDb = appEntry.content.includes('db:') || appEntry.content.includes('db :')
  const hasPersistFalse = /persist\s*:\s*false/.test(appEntry.content)

  if (hasDb) {
    pass('SQLite configured')
    // Check for table() imports
    const hasTableImport = sourceFiles.some(f => f.content.includes("from 'aio'") && f.content.includes('table'))
    if (!hasTableImport) report('hint', 'persistence', 'db config found but no table() schema definition — import { table, pk, text } from \'aio\'')
  }

  if (hasPersistFalse) {
    report('hint', 'persistence', 'persist: false — state won\'t survive restarts (OK for tests, not for production)', { file: appEntry.relative })
  }

  // Check for old version/migrations pattern (removed in v1.0 — use onRestore for state restructuring)
  if (/\bversion\s*:\s*\d+/.test(appEntry.content) && appEntry.content.includes('migrations')) {
    report('warn', 'persistence', 'version + migrations removed in v1.0 — use onRestore for state restructuring, deepMerge handles new fields automatically', { file: appEntry.relative })
  }

  // Direct Deno.Kv usage (should use aio persistence)
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts')) continue
    if (file.content.includes('Deno.openKv') || file.content.includes('Deno.Kv')) {
      report('hint', 'persistence', `${file.relative}: direct Deno.Kv usage — aio handles persistence automatically, use app.db for custom queries`, { file: file.relative })
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 7. UI / BROWSER
// ══════════════════════════════════════════════════════════════════════

export const checkUI: Checker = (ctx) => {
  const { tsxFiles, appTsx, report, pass } = ctx

  if (tsxFiles.length === 0) {
    pass('no TSX files (headless/CLI)')
    return
  }

  // Browser import safety
  const BROWSER_IMPORTS = new Set(['react', 'react-dom/client', 'react/jsx-runtime', 'aio', 'aio/browser'])
  for (const file of tsxFiles) {
    // Named/default imports
    for (const m of file.content.matchAll(/(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
      if (m[0]!.startsWith('import type ') || m[0]!.startsWith('import type{')) continue
      const lineIdx = file.content.slice(0, m.index).split('\n').length
      report('warn', 'ui', `${file.relative}:${lineIdx} — import "${spec}" won't resolve in browser dev mode`, { file: file.relative, line: lineIdx, fix: 'Move to a server-side .ts file or use via an effect' })
    }
    // Side-effect imports
    for (const m of file.content.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (spec.startsWith('.') || spec.startsWith('/') || BROWSER_IMPORTS.has(spec)) continue
      report('warn', 'ui', `${file.relative}: side-effect import "${spec}" won't resolve in browser`, { file: file.relative })
    }
  }

  // createRoot anti-pattern
  if (appTsx?.content.includes('createRoot')) {
    report('hint', 'ui', 'App.tsx uses createRoot — remove it, aio handles mounting', { file: appTsx.relative })
  }

  // import React (not needed)
  if (appTsx && /import\s+React[\s,{]/.test(appTsx.content)) {
    report('hint', 'ui', 'App.tsx imports React — not needed with jsx: "react-jsx" transform', { file: appTsx.relative, safeFix: fix.fixRemoveImportReact(appTsx.path) })
  }

  // useFeature without loading state
  for (const file of tsxFiles) {
    const useFeatureCalls = file.content.match(/useFeature\(/g)
    if (useFeatureCalls && !file.content.includes('fallback') && !file.content.includes('Loading') && !file.content.includes('Connecting')) {
      report('hint', 'ui', `${file.relative}: useFeature() without loading/fallback state — state is null until WS connects`, { file: file.relative, fix: 'Add: if (!state) return <div>Loading...</div>' })
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 8. TESTING
// ══════════════════════════════════════════════════════════════════════

export const checkTesting: Checker = (ctx) => {
  const { features, testFiles, report, pass, denoJson } = ctx

  if (features.length === 0) return

  // Check each feature has a test
  const testedFeatures = new Set<string>()
  for (const tf of testFiles) {
    for (const f of features) {
      if (tf.content.includes(`'${f.name}'`) || tf.content.includes(`"${f.name}"`) || tf.content.includes(f.name)) {
        testedFeatures.add(f.name)
      }
    }
  }

  const untestedFeatures = features.filter(f => !testedFeatures.has(f.name))
  if (untestedFeatures.length === 0) pass(`all ${features.length} features have tests`)
  else {
    for (const f of untestedFeatures) {
      report('hint', 'testing', `feature "${f.name}" has no test file — create ${f.name}.test.ts`, { file: f.file.relative })
    }
  }

  // testFeature usage
  const usesTestFeature = testFiles.some(f => f.content.includes('testFeature'))
  if (testFiles.length > 0 && !usesTestFeature) {
    report('hint', 'testing', 'test files found but none use testFeature() — it provides typed helpers and auto-cleanup')
  }

  // Test task
  if (!denoJson?.tasks?.['test']) {
    report('hint', 'testing', 'no "test" task in deno.json — add "test": "deno test -A --unstable-kv tests/"', { safeFix: fix.fixAddTestTask })
  }

  if (testFiles.length > 0) pass(`${testFiles.length} test file(s)`)
}

// ══════════════════════════════════════════════════════════════════════
// 9. CODE PATTERNS
// ══════════════════════════════════════════════════════════════════════

export const checkPatterns: Checker = (ctx) => {
  const { sourceFiles, report } = ctx

  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts') || file.name.endsWith('.test.tsx')) continue

    // any usage (outside lint-ignore comments)
    const anyLines = file.lines
      .map((l, i) => ({ line: l, num: i + 1 }))
      .filter(({ line }) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false
        if (trimmed.includes('deno-lint-ignore')) return false
        // Match : any, as any, <any> but not variable names containing "any"
        return /:\s*any\b|as\s+any\b|<any>/.test(line)
      })
    if (anyLines.length > 3) {
      report('hint', 'patterns', `${file.relative}: ${anyLines.length} uses of 'any' — prefer 'unknown' + type narrowing`, { file: file.relative, line: anyLines[0]!.num })
    }

    // Thrown exceptions in feature code (prefer Result pattern)
    if (file.content.includes('feature(')) {
      const throwLines = file.lines.filter(l => /\bthrow\s+new\s+/.test(l) && !l.trim().startsWith('//'))
      if (throwLines.length > 0) {
        report('hint', 'patterns', `${file.relative}: throw in feature code — consider returning error state instead (machines handle error states well)`, { file: file.relative })
      }
    }

    // Old dep/aio import paths
    if (file.content.includes("from '../dep/aio/") || file.content.includes("from \"../dep/aio/")) {
      report('warn', 'patterns', `${file.relative}: legacy import path "../dep/aio/..." — use "aio" instead`, { file: file.relative, fix: 'import { ... } from \'aio\'' })
    }

    // Node.js APIs
    const nodeApis = ['require(', 'process.env', 'module.exports', '__dirname', '__filename']
    for (const api of nodeApis) {
      if (file.content.includes(api) && !file.content.includes('// node') && !file.name.includes('electron')) {
        const lineIdx = file.lines.findIndex(l => l.includes(api))
        report('hint', 'patterns', `${file.relative}:${lineIdx + 1} — Node.js API "${api}" — use Deno equivalents`, { file: file.relative, line: lineIdx + 1 })
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 10. BUILD READINESS
// ══════════════════════════════════════════════════════════════════════

export const checkBuild: Checker = async (ctx) => {
  const { projectDir, denoJson, report, pass } = ctx
  const tasks = denoJson?.tasks ?? {}

  // Check esbuild installed
  const esbuildPaths = [
    join(projectDir, 'node_modules', 'esbuild'),
    join(projectDir, 'node_modules', '.bin', 'esbuild'),
  ]
  let esbuildFound = false
  for (const p of esbuildPaths) {
    try { await Deno.stat(p); esbuildFound = true; break } catch { /* not found */ }
  }
  if (!esbuildFound && Object.keys(tasks).some(k => k.startsWith('compile:') || k === 'dev')) {
    report('warn', 'build', 'esbuild not installed — required for dev mode and compilation', { fix: 'Run: deno install' })
  }

  // Electron installed
  if (tasks['compile:electron'] || tasks['dev']?.includes('electron')) {
    try {
      await Deno.stat(join(projectDir, 'node_modules', 'electron', 'dist'))
      pass('Electron installed')
    } catch {
      try {
        await Deno.stat(join(projectDir, 'node_modules', 'electron'))
        report('warn', 'build', 'Electron package exists but dist/ missing — run: deno task install:electron')
      } catch {
        report('hint', 'build', 'Electron not installed — run: deno task install:electron (if you need desktop builds)')
      }
    }
  }

  // compile:android without android template
  if (tasks['compile:android']) {
    pass('Android target configured')
  }
}

// ══════════════════════════════════════════════════════════════════════
// 11. INTER-FEATURE PATTERNS
// ══════════════════════════════════════════════════════════════════════

export const checkInterFeature: Checker = (ctx) => {
  const { features, sourceFiles, report } = ctx

  if (features.length < 2) return

  // Check for circular imports between feature files
  const featureImports = new Map<string, Set<string>>()
  for (const f of features) {
    const imports = new Set<string>()
    for (const m of f.file.content.matchAll(/from\s+['"]\.?\/?.*?(\w[\w-]*)(?:\/index)?\.ts['"]/g)) {
      imports.add(m[1]!)
    }
    featureImports.set(f.name, imports)
  }

  // Detect cross-feature direct state access (anti-pattern)
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts')) continue
    for (const f of features) {
      // Check if file (that defines a DIFFERENT feature) directly accesses another feature's state
      const definesFeature = features.find(feat => feat.file.path === file.path)
      if (!definesFeature || definesFeature.name === f.name) continue
      // Look for patterns like: otherFeature.state or getState().otherFeature
      if (file.content.includes(`getState().${f.name}`) || file.content.includes(`state.${f.name}`)) {
        report('hint', 'inter-feature', `${file.relative}: accesses "${f.name}" state directly — use selectors or dispatchTo for loose coupling`, { file: file.relative })
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 12. SCHEDULING
// ══════════════════════════════════════════════════════════════════════

export const checkScheduling: Checker = (ctx) => {
  const { sourceFiles, appEntry, report, pass } = ctx

  const usesSchedule = sourceFiles.some(f => f.content.includes('schedule.') && !f.name.endsWith('.test.ts'))
  const hasScheduleConfig = appEntry?.content.includes('schedules') ?? false

  if (usesSchedule || hasScheduleConfig) {
    pass('scheduling configured')
  }

  // Check for schedule IDs with spaces or special chars
  for (const file of sourceFiles) {
    if (file.name.endsWith('.test.ts')) continue
    for (const m of file.content.matchAll(/schedule\.\w+\(\s*['"]([^'"]+)['"]/g)) {
      const id = m[1]!
      if (!/^[\w\-:.]+$/.test(id)) {
        const lineIdx = file.content.slice(0, m.index).split('\n').length
        report('error', 'scheduling', `${file.relative}:${lineIdx} — schedule ID "${id}" has invalid chars — use alphanumeric, hyphens, colons, dots`, { file: file.relative, line: lineIdx })
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// ALL CHECKS
// ══════════════════════════════════════════════════════════════════════

export const ALL_CHECKS: Checker[] = [
  checkConfig,
  checkStructure,
  checkFeatures,
  checkPerformance,
  checkSecurity,
  checkPersistence,
  checkUI,
  checkTesting,
  checkPatterns,
  checkBuild,
  checkInterFeature,
  checkScheduling,
]
