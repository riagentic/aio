// Build script — bundles App.tsx into dist/app.js (self-contained, React included)
// Flags: --compile (binary), --electron (AppImage), --android (APK), --client (aio-client AppImage), --force (skip cache)
import { resolve, join, dirname } from '@std/path'
import { slugify, copyDir, findGradle, writePlaceholderIcon, ensureAppimagetool, formatMb } from './build-helpers.ts'
const root = Deno.cwd()
const dist = resolve(join(root, 'dist'))
const out = join(dist, 'app.js')
const doElectron = Deno.args.includes('--electron')
const doAndroid = Deno.args.includes('--android')
const doClient = Deno.args.includes('--client')
const doCli = Deno.args.includes('--cli')
const doRemote = Deno.args.includes('--remote')
const doCompile = Deno.args.includes('--compile') || doElectron  // --electron implies --compile
const doForce = Deno.args.includes('--force')
const doRelease = Deno.args.includes('--release')
const doService = Deno.args.includes('--service')
const doHeadless = Deno.args.includes('--headless')

// Reject conflicting shell flags — only one shell target at a time
const shellFlags = [doElectron && '--electron', doAndroid && '--android', doCli && '--cli', doClient && '--client'].filter(Boolean)
if (shellFlags.length > 1) {
  console.error(`[build] \u2717 conflicting flags: ${shellFlags.join(' + ')} — pick one shell target`)
  Deno.exit(1)
}

// Dev-only packages excluded from all compile targets
const _nmDir = join(root, 'node_modules')
const _denoDir = join(_nmDir, '.deno')
const _devTopLevel = ['electron', 'esbuild', 'react', 'react-dom']
const _devDenoPrefixes = ['electron@', 'esbuild@', '@esbuild+', '@electron+', 'react@', 'react-dom@']

type SavedLink = { path: string; target: string; isDir: boolean }

/** Temporarily remove dev symlinks, run compile callback, restore symlinks. Returns callback result. */
async function withDevExcluded(tag: string, fn: (excludes: string[]) => Promise<boolean>): Promise<boolean> {
  const excludes: string[] = []
  try {
    for await (const e of Deno.readDir(_denoDir)) {
      if (e.isDirectory && _devDenoPrefixes.some(p => e.name.startsWith(p))) excludes.push(join(_denoDir, e.name))
    }
  } catch { /* no .deno dir */ }

  const saved: SavedLink[] = []
  async function _rm(path: string): Promise<void> {
    try { const t = await Deno.readLink(path); saved.push({ path, target: t, isDir: false }); await Deno.remove(path) } catch {}
  }
  async function _rmDir(path: string): Promise<void> {
    try {
      const inner: Array<{ name: string; target: string }> = []
      for await (const e of Deno.readDir(path)) { try { inner.push({ name: e.name, target: await Deno.readLink(join(path, e.name)) }) } catch {} }
      saved.push({ path, target: JSON.stringify(inner), isDir: true })
      await Deno.remove(path, { recursive: true })
    } catch {}
  }

  for (const name of _devTopLevel) await _rm(join(_nmDir, name))
  for (const scope of ['@electron', '@esbuild']) await _rmDir(join(_denoDir, 'node_modules', scope))
  await _rm(join(_nmDir, '.bin', 'esbuild'))

  console.log(`[${tag}] excluding ${excludes.length} dev dirs, removed ${saved.length} symlinks`)

  let ok = false
  try {
    ok = await fn(excludes)
  } finally {
    for (const { path, target, isDir } of saved) {
      try {
        if (isDir) {
          await Deno.mkdir(path, { recursive: true })
          for (const { name, target: t } of JSON.parse(target) as Array<{ name: string; target: string }>) await Deno.symlink(t, join(path, name))
        } else {
          await Deno.mkdir(dirname(path), { recursive: true })
          try { await Deno.remove(path) } catch { /* already gone */ }
          await Deno.symlink(target, path)
        }
      } catch (e) { console.warn(`[${tag}] failed to restore symlink ${path}: ${e}`) }
    }
    if (saved.length) console.log(`[${tag}] restored ${saved.length} symlinks`)
  }
  return ok
}

