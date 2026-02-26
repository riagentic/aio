// Electron launcher — tries packaged binary first, falls back to dev mode

type Log = { info: (msg: string) => void; error: (msg: string) => void }

// Generates a minimal Electron main.cjs that loads the AIO server URL
export function electronMainScript(port: number, width = 800, height = 600): string {
  return `
const { app, BrowserWindow, Menu } = require('electron');
Menu.setApplicationMenu(null);
app.on('ready', () => {
  const win = new BrowserWindow({ width: ${width}, height: ${height} });
  win.loadURL('http://localhost:${port}');
});
app.on('window-all-closed', () => process.exit(0));
`.trim()
}

// OS-aware packaged Electron binary path
function distBinPath(): string {
  switch (Deno.build.os) {
    case 'darwin': return 'dist/mac/aio-ui-electron.app/Contents/MacOS/aio-ui-electron'
    case 'windows': return 'dist/win-unpacked/aio-ui-electron.exe'
    default: return 'dist/linux-unpacked/aio-ui-electron'
  }
}

// Spawns Electron — $ELECTRON_PATH > packaged binary > node_modules dev binary > gives up
export async function launchElectron(port: number, log: Log, width = 800, height = 600): Promise<Deno.ChildProcess | null> {
  // 1. ELECTRON_PATH env var (AppImage / custom deployment)
  const envPath = Deno.env.get('ELECTRON_PATH')
  if (envPath) {
    try {
      await Deno.stat(envPath)
      log.info(`launching Electron from $ELECTRON_PATH`)
      const tmpFile = await Deno.makeTempFile({ suffix: '.cjs' })
      await Deno.writeTextFile(tmpFile, electronMainScript(port, width, height))
      const proc = new Deno.Command(envPath, { args: [tmpFile] }).spawn()
      proc.status.then(() => Deno.remove(tmpFile).catch(() => {}))
      return proc
    } catch {
      log.error(`$ELECTRON_PATH set but not found: ${envPath}`)
    }
  }

  // 2. Packaged binary (electron-builder output)
  const distBin = distBinPath()
  try {
    await Deno.stat(distBin)
    log.info('launching packaged Electron')
    return new Deno.Command(distBin, { args: [`--port=${port}`] }).spawn()
  } catch { /* not built — use dev mode */ }

  const electronBin = Deno.build.os === 'windows'
    ? 'node_modules\\.bin\\electron.cmd'
    : 'node_modules/.bin/electron'

  try {
    await Deno.stat(electronBin)
  } catch {
    log.error('Electron not found — install: deno install npm:electron')
    return null
  }

  const tmpFile = await Deno.makeTempFile({ suffix: '.cjs' })
  await Deno.writeTextFile(tmpFile, electronMainScript(port, width, height))

  log.info('launching Electron (dev)')
  const proc = new Deno.Command(electronBin, { args: [tmpFile] }).spawn()
  proc.status.then(() => Deno.remove(tmpFile).catch(() => {}))
  return proc
}
