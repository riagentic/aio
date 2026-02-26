// Build script — bundles App.tsx into dist/app.js (self-contained, React included)
// Flags: --compile (produce binary), --electron (produce AppImage with embedded Electron), --force (skip cache)
import { resolve, join, dirname } from '@std/path'
const root = Deno.cwd()
const dist = resolve(join(root, 'dist'))
const out = join(dist, 'app.js')
const doElectron = Deno.args.includes('--electron')
const doCompile = Deno.args.includes('--compile') || doElectron  // --electron implies --compile
const doForce = Deno.args.includes('--force')

// App name: --name= flag > deno.json "title" field > directory name
const mainConfig = JSON.parse(await Deno.readTextFile(join(root, 'deno.json')))
const appTitle = mainConfig.title as string | undefined
const defaultName = appTitle
  ?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  ?? root.split('/').pop()
  ?? 'myapp'
const binaryName = Deno.args.find(a => a.startsWith('--name='))?.slice(7) ?? defaultName

// ── Step 1: Bundle dist/app.js (React + useAio + user code, fully self-contained) ──

// Recursively yield .ts/.tsx/.css mtimes under a directory
async function* walkSrcFiles(dir: string): AsyncGenerator<number> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name)
      if (entry.isDirectory) {
        yield* walkSrcFiles(path)
      } else if (entry.isFile && /\.(tsx?|css)$/.test(entry.name)) {
        const s = await Deno.stat(path)
        if (s.mtime) yield s.mtime.getTime()
      }
    }
  } catch { /* dir doesn't exist */ }
}

// Check if dist/app.js is newer than all bundle inputs
async function isBundleFresh(): Promise<boolean> {
  if (doForce) return false
  try {
    const outMtime = (await Deno.stat(out)).mtime!.getTime()
    // Check deno.json + framework browser files
    for (const f of [join(root, 'deno.json'), join(root, 'dep/aio/src/browser.ts'), join(root, 'dep/aio/src/msg.ts')]) {
      const s = await Deno.stat(f)
      if (s.mtime && s.mtime.getTime() > outMtime) return false
    }
    // Check all src/ files recursively
    for await (const mtime of walkSrcFiles(join(root, 'src'))) {
      if (mtime > outMtime) return false
    }
    return true
  } catch {
    return false  // dist/app.js doesn't exist
  }
}

const bundleFresh = await isBundleFresh()

if (bundleFresh) {
  const s = await Deno.stat(out)
  console.log(`[build] \u2713 dist/app.js cached (${(s.size / 1024).toFixed(1)} KB) — use --force to rebuild`)
} else {
  // Clean dist/ and rebuild
  try { await Deno.remove(dist, { recursive: true }) } catch { /* didn't exist */ }
  await Deno.mkdir(dist, { recursive: true })

  // Generate temp build config — overrides 'aio' to browser.ts, adds React
  const buildConfig = {
    compilerOptions: mainConfig.compilerOptions,
    imports: {
      ...mainConfig.imports,
      'aio': './dep/aio/src/browser.ts',
      'react': 'npm:react@^18',
      'react-dom': 'npm:react-dom@^18',
      'react-dom/client': 'npm:react-dom@^18/client',
      'react/jsx-runtime': 'npm:react@^18/jsx-runtime',
    },
  }
  const buildConfigPath = join(root, '_build.json')
  await Deno.writeTextFile(buildConfigPath, JSON.stringify(buildConfig, null, 2))

  // Generate temp entry that exports mount() for prod HTML
  const buildEntryPath = join(root, '_build_entry.tsx')
  await Deno.writeTextFile(buildEntryPath, `\
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/App.tsx'
export function mount(el) { createRoot(el).render(createElement(App)) }
`)

  // Bundle — no externals, everything inlined
  let bundleOk = false
  try {
    const bundle = new Deno.Command('deno', {
      args: [
        'bundle',
        '--config', buildConfigPath,
        '--platform', 'browser',
        '-o', out,
        buildEntryPath,
      ],
      stdout: 'inherit',
      stderr: 'inherit',
    })

    const { code } = await bundle.output()
    bundleOk = code === 0
  } finally {
    // Always clean up temp files (even on Ctrl-C via Deno unload hooks)
    await Deno.remove(buildConfigPath).catch(() => {})
    await Deno.remove(buildEntryPath).catch(() => {})
  }

  if (!bundleOk) {
    console.error('[build] \u2717 deno bundle failed')
    Deno.exit(1)
  }

  const stat = await Deno.stat(out)
  const kb = (stat.size / 1024).toFixed(1)
  console.log(`[build] \u2713 dist/app.js (${kb} KB)`)
}