// App name: --name= flag > deno.json "title" field > directory name
const mainConfig = JSON.parse(await Deno.readTextFile(join(root, 'deno.json')))
const appTitle = mainConfig.title as string | undefined
const defaultName = appTitle ? slugify(appTitle) : (root.split('/').pop() || 'myapp')
const rawName = Deno.args.find(a => a.startsWith('--name='))?.slice(7)
const binaryName = rawName ? slugify(rawName) : defaultName
const os = Deno.build.os
const arch = Deno.build.arch === 'aarch64' ? 'aarch64' : 'x86_64'
const archStr = arch === 'aarch64' ? 'arm64' : 'x64'  // macOS/Windows naming convention

// ── Step 1: Bundle dist/app.js (React + useAio + user code, fully self-contained) ──
// Skip for targets that don't need browser bundles (CLI, headless, android:remote, electron:remote)
if (!doCli && !doHeadless && !doClient && !(doAndroid && doRemote)) {

/** Recursively yields .ts/.tsx/.css mtimes under a directory */
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
  } catch { /* no dir — skip */ }
}

/** Checks if dist/app.js is newer than all bundle inputs */
async function isBundleFresh(): Promise<boolean> {
  if (doForce) return false
  try {
    const outMtime = (await Deno.stat(out)).mtime!.getTime()
    // Check deno.json + framework source files
    const aioModule = doAndroid ? 'dep/aio/src/standalone.ts' : 'dep/aio/src/browser.ts'
    for (const f of [join(root, 'deno.json'), join(root, aioModule), join(root, 'dep/aio/src/msg.ts'), join(root, 'dep/aio/src/factory.ts'), join(root, 'dep/aio/src/deep-merge.ts'), join(root, 'dep/aio/src/dispatch.ts')]) {
      const s = await Deno.stat(f)
      if (s.mtime && s.mtime.getTime() > outMtime) return false
    }
    // Check all src/ files recursively
    for await (const mtime of walkSrcFiles(join(root, 'src'))) {
      if (mtime > outMtime) return false
    }
    return true
  } catch { return false /* no dist/app.js — needs build */ }
}

const bundleFresh = await isBundleFresh()

