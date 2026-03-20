// aiol — project scanner: reads files, extracts features, builds LintContext

import { join, relative, extname, basename } from '@std/path'
import type { DenoJsonConfig, SourceFile, FeatureInfo, LintContext, Issue, Report } from './types.ts'

const SOURCE_EXTS = new Set(['.ts', '.tsx'])
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.claude', 'untracked', '.vscode'])
const MAX_FILE_SIZE = 512 * 1024 // 512KB — skip huge generated files

/** Recursively collect source files */
async function collectFiles(dir: string, root: string, out: SourceFile[]): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name)
      if (entry.isDirectory) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await collectFiles(path, root, out)
      } else if (entry.isFile && SOURCE_EXTS.has(extname(entry.name))) {
        try {
          const stat = await Deno.stat(path)
          if (stat.size > MAX_FILE_SIZE) continue
          const content = await Deno.readTextFile(path)
          out.push({
            path,
            relative: relative(root, path),
            name: basename(path),
            ext: extname(path),
            content,
            lines: content.split('\n'),
          })
        } catch { /* unreadable */ }
      }
    }
  } catch { /* dir unreadable */ }
}

/** Read and parse deno.json or deno.jsonc */
async function readDenoJson(dir: string): Promise<{ config: DenoJsonConfig | null; path: string | null }> {
  for (const name of ['deno.json', 'deno.jsonc']) {
    const path = join(dir, name)
    try {
      const text = await Deno.readTextFile(path)
      // Strip JSONC comments for .jsonc
      const clean = name.endsWith('.jsonc')
        ? text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
        : text
      return { config: JSON.parse(clean), path }
    } catch { continue }
  }
  return { config: null, path: null }
}