// Copy style.css to dist/ if it exists (always — cheap and may have changed)
await Deno.mkdir(dist, { recursive: true })
const styleSrc = join(root, 'src', 'style.css')
try {
  await Deno.stat(styleSrc)
  await Deno.copyFile(styleSrc, join(dist, 'style.css'))
  console.log('[build] \u2713 dist/style.css')
} catch { /* no style.css — that's fine */ }

if (!doCompile) Deno.exit(0)

// Clean dist/ before compile — keep only app.js and style.css, remove stale build artifacts
for await (const entry of Deno.readDir(dist)) {
  if (entry.name === 'app.js' || entry.name === 'style.css') continue
  await Deno.remove(join(dist, entry.name), { recursive: true })
}

// ── Step 2: Compile deno binary ──

// Strategy: --exclude the big .deno/ versioned dirs, temporarily remove symlinks
// that point into them (otherwise deno compile follows symlinks past the exclusion).
const nmDir = join(root, 'node_modules')
const denoDir = join(nmDir, '.deno')

// Blocklist prefixes for dev-only packages (not needed at server runtime)
const devTopLevel = ['electron', 'esbuild', 'react', 'react-dom']
const devDenoPrefixes = ['electron@', 'esbuild@', '@esbuild+', '@electron+', 'react@', 'react-dom@']

// Collect --exclude args for big .deno/ versioned dirs
const excludes: string[] = []
try {
  for await (const e of Deno.readDir(denoDir)) {
    if (!e.isDirectory) continue
    if (devDenoPrefixes.some(p => e.name.startsWith(p))) {
      excludes.push(join(denoDir, e.name))
    }
  }
} catch { /* no .deno dir */ }

// Remove symlinks that would let deno compile reach excluded dirs, save for restore
const removed: Array<{ path: string; target: string; isDir: boolean }> = []

async function removeLink(path: string): Promise<void> {
  try {
    const target = await Deno.readLink(path)
    removed.push({ path, target, isDir: false })
    await Deno.remove(path)
  } catch { /* not present */ }
}

async function removeLinkDir(path: string): Promise<void> {
  try {
    const inner: Array<{ name: string; target: string }> = []
    for await (const e of Deno.readDir(path)) {
      try {
        const t = await Deno.readLink(join(path, e.name))
        inner.push({ name: e.name, target: t })
      } catch { /* not a symlink */ }
    }
    removed.push({ path, target: JSON.stringify(inner), isDir: true })
    await Deno.remove(path, { recursive: true })
  } catch { /* not present */ }
}

// Top-level: node_modules/electron → .deno/electron@.../...
for (const name of devTopLevel) {
  await removeLink(join(nmDir, name))
}

// Scoped symlink dirs: .deno/node_modules/@electron/, .deno/node_modules/@esbuild/
for (const scope of ['@electron', '@esbuild']) {
  await removeLinkDir(join(denoDir, 'node_modules', scope))
}

// .bin entries for dev packages
await removeLink(join(nmDir, '.bin', 'esbuild'))

console.log(`[compile] excluding ${excludes.length} dev dirs, removed ${removed.length} symlinks`)

const compileTarget = doElectron ? join(dist, 'AppDir', binaryName) : binaryName
if (doElectron) await Deno.mkdir(join(dist, 'AppDir'), { recursive: true })