if (bundleFresh) {
  const s = await Deno.stat(out)
  console.log(`[build] \u2713 dist/app.js cached (${(s.size / 1024).toFixed(1)} KB) — use --force to rebuild`)
} else {
  // Clean dist/ and rebuild
  try { await Deno.remove(dist, { recursive: true }) } catch { /* no dist — skip */ }
  await Deno.mkdir(dist, { recursive: true })

  // Generate temp build config — overrides 'aio' to browser/standalone, adds React
  const aioEntry = doAndroid ? './dep/aio/src/standalone.ts' : './dep/aio/src/browser.ts'
  const buildConfig = {
    compilerOptions: mainConfig.compilerOptions,
    imports: {
      ...mainConfig.imports,
      'aio': aioEntry,
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
  const entryCode = doAndroid
    ? `\
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { initStandalone } from 'aio'
import { initialState } from './src/state.ts'
import { reduce } from './src/reduce.ts'
import { execute } from './src/execute.ts'
import App from './src/App.tsx'
initStandalone(initialState, { reduce, execute })
createRoot(document.getElementById('root')).render(createElement(App))
`
    : `\
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/App.tsx'
export function mount(el) { createRoot(el).render(createElement(App)) }
`
  await Deno.writeTextFile(buildEntryPath, entryCode)

  // Bundle via esbuild — no externals, everything inlined for browser
  // Filter aliases: esbuild resolves npm/jsr packages via node_modules, not Deno specifiers
  const esbuildAlias: Record<string, string> = {}
  for (const [k, v] of Object.entries(buildConfig.imports as Record<string, string>)) {
    if (!v.startsWith('npm:') && !v.startsWith('jsr:')) esbuildAlias[k] = v
  }

  let bundleOk = false
  try {
    const esbuild = await import('npm:esbuild')
    const result = await esbuild.build({
      entryPoints: [buildEntryPath],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'esnext',
      outfile: out,
      jsx: 'automatic',
      jsxImportSource: 'react',
      alias: esbuildAlias,
      logLevel: 'warning',
    })
    bundleOk = (result.errors?.length ?? 0) === 0
  } catch (e) {
    console.error(`[build] \u2717 esbuild failed: ${e}`)
  } finally {
    // Always clean up temp files (even on Ctrl-C via Deno unload hooks)
    await Deno.remove(buildConfigPath).catch(() => {})
    await Deno.remove(buildEntryPath).catch(() => {})
  }

  if (!bundleOk) {
    console.error('[build] \u2717 bundle failed')
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
} catch { /* no style.css — skip */ }
} // end bundle step

if (!doCompile && !doAndroid && !doClient && !doCli) Deno.exit(0)

// ── aio-client: standalone Electron connect-page AppImage (no Deno, no server) ──

if (doClient) {
  if (os !== 'linux') {
    console.error(`[client] \u2717 compile:electron:remote only supported on Linux — use CI for other platforms`)
    Deno.exit(1)
  }
  const appDir = join(dist, 'AppDir')

  // Clean and create AppDir
  try { await Deno.remove(appDir, { recursive: true }) } catch { /* no previous — skip */ }
  await Deno.mkdir(appDir, { recursive: true })

  // Generate client main.cjs
  const { electronClientScript } = await import('./electron.ts')
  const clientScript = electronClientScript()
  await Deno.writeTextFile(join(appDir, 'main.cjs'), clientScript)
  console.log('[client] ✓ main.cjs')

  // Copy Electron runtime
  const electronSrc = join(root, 'node_modules', 'electron', 'dist')
  try {
    await Deno.stat(electronSrc)
  } catch {
    console.error('[client] \u2717 node_modules/electron/dist/ not found — run: npm install electron --no-save')
    Deno.exit(1)
  }

  console.log('[client] copying Electron runtime...')
  await copyDir(electronSrc, join(appDir, 'electron'))
  console.log('[client] ✓ electron/ copied')

  // AppRun — launches electron directly with main.cjs (no Deno binary)
  const appRun = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/electron/electron" "$HERE/main.cjs" "$@"
`
  await Deno.writeTextFile(join(appDir, 'AppRun'), appRun)
  await Deno.chmod(join(appDir, 'AppRun'), 0o755)

  // Icon
  const userIcon = join(root, 'src', 'icon.png')
  try {
    await Deno.stat(userIcon)
    await Deno.copyFile(userIcon, join(appDir, 'aio-client.png'))
    console.log('[client] ✓ icon from src/icon.png')
  } catch {
    await writePlaceholderIcon(join(appDir, 'aio-client.svg'), 'aio')
    console.log('[client] ✓ generated placeholder icon')
  }

  // .desktop file
  const desktop = `[Desktop Entry]
Type=Application
Name=aio
Exec=aio-client
Icon=aio-client
Categories=Utility;
`
  await Deno.writeTextFile(join(appDir, 'aio-client.desktop'), desktop)

  // Download appimagetool if needed
  const toolPath = await ensureAppimagetool(arch, join(root, 'node_modules', '.cache'))

  // Build AppImage
  const appImageOut = join(root, `aio-client-${arch}.AppImage`)
  console.log('[appimage] packaging aio-client...')
  const appimageResult = await new Deno.Command(toolPath, {
    args: [appDir, appImageOut],
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...Deno.env.toObject(), ARCH: arch },
  }).output()
  if (appimageResult.code !== 0) {
    console.error('[appimage] \u2717 appimagetool failed')
    Deno.exit(1)
  }

  const appImageStat = await Deno.stat(appImageOut)
  console.log(`[appimage] \u2713 aio-client-${arch}.AppImage (${formatMb(appImageStat.size)} MB)`)
  Deno.exit(0)
}

// ── CLI: skip esbuild, compile directly (no browser bundle needed) ──
if (doCli) {
  // CLI apps don't use App.tsx/React — just compile the Deno entry point
  const cliEntry = doRemote ? 'src/client.ts' : 'src/app.ts'
  try {
    await Deno.stat(join(root, cliEntry))
  } catch {
    console.error(`[cli] \u2717 ${cliEntry} not found`)
    Deno.exit(1)
  }

  const cliTarget = doRemote ? `${binaryName}-client` : binaryName
  console.log(`[cli] compiling ${cliEntry} → ${cliTarget}`)

  const ok = await withDevExcluded('cli', async (excludes) => {
    const result = await new Deno.Command('deno', {
      args: ['compile', '-A', ...excludes.flatMap(e => ['--exclude', e]), '-o', cliTarget, cliEntry],
      stdout: 'inherit', stderr: 'inherit',
    }).output()
    if (result.code === 0) console.log(`[cli] \u2713 ${cliTarget}`)
    return result.code === 0
  })

  if (!ok) { console.error('[cli] \u2717 compile failed'); Deno.exit(1) }
  Deno.exit(0)
}

// ── Android: skip compile/electron, go straight to APK build ──
if (doAndroid) {
  const androidHome = Deno.env.get('ANDROID_HOME')
  if (!androidHome) {
    console.error('[android] \u2717 ANDROID_HOME not set — install Android SDK and set ANDROID_HOME')
    Deno.exit(1)
  }

  const frameworkDir = resolve(import.meta.dirname ?? '.')
  const templateDir = resolve(join(frameworkDir, '..', 'android-template'))
  const androidDir = join(dist, 'android')

  // Clean previous android build
  try { await Deno.remove(androidDir, { recursive: true }) } catch { /* no previous build — skip */ }

  // Copy template
  await copyDir(templateDir, androidDir)

  // Derive application ID from binary name
  const sanitizedId = binaryName.replace(/[^a-z0-9]/g, '')
  if (!sanitizedId || !/^[a-z]/.test(sanitizedId)) {
    console.error(`[android] \u2717 binary name "${binaryName}" produces invalid applicationId — must start with a letter`)
    Deno.exit(1)
  }
  const applicationId = `app.aio.${sanitizedId}`
  const appNameKotlin = (appTitle ?? binaryName).replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"')
  const appNameXml = (appTitle ?? binaryName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Check for user icon
  const iconPath = join(root, 'src', 'icon.png')
  let hasIcon = false
  try { await Deno.stat(iconPath); hasIcon = true } catch { /* no icon — skip */ }

  // Replace placeholders in template files (Kotlin files get Kotlin-escaped, XML gets XML-escaped)
  const xmlFiles = new Set(['app/src/main/AndroidManifest.xml'])
  const templateFiles = [
    'app/build.gradle.kts',
    'build.gradle.kts',
    'settings.gradle.kts',
    'app/src/main/AndroidManifest.xml',
  ]
  for (const f of templateFiles) {
    const path = join(androidDir, f)
    let content = await Deno.readTextFile(path)
    content = content.replaceAll('{{APPLICATION_ID}}', applicationId)
    content = content.replaceAll('{{APP_NAME}}', xmlFiles.has(f) ? appNameXml : appNameKotlin)
    content = content.replaceAll('{{ICON_ATTR}}', hasIcon ? 'android:icon="@mipmap/ic_launcher"' : '')
    await Deno.writeTextFile(path, content)
  }

  console.log(`[android] app: ${appNameKotlin} (${applicationId})`)

  // Copy assets into android project
  const assetsDir = join(androidDir, 'app/src/main/assets')
  await Deno.mkdir(assetsDir, { recursive: true })

  if (doRemote) {
    // Android remote: connect page — user enters server URL, WebView navigates to it
    const connectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appNameXml}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh}
    .card{text-align:center;padding:2rem;width:90%;max-width:400px}
    h1{font-size:2rem;font-weight:300;letter-spacing:.1em;color:#4a9eff;margin-bottom:1.5rem}
    input{width:100%;padding:.8rem 1rem;font-size:1rem;background:#16213e;border:1px solid #333;border-radius:8px;color:#e0e0e0;outline:none;margin-bottom:.8rem}
    input:focus{border-color:#4a9eff}
    input::placeholder{color:#666}
    button{width:100%;padding:.8rem;font-size:1rem;background:#4a9eff;border:none;border-radius:8px;color:white;cursor:pointer}
    button:active{background:#3a8eef}
    #err{margin-top:.8rem;font-size:.85rem;color:#f44;min-height:1.2em}
  </style>
</head>
<body>
  <div class="card">
    <h1>aio</h1>
    <form id="f">
      <input id="addr" type="text" placeholder="192.168.1.100:8000" autofocus spellcheck="false" />
      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>
  </div>
  <script>
    var s=localStorage.getItem('aio_server');
    if(s)document.getElementById('addr').value=s;
    document.getElementById('f').onsubmit=function(e){
      e.preventDefault();
      var v=document.getElementById('addr').value.trim();
      if(!v)return;
      if(v.indexOf('http://')!==0&&v.indexOf('https://')!==0)v='http://'+v;
      try{new URL(v)}catch(x){document.getElementById('err').textContent='Invalid URL';return}
      localStorage.setItem('aio_server',v);
      location.href=v;
    };
  </script>
</body>
</html>`
    await Deno.writeTextFile(join(assetsDir, 'index.html'), connectHtml)
    console.log('[android] \u2713 connect page')
  } else {
    // Android local: standalone app — full dispatch loop in WebView
    let hasCSS = false
    try { await Deno.stat(join(dist, 'style.css')); hasCSS = true } catch { /* no css — skip */ }
    const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="./style.css">' : ''
    const escTitle = appNameXml
    const androidHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escTitle}</title>${cssLink}
</head>
<body>
  <div id="root"></div>
  <script src="./app.js"></script>
</body>
</html>`
    await Deno.copyFile(join(dist, 'app.js'), join(assetsDir, 'app.js'))
    await Deno.writeTextFile(join(assetsDir, 'index.html'), androidHtml)
    if (hasCSS) await Deno.copyFile(join(dist, 'style.css'), join(assetsDir, 'style.css'))
    console.log('[android] \u2713 assets copied')
  }

  // Copy icon to mipmap resources
  if (hasIcon) {
    const mipmapDir = join(androidDir, 'app/src/main/res/mipmap-hdpi')
    await Deno.mkdir(mipmapDir, { recursive: true })
    await Deno.copyFile(iconPath, join(mipmapDir, 'ic_launcher.png'))
    console.log('[android] \u2713 icon from src/icon.png')
  }

  // Find gradle on system — check PATH + common locations
  const gradleBin = findGradle()
  if (!gradleBin) {
    console.error('[android] \u2717 gradle not found — install Gradle and ensure it\'s on PATH or in a standard location')
    console.error('  checked: PATH, /usr/bin, /usr/local/bin, /snap/bin, /opt/gradle/bin, ~/.sdkman/')
    Deno.exit(1)
  }

  const gradleEnv = { ...Deno.env.toObject(), ANDROID_HOME: androidHome, JAVA_HOME: Deno.env.get('JAVA_HOME') ?? '' }

  // Generate gradle wrapper — pins version for reproducible builds (AGP 8.7.x needs Gradle 8.9+)
  console.log(`[android] generating gradle wrapper (using ${gradleBin})...`)
  const wrapperResult = await new Deno.Command(gradleBin, {
    args: ['wrapper', '--gradle-version', '8.12.1'],
    cwd: androidDir,
    stdout: 'piped',
    stderr: 'inherit',
    env: gradleEnv,
  }).output()

  if (wrapperResult.code !== 0) {
    console.error('[android] \u2717 gradle wrapper generation failed')
    Deno.exit(1)
  }

  const gradlew = join(androidDir, 'gradlew')
  await Deno.chmod(gradlew, 0o755)
  console.log('[android] \u2713 gradle wrapper (pinned 8.12.1)')

  // Build APK using wrapper
  const gradleTask = doRelease ? 'assembleRelease' : 'assembleDebug'
  console.log(`[android] ./gradlew ${gradleTask}...`)
  const gradleResult = await new Deno.Command(gradlew, {
    args: [gradleTask],
    cwd: androidDir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: gradleEnv,
  }).output()

  if (gradleResult.code !== 0) {
    console.error('[android] \u2717 gradle build failed')
    Deno.exit(1)
  }

  // Copy APK to project root
  const apkVariant = doRelease ? 'release/app-release.apk' : 'debug/app-debug.apk'
  const apkSrc = join(androidDir, 'app/build/outputs/apk', apkVariant)
  const apkLabel = doRemote ? `${binaryName}-client` : binaryName
  const apkDst = join(root, `${apkLabel}.apk`)
  await Deno.copyFile(apkSrc, apkDst)
  const apkStat = await Deno.stat(apkDst)
  const apkMb = (apkStat.size / 1024 / 1024).toFixed(1)
  console.log(`[android] \u2713 ${apkLabel}.apk (${apkMb} MB)`)
  Deno.exit(0)
}

// Clean dist/ before compile — keep only app.js and style.css, remove stale build artifacts
try {
  for await (const entry of Deno.readDir(dist)) {
    if (entry.name === 'app.js' || entry.name === 'style.css') continue
    await Deno.remove(join(dist, entry.name), { recursive: true })
  }
} catch { /* no dist/ when headless — skip */ }

// ── Step 2: Compile deno binary ──

const compileTarget = doElectron ? join(dist, 'AppDir', binaryName) : binaryName
if (doElectron) await Deno.mkdir(join(dist, 'AppDir'), { recursive: true })

// Only include dist/ if it exists (headless targets skip bundling)
let hasDist = false
try { hasDist = (await Deno.stat(dist)).isDirectory } catch { /* no dist */ }

const compileOk = await withDevExcluded('compile', async (excludes) => {
  const result = await new Deno.Command('deno', {
    args: [
      'compile', '-A',
      ...(hasDist ? ['--include', 'dist/'] : []),
      ...excludes.flatMap(e => ['--exclude', e]),
      '-o', compileTarget, 'src/app.ts',
    ],
    stdout: 'inherit', stderr: 'inherit',
  }).output()
  if (result.code === 0) console.log(`[compile] \u2713 ${compileTarget}`)
  return result.code === 0
})

if (!compileOk) {
  console.error('[compile] \u2717 deno compile failed')
  Deno.exit(1)
}

// ── Optional: generate systemd .service file ──
if (doService) {
  const user = Deno.env.get('USER') ?? 'root'
  const home = Deno.env.get('HOME') ?? `/home/${user}`
  const serviceFile = `${binaryName}.service`
  const execFlags = ['--port=3000']
  if (doRemote) execFlags.push('--expose')
  if (doHeadless) execFlags.push('--headless')
  const unit = `[Unit]
Description=${appTitle ?? binaryName} (aio)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/${binaryName} ${execFlags.join(' ')}  # adjust path after install
Restart=on-failure
RestartSec=5
User=${user}
Environment=HOME=${home}

[Install]
WantedBy=multi-user.target
`
  await Deno.writeTextFile(serviceFile, unit)
  console.log(`[service] ✓ ${serviceFile}`)
  console.log(`
  Install:
    sudo cp ${binaryName} /usr/local/bin/
    sudo cp ${serviceFile} /etc/systemd/system/
    sudo systemctl enable --now ${binaryName}

  Manage:
    sudo systemctl status ${binaryName}
    journalctl -u ${binaryName} -f
`)
}

if (!doElectron) Deno.exit(0)

// ── Step 3: Package with bundled Electron (platform-aware) ──

const appDir = join(dist, 'AppDir')
const electronSrc = join(root, 'node_modules', 'electron', 'dist')
const electronDst = join(appDir, 'electron')

// Verify electron source exists
try {
  await Deno.stat(electronSrc)
} catch {
  console.error('[electron] \u2717 node_modules/electron/dist/ not found — run: npm install electron --no-save')
  Deno.exit(1)
}

// Copy electron dist into AppDir/electron/
console.log('[electron] copying Electron runtime...')
await copyDir(electronSrc, electronDst)
console.log('[electron] \u2713 electron/ copied')

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

const displayName = (appTitle ?? binaryName).replace(/[\x00-\x1f\x7f\r\n]/g, '')

if (os === 'linux') {
  // ── Linux: AppImage ──

  const appRun = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
export ELECTRON_PATH="$HERE/electron/electron"
exec "$HERE/${binaryName}" "$@"
`
  await Deno.writeTextFile(join(appDir, 'AppRun'), appRun)
  await Deno.chmod(join(appDir, 'AppRun'), 0o755)

  // .desktop file required by AppImage spec
  const desktop = `[Desktop Entry]
Type=Application
Name=${displayName}
Exec=${binaryName}
Icon=${binaryName}
Categories=Utility;
`
  await Deno.writeTextFile(join(appDir, `${binaryName}.desktop`), desktop)

  // Download appimagetool if needed
  const toolPath = await ensureAppimagetool(arch, join(root, 'node_modules', '.cache'))

  const appImageOut = join(root, `${binaryName}-${arch}.AppImage`)
  console.log('[appimage] packaging...')
  const appimageResult = await new Deno.Command(toolPath, {
    args: [appDir, appImageOut],
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...Deno.env.toObject(), ARCH: arch },
  }).output()

  if (appimageResult.code !== 0) {
    console.error('[appimage] \u2717 appimagetool failed')
    Deno.exit(1)
  }

  const appImageStat = await Deno.stat(appImageOut)
  console.log(`[appimage] \u2713 ${binaryName}-${arch}.AppImage (${formatMb(appImageStat.size)} MB)`)

} else if (os === 'windows') {
  // ── Windows: zip with run.bat launcher ──
  // Deno compile adds .exe automatically on Windows
  const launcher = `@echo off
SET HERE=%~dp0
SET ELECTRON_PATH=%HERE%electron\\electron.exe
"%HERE%${binaryName}.exe" %*
`
  await Promise.all([
    Deno.writeTextFile(join(appDir, 'run.bat'), launcher),
    Deno.writeTextFile(join(appDir, 'README.txt'),
      `${displayName}\n\nRun: double-click run.bat or ${binaryName}.exe\n`),
  ])
  console.log('[electron] \u2713 run.bat launcher')

  const zipOut = join(root, `${binaryName}-win-${archStr}.zip`)
  console.log('[electron] zipping Windows package...')
  const zipResult = await new Deno.Command('powershell', {
    args: ['-NoProfile', '-Command',
      `Compress-Archive -Path "${appDir}\\*" -DestinationPath "${zipOut}" -Force`],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()

  if (zipResult.code !== 0) {
    console.error('[electron] \u2717 Compress-Archive failed')
    Deno.exit(1)
  }

  const zipStat = await Deno.stat(zipOut)
  console.log(`[electron] \u2713 ${binaryName}-win-${archStr}.zip (${formatMb(zipStat.size)} MB)`)

} else if (os === 'darwin') {
  // ── macOS: zip with run.sh launcher ──
  // Electron on macOS ships as Electron.app/ inside dist/
  const launcher = `#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
export ELECTRON_PATH="$HERE/electron/Electron.app/Contents/MacOS/Electron"
exec "$HERE/${binaryName}" "$@"
`
  const launcherPath = join(appDir, 'run.sh')
  await Deno.writeTextFile(launcherPath, launcher)
  await Deno.chmod(launcherPath, 0o755)
  console.log('[electron] \u2713 run.sh launcher')

  const zipOut = join(root, `${binaryName}-mac-${archStr}.zip`)
  console.log('[electron] zipping macOS package...')
  const zipResult = await new Deno.Command('zip', {
    args: ['-r', zipOut, '.'],
    cwd: appDir,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()

  if (zipResult.code !== 0) {
    console.error('[electron] \u2717 zip failed')
    Deno.exit(1)
  }

  const zipStat = await Deno.stat(zipOut)
  console.log(`[electron] \u2713 ${binaryName}-mac-${archStr}.zip (${formatMb(zipStat.size)} MB)`)

} else {
  console.error(`[electron] \u2717 unsupported platform: ${os}`)
  Deno.exit(1)
}

// Helpers (copyDir, findGradle, writePlaceholderIcon, slugify) imported from build-helpers.ts