/** Extract feature() calls from source files via regex (no AST needed) */
function extractFeatures(files: SourceFile[]): FeatureInfo[] {
  const features: FeatureInfo[] = []
  // Match: feature('name', { ... }) or feature("name", { ... })
  const featureRe = /\bfeature\s*\(\s*(['"`])(\w[\w-]*)\1/g

  for (const file of files) {
    for (const match of file.content.matchAll(featureRe)) {
      const name = match[2]!
      const lineIdx = file.content.slice(0, match.index).split('\n').length
      // Scan forward from match to find the config object
      const afterMatch = file.content.slice(match.index!)
      const info = parseFeatureConfig(afterMatch)

      features.push({
        name,
        file,
        line: lineIdx,
        hasState: info.hasState,
        hasMethods: info.hasMethods,
        hasActions: info.hasActions,
        hasGenerators: info.hasGenerators,
        hasMachine: info.hasMachine,
        hasSelectors: info.hasSelectors,
        stateKeys: info.stateKeys,
        methodNames: info.methodNames,
        actionNames: info.actionNames,
      })
    }
  }
  return features
}

/** Parse feature config block to extract state keys, methods, etc. */
function parseFeatureConfig(source: string): {
  hasState: boolean; hasMethods: boolean; hasActions: boolean; hasGenerators: boolean
  hasMachine: boolean; hasSelectors: boolean; stateKeys: string[]; methodNames: string[]; actionNames: string[]
} {
  // Find the config object: first { after feature('name',
  // The source starts at `feature('name',...` so find the first {
  const firstBrace = source.indexOf('{')
  if (firstBrace === -1) {
    return { hasState: false, hasMethods: false, hasActions: false, hasGenerators: false, hasMachine: false, hasSelectors: false, stateKeys: [], methodNames: [], actionNames: [] }
  }
  let depth = 1
  let end = -1
  for (let i = firstBrace + 1; i < Math.min(source.length, 10000); i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  const start = firstBrace
  if (end === -1) {
    return { hasState: false, hasMethods: false, hasActions: false, hasGenerators: false, hasMachine: false, hasSelectors: false, stateKeys: [], methodNames: [], actionNames: [] }
  }

  const block = source.slice(start, end)
  const hasState = /\bstate\s*:/.test(block)
  const hasMethods = /\bmethods\s*:/.test(block)
  const hasActions = /\bactions\s*:/.test(block)
  const hasGenerators = /\bgenerators\s*:/.test(block)
  const hasMachine = /\bmachine\s*:/.test(block)
  const hasSelectors = /\bselectors\s*:/.test(block)

  // Extract state keys from state: { key1: ..., key2: ... }
  // Use brace matching instead of [^}] to handle nested objects/arrays
  const stateKeys: string[] = []
  const stateStart = block.match(/\bstate\s*:\s*\{/)
  if (stateStart) {
    const sIdx = block.indexOf(stateStart[0]) + stateStart[0].length
    // Find matching close brace for the state object
    let sd = 1, sEnd = sIdx
    for (let i = sIdx; i < block.length && sd > 0; i++) {
      if (block[i] === '{') sd++
      else if (block[i] === '}') { sd--; if (sd === 0) sEnd = i }
    }
    const stateBlock = block.slice(sIdx, sEnd)
    // Extract top-level keys (skip nested object contents)
    let kd = 0
    for (const m of stateBlock.matchAll(/([$\w]+)\s*:/g)) {
      // Count depth up to this match to ensure it's top-level
      const before = stateBlock.slice(0, m.index)
      kd = 0
      for (const ch of before) { if (ch === '{' || ch === '[') kd++; else if (ch === '}' || ch === ']') kd-- }
      if (kd === 0) stateKeys.push(m[1]!)
    }
  }

  // Extract method names from methods: { name(...) { } }
  const methodNames: string[] = []
  const methodsMatch = block.match(/\bmethods\s*:\s*\{/)
  if (methodsMatch) {
    const methodsStart = block.indexOf(methodsMatch[0]) + methodsMatch[0].length
    let d = 1
    let methodsEnd = methodsStart
    for (let i = methodsStart; i < block.length && d > 0; i++) {
      if (block[i] === '{') d++
      else if (block[i] === '}') d--
      if (d === 0) methodsEnd = i
    }
    const methodsBlock = block.slice(methodsStart, methodsEnd)
    // Match method declarations: name(, async name(, *name(
    for (const m of methodsBlock.matchAll(/(?:async\s+)?(?:\*\s*)?(\w+)\s*\(/g)) {
      const n = m[1]!
      if (n !== 'async' && n !== 'function') methodNames.push(n)
    }
  }

  // Extract action names from actions: { Name: ... }
  const actionNames: string[] = []
  const actionsMatch = block.match(/\bactions\s*:\s*\{/)
  if (actionsMatch) {
    const actionsStart = block.indexOf(actionsMatch[0]) + actionsMatch[0].length
    let d = 1
    let actionsEnd = actionsStart
    for (let i = actionsStart; i < block.length && d > 0; i++) {
      if (block[i] === '{') d++
      else if (block[i] === '}') d--
      if (d === 0) actionsEnd = i
    }
    const actionsBlock = block.slice(actionsStart, actionsEnd)
    for (const m of actionsBlock.matchAll(/(\w+)\s*:/g)) {
      actionNames.push(m[1]!)
    }
  }

  return { hasState, hasMethods, hasActions, hasGenerators, hasMachine, hasSelectors, stateKeys, methodNames, actionNames }
}

/** Build the full lint context for a project directory */
export async function buildContext(projectDir: string): Promise<{ ctx: LintContext; report: Report }> {
  const issues: Issue[] = []
  const passed: string[] = []
  const sourceFiles: SourceFile[] = []

  // Read deno.json
  const { config: denoJson, path: denoJsonPath } = await readDenoJson(projectDir)

  // Collect source files from src/ and project root
  const srcDir = join(projectDir, 'src')
  await collectFiles(srcDir, projectDir, sourceFiles)
  // Also scan features/ if it exists at root level
  const featuresDir = join(projectDir, 'features')
  try { await Deno.stat(featuresDir); await collectFiles(featuresDir, projectDir, sourceFiles) } catch { /* no features/ */ }
  // Scan root .ts/.tsx files
  try {
    for await (const entry of Deno.readDir(projectDir)) {
      if (!entry.isFile || !SOURCE_EXTS.has(extname(entry.name))) continue
      try {
        const path = join(projectDir, entry.name)
        const stat = await Deno.stat(path)
        if (stat.size > MAX_FILE_SIZE) continue
        const content = await Deno.readTextFile(path)
        // Don't duplicate files already in sourceFiles
        if (!sourceFiles.some(f => f.path === path)) {
          sourceFiles.push({ path, relative: entry.name, name: entry.name, ext: extname(entry.name), content, lines: content.split('\n') })
        }
      } catch { /* unreadable */ }
    }
  } catch { /* root unreadable */ }

  // Read CSS
  let styleCss: SourceFile | null = null
  for (const loc of [join(srcDir, 'style.css'), join(projectDir, 'style.css')]) {
    try {
      const content = await Deno.readTextFile(loc)
      styleCss = { path: loc, relative: relative(projectDir, loc), name: 'style.css', ext: '.css', content, lines: content.split('\n') }
      break
    } catch { /* not found */ }
  }

  const tsxFiles = sourceFiles.filter(f => f.ext === '.tsx')
  const tsFiles = sourceFiles.filter(f => f.ext === '.ts')
  const testFiles = sourceFiles.filter(f => f.name.endsWith('.test.ts') || f.name.endsWith('.test.tsx'))
  const features = extractFeatures(sourceFiles.filter(f => !f.name.endsWith('.test.ts')))

  // Find app entry and App.tsx
  const appEntry = sourceFiles.find(f => f.relative === 'src/app.ts' || f.relative === 'app.ts') ?? null
  const appTsx = sourceFiles.find(f => f.name === 'App.tsx') ?? null

  const ctx: LintContext = {
    projectDir,
    denoJson,
    denoJsonPath,
    sourceFiles,
    tsxFiles,
    tsFiles,
    testFiles,
    features,
    appEntry,
    appTsx,
    styleCss,
    report: (severity, area, message, opts) => {
      issues.push({ severity, area, message, file: opts?.file, line: opts?.line, fix: opts?.fix, safeFix: opts?.safeFix })
    },
    pass: (message) => { passed.push(message) },
  }

  const report: Report = {
    issues,
    passed,
    stats: {
      filesScanned: sourceFiles.length,
      featuresFound: features.length,
      testsFound: testFiles.length,
    },
  }

  return { ctx, report }
}