let compileOk = false
try {
  const compile = new Deno.Command('deno', {
    args: [
      'compile', '-A', '--include', 'dist/',
      ...excludes.flatMap(e => ['--exclude', e]),
      '-o', compileTarget, 'src/app.ts',
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const result = await compile.output()
  compileOk = result.code === 0
  if (compileOk) console.log(`[compile] \u2713 ${compileTarget}`)
} finally {
  // Restore all removed symlinks
  for (const { path, target, isDir } of removed) {
    try {
      if (isDir) {
        await Deno.mkdir(path, { recursive: true })
        const inner = JSON.parse(target) as Array<{ name: string; target: string }>
        for (const { name, target: t } of inner) {
          await Deno.symlink(t, join(path, name))
        }
      } else {
        await Deno.mkdir(dirname(path), { recursive: true })
        await Deno.symlink(target, path)
      }
    } catch { /* */ }
  }
}

if (!compileOk) {
  console.error('[compile] \u2717 deno compile failed')
  Deno.exit(1)
}

if (!doElectron) Deno.exit(0)

// ── Step 3: Build AppImage with bundled Electron ──

const arch = Deno.build.arch === 'aarch64' ? 'aarch64' : 'x86_64'
const appDir = join(dist, 'AppDir')
const electronSrc = join(root, 'node_modules', 'electron', 'dist')
const electronDst = join(appDir, 'electron')

// Verify electron source exists
try {
  await Deno.stat(electronSrc)
} catch {
  console.error('[electron] \u2717 node_modules/electron/dist/ not found — install: deno install npm:electron')
  Deno.exit(1)
}

// Copy electron dist into AppDir
console.log('[electron] copying Electron runtime...')
await copyDir(electronSrc, electronDst)
console.log('[electron] \u2713 electron/ copied')

// Generate AppRun
const appRun = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
export ELECTRON_PATH="$HERE/electron/electron"
exec "$HERE/${binaryName}" "$@"
`
await Deno.writeTextFile(join(appDir, 'AppRun'), appRun)
await Deno.chmod(join(appDir, 'AppRun'), 0o755)

// Icon: use src/icon.png if available, otherwise generate a placeholder SVG
const userIcon = join(root, 'src', 'icon.png')
try {
  await Deno.stat(userIcon)
  await Deno.copyFile(userIcon, join(appDir, `${binaryName}.png`))
  console.log('[electron] \u2713 icon from src/icon.png')
} catch {
  await writePlaceholderIcon(join(appDir, `${binaryName}.svg`), binaryName)
  console.log('[electron] \u2713 generated placeholder icon')
}

// Generate .desktop file
const displayName = appTitle ?? binaryName
const desktop = `[Desktop Entry]
Type=Application
Name=${displayName}
Exec=${binaryName}
Icon=${binaryName}
Categories=Utility;
`
await Deno.writeTextFile(join(appDir, `${binaryName}.desktop`), desktop)

// Download appimagetool if needed
const cacheDir = join(root, 'node_modules', '.cache')
await Deno.mkdir(cacheDir, { recursive: true })
const toolPath = join(cacheDir, 'appimagetool')

try {
  await Deno.stat(toolPath)
} catch {
  console.log('[appimage] downloading appimagetool...')
  const url = `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage`
  const resp = await fetch(url)
  if (!resp.ok || !resp.body) {
    console.error(`[appimage] \u2717 failed to download appimagetool: ${resp.status}`)
    Deno.exit(1)
  }
  const bytes = new Uint8Array(await resp.arrayBuffer())
  // Sanity check — verify downloaded file is a valid ELF binary
  if (bytes.length < 4 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    console.error('[appimage] \u2717 downloaded file is not a valid ELF binary')
    Deno.exit(1)
  }
  await Deno.writeFile(toolPath, bytes)
  await Deno.chmod(toolPath, 0o755)
  console.log('[appimage] \u2713 appimagetool cached')
}

// Build the AppImage
const appImageOut = join(root, `${binaryName}-${arch}.AppImage`)

console.log('[appimage] packaging...')
const appimage = new Deno.Command(toolPath, {
  args: [appDir, appImageOut],
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...Deno.env.toObject(), ARCH: arch },
})

const appimageResult = await appimage.output()
if (appimageResult.code !== 0) {
  console.error('[appimage] \u2717 appimagetool failed')
  Deno.exit(1)
}

const appImageStat = await Deno.stat(appImageOut)
const mb = (appImageStat.size / 1024 / 1024).toFixed(1)
console.log(`[appimage] \u2713 ${binaryName}-${arch}.AppImage (${mb} MB)`)

// ── Helpers ──

/** Recursively copy a directory */
async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true })
  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory) {
      await copyDir(srcPath, dstPath)
    } else if (entry.isSymlink) {
      const target = await Deno.readLink(srcPath)
      await Deno.symlink(target, dstPath)
    } else {
      await Deno.copyFile(srcPath, dstPath)
      // Preserve executable bit
      try {
        const info = await Deno.stat(srcPath)
        if (info.mode !== null && info.mode & 0o111) {
          await Deno.chmod(dstPath, info.mode)
        }
      } catch { /* */ }
    }
  }
}

/** Write a placeholder SVG icon */
async function writePlaceholderIcon(path: string, label: string): Promise<void> {
  const letter = (label[0] ?? 'A').toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#4a9eff"/>
  <text x="24" y="34" font-size="28" font-family="sans-serif" fill="white" text-anchor="middle">${letter}</text>
</svg>`
  await Deno.writeTextFile(path, svg)
}
