// Electron binary resolution and process spawning

import { dirname, join } from "@std/path";
import type { AioMeta, Log, ShellConfig } from "./electron-shared.ts";
import { electronMainScript } from "./electron-scripts.ts";
import { electronClientScript } from "./electron-client-script.ts";
import { electronMainScriptUDS } from "./electron-uds.ts";
import { log } from "../diagnostics/logger-api.ts";
import { classifyElectronLine } from "./electron-renderer-log.ts";
import { isCompiled } from "../server/paths.ts";
import {
  bakedElectronVersion,
  DEFAULT_ELECTRON_VERSION,
  electronBinIn,
  electronSlug,
  ensureElectronRuntime,
} from "./electron-runtime-fetch.ts";

/** The runtime a SHIPPED package carries beside its executable.
 *
 *  `build-electron.ts` puts the whole Electron dist in `./electron/` next to
 *  the binary, and the Linux AppRun / `run.bat` / `run.sh` launchers export
 *  `$ELECTRON_PATH` at it. Nothing looked for it directly — so the Windows
 *  README's own instruction ("double-click myapp.exe") skipped the launcher,
 *  found no candidate, and fell through to a ~100 MB download of the runtime
 *  that was sitting in the same folder. Offline it printed "Electron is not
 *  available on this machine", with Electron right there.
 *
 *  Resolved against the EXECUTABLE, never the cwd: a packaged app is started
 *  from wherever its user happens to be. (In dev `Deno.execPath()` is `deno`
 *  itself, so this simply never matches — one candidate that stats and fails,
 *  before the node_modules rung that dev actually uses.)
 *
 *  This replaces three hardcoded `dist/{mac,win-unpacked,linux-unpacked}/…`
 *  paths — the electron-builder layout, which this repo has not produced for a
 *  long time. They stat'd relative to the CWD and could never match anything
 *  aio builds. */
export function packagedElectronCandidates(
  execPath?: string,
  os: string = Deno.build.os,
): string[] {
  try {
    return [
      electronBinIn(join(dirname(execPath ?? Deno.execPath()), "electron"), os),
    ];
  } catch {
    return [];
  }
}

/** How the launcher may obtain a runtime it cannot find. Injected so the
 *  resolution ORDER — the part that was wrong — is a unit test, not a 100 MB
 *  download and a display. */
export type FindElectronOpts = {
  /** The embedded/on-disk dist/ carrying `electron.json` (compiled binaries). */
  distDir?: string;
  /** Running as a compiled binary — `Deno.execPath()` is the app, not deno. */
  compiled?: boolean;
  /** The executable to resolve the shipped-runtime candidate against.
   *  Injected in tests; defaults to `Deno.execPath()`. */
  execPath?: string;
  /** The fetch-into-cache step (`ensureElectronRuntime`). */
  fetchRuntime?: (
    version: string,
    slug: string,
    log: Log,
  ) => Promise<string>;
  /** The dev-only `deno install` step (`autoInstallElectron`). */
  denoInstall?: (log: Log) => Promise<boolean>;
};

/** Resolves an Electron binary — $ELECTRON_PATH > packaged dist > node_modules
 *  dev > (compiled: fetched runtime cache | dev: deno install, then the cache).
 *
 *  The last rung is the one a COMPILED desktop app used to lack. Its runtime
 *  was looked up under the current directory and, failing that, "installed" by
 *  running `Deno.execPath() install npm:electron` — which inside a compiled
 *  binary runs the app itself. So an app installed by the one-liner opened
 *  nothing, and the message told its user to run `deno task
 *  install:electron` in a checkout they had not been handed. A binary now
 *  fetches the runtime its build baked (`dist/electron.json`) into the
 *  per-user cache, once, and runs it from there — no npm, no deno, no cwd. */
export async function findElectronBin(
  log: Log,
  opts: FindElectronOpts = {},
): Promise<string | null> {
  // 1. ELECTRON_PATH env var (AppImage / custom deployment)
  const envPath = Deno.env.get("ELECTRON_PATH");
  if (envPath) {
    try {
      await Deno.stat(envPath);
      return envPath;
    } catch {
      log.error(`$ELECTRON_PATH set but not found: ${envPath}`);
    }
  }

  // 2. The runtime this package SHIPS, beside the executable.
  for (const cand of packagedElectronCandidates(opts.execPath)) {
    try {
      if ((await Deno.stat(cand)).isFile) return cand;
    } catch { /* not this layout */ }
  }

  // 3. node_modules dev binary
  const electronBin = Deno.build.os === "windows"
    ? "node_modules\\.bin\\electron.cmd"
    : "node_modules/.bin/electron";
  if (await electronBinReady(electronBin)) return electronBin;

  const compiled = opts.compiled ?? isCompiled();
  const denoInstall = opts.denoInstall ?? ((l: Log) => autoInstallElectron(l));
  const fetchRuntime = opts.fetchRuntime ??
    ((v: string, slug: string, l: Log) =>
      ensureElectronRuntime(v, slug, { log: l.info, warn: l.error }));

  // 4. Dev only — auto-install on first run: `deno install` FORCE-adds
  //    electron (positional `npm:electron`) so `deno task dev` works no matter
  //    what — even if the app never declared electron as a dep.
  //    `--allow-scripts=npm:electron` runs the postinstall that downloads the
  //    real binary. Loud progress. Skipped in a compiled binary: there is no
  //    deno to run and no project to install into.
  if (!compiled && await denoInstall(log)) {
    if (await electronBinReady(electronBin)) return electronBin;
  }

  // 5. The runtime Electron publishes, into the per-user cache. THE path for a
  //    compiled binary; the last resort for dev (offline npm, a proxy that
  //    blocks the lifecycle script — the zip may still be reachable).
  const version = (await bakedElectronVersion(opts.distDir)) ??
    DEFAULT_ELECTRON_VERSION;
  const slug = electronSlug();
  try {
    const dir = await fetchRuntime(version, slug, log);
    const bin = electronBinIn(dir);
    await Deno.stat(bin);
    return bin;
  } catch (e) {
    log.error(
      `Electron ${version} (${slug}) could not be fetched: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  log.error(
    compiled
      ? "Electron is not available on this machine and could not be " +
        "downloaded. Check the network (github.com/electron/electron " +
        "releases), or point $ELECTRON_PATH at an Electron you already have."
      : "Electron could not be installed automatically. Check your network, " +
        "then retry `deno task dev` — or run `deno task install:electron`, " +
        "which downloads the runtime directly (a bare `deno install` can " +
        "skip the lifecycle script and exit 0 with nothing installed)",
  );

  return null;
}

/** True when the electron launcher exists AND its real binary is downloaded.
 *  `.bin/electron` is created by `deno install` BEFORE the postinstall
 *  downloads the ~100MB binary, so the launcher can exist while the binary is
 *  still missing (a broken launch). We check the launcher resolves to a real
 *  electron dist binary via its `path.txt`. */
async function electronBinReady(launcher: string): Promise<boolean> {
  try {
    await Deno.stat(launcher);
  } catch {
    return false;
  }
  // Find the electron package dir the launcher points into and confirm the
  // downloaded binary exists (path.txt names it, inside dist/).
  // "no path.txt anywhere" and "path.txt present, the binary it names is
  // missing" used to be the same answer: both fell through to `return true`.
  // The second is precisely the broken install this check exists to catch —
  // reading an existing path.txt succeeds, so the outer catch never fires — and
  // returning true there handed back a launcher that cannot start Electron.
  let sawPathTxt = false;
  try {
    for (
      const base of [
        "node_modules/electron",
        ...(await denoElectronDirs()),
      ]
    ) {
      let rel: string;
      try {
        rel = (await Deno.readTextFile(`${base}/path.txt`)).trim();
      } catch {
        continue; // no manifest here — try the next candidate
      }
      sawPathTxt = true;
      try {
        await Deno.stat(`${base}/dist/${rel}`);
        return true; // real binary present
      } catch { /* named binary missing — keep looking, but remember */ }
    }
  } catch { /* fall through */ }
  // A path.txt existed and named a binary that is not there: the install is
  // broken, and saying so is the whole point of this function.
  if (sawPathTxt) return false;
  // No path.txt found at all (older layout) — trust the launcher's existence.
  return true;
}

/** Electron package dirs under Deno's `.deno` npm cache (node_modules/.deno/
 *  electron@<ver>/node_modules/electron). */
async function denoElectronDirs(root = "."): Promise<string[]> {
  const dirs: string[] = [];
  try {
    for await (const e of Deno.readDir(`${root}/node_modules/.deno`)) {
      if (e.isDirectory && e.name.startsWith("electron@")) {
        dirs.push(`${root}/node_modules/.deno/${e.name}/node_modules/electron`);
      }
    }
  } catch { /* no .deno dir */ }
  return dirs;
}

/** WHERE the installed Electron runtime actually is — `<pkg>/dist`, or null.
 *
 *  THE resolver, for the runtime and the build alike. It exists because there
 *  were two: this file has always known that Deno's node_modules layout puts
 *  the package under `node_modules/.deno/electron@<ver>/node_modules/electron`
 *  (with `node_modules/electron` sometimes a symlink and sometimes absent),
 *  while `build-electron.ts` checked `node_modules/electron/dist` and nothing
 *  else. So `deno task compile --electron` auto-installed Electron
 *  successfully, failed to find what it had just installed, and told the user
 *  to run `deno task install:electron` — which installs it to the same place
 *  the build would still not look. That is the bug a user reported as "the
 *  one-line command doesn't start the app; I had to run install:electron
 *  first", and it could only be fixed by making both sides read one rule. */
export async function electronDistDir(root = "."): Promise<string | null> {
  for (const base of await electronPkgDirs(root)) {
    try {
      const info = await Deno.stat(`${base}/dist`);
      if (info.isDirectory) return `${base}/dist`;
    } catch { /* not here — try the next layout */ }
  }
  return null;
}

/** Every place the electron PACKAGE itself may live (both node_modules
 *  layouts). `electronDistDir` and the installer recovery below read the same
 *  list, so "where is electron" has one answer. */
export async function electronPkgDirs(root = "."): Promise<string[]> {
  return [`${root}/node_modules/electron`, ...(await denoElectronDirs(root))];
}

/** Force-install electron in the app cwd so `dev:electron` / `compile:electron`
 *  work OUT OF THE BOX — even when the app didn't declare electron as a dep.
 *  The positional `npm:electron` adds + installs it; `--allow-scripts` runs its
 *  postinstall (downloads the binary). Returns true when the command succeeded.
 *  `run` is the command seam (injected in tests; real `deno install` here). */
export async function autoInstallElectron(
  log: { info?: (m: string) => void; error: (m: string) => void },
  run: () => Promise<{ success: boolean }> = () =>
    new Deno.Command(Deno.execPath(), {
      args: ["install", "--allow-scripts=npm:electron", "npm:electron"],
      stdout: "inherit",
      stderr: "inherit",
    }).output(),
  // "Is the runtime actually there?" — the ONLY question whose answer this
  // function may return. It used to return `run().success`, i.e. whether the
  // installer EXITED ZERO, and that is the defect: `deno install` exits zero
  // having skipped the lifecycle script, so a caller was told "installed" and
  // then could not find a binary. Injected so the contract can be tested
  // without a 100MB download.
  isInstalled: () => Promise<boolean> = () =>
    electronDistDir().then((d) => d !== null),
): Promise<boolean> {
  (log.info ?? console.log)(
    "electron: not installed — auto-installing (deno install --allow-scripts=npm:electron npm:electron)… " +
      "first run downloads the Electron binary (~100MB), this can take a minute.",
  );
  try {
    await run();
    if (await isInstalled()) return true;
    // The install "succeeded" and the runtime is NOT there.
    //
    // `--allow-scripts` only PERMITS the lifecycle script; whether it actually
    // RUNS depends on what deno already had cached and on whether the package
    // counts as newly added — conditions an app cannot see or control. When it
    // is skipped, `deno install` exits 0 with a package that has no `dist/`,
    // and every later step reports the confusing half of the truth: "electron
    // is not installed — run deno task install:electron", advice that runs the
    // same command and skips the same script. A user hit exactly that loop and
    // could only get out of it by accident.
    //
    // So run the package's OWN installer, which downloads and unpacks the
    // platform binary. It is CommonJS; `--unstable-detect-cjs` is what lets
    // deno load it. This is the step that makes `--target=electron` work on a
    // machine that has never seen Electron.
    for (const pkg of await electronPkgDirs()) {
      try {
        await Deno.stat(`${pkg}/install.js`);
      } catch {
        continue;
      }
      (log.info ?? console.log)(
        `electron: the lifecycle script did not run — invoking ${pkg}/install.js directly`,
      );
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--unstable-detect-cjs", "install.js"],
        cwd: pkg,
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      if (r.success && await isInstalled()) return true;
    }
    return await isInstalled();
  } catch {
    return false;
  }
}

/** Route the Electron child's stderr: renderer lines the shell tagged go to
 *  the framework logger at their level (so a page that throws lands in the
 *  app log and `am logs`, not only on a terminal nobody is watching); GPU
 *  device-probe noise is dropped and counted; everything else passes through
 *  untouched. The sorting is `classifyElectronLine` — pure, unit-tested. */
function forwardStderr(proc: Deno.ChildProcess): void {
  let dropped = 0;
  let reported = false;
  void (async () => {
    const enc = new TextEncoder();
    let carry = "";
    const route = async (line: string) => {
      const r = classifyElectronLine(line);
      switch (r.route) {
        case "drop":
          dropped++;
          // Say it once, so the lines are accounted for rather than vanished.
          if (!reported) {
            reported = true;
            await Deno.stderr.write(enc.encode(
              "[aio] suppressing GPU device-probe messages from Electron " +
                "(harmless: a GPU with no Mesa driver, probed and skipped)\n",
            )).catch(() => {});
          }
          return;
        case "error":
          log.error("renderer", r.text);
          return;
        case "warn":
          log.warn("renderer", r.text);
          return;
        case "info":
          log.info("renderer", r.text);
          return;
        case "raw":
          await Deno.stderr.write(enc.encode(r.text + "\n")).catch(() => {});
      }
    };
    try {
      for await (
        const chunk of proc.stderr.pipeThrough(new TextDecoderStream())
      ) {
        const lines = (carry + chunk).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) await route(line);
      }
      if (carry !== "") await route(carry);
    } catch { /* child gone — nothing left to forward */ }
    if (dropped > 0) {
      await Deno.stderr.write(enc.encode(
        `[aio] suppressed ${dropped} GPU device-probe line(s)\n`,
      )).catch(() => {});
    }
  })();
}

/** Can Chromium's SUID sandbox helper actually be used here?
 *
 *  Electron's `chrome-sandbox` must be owned by root with mode 4755. An
 *  npm/deno install cannot do that — it has no root — so the file lands
 *  unprivileged, and Chromium REFUSES TO START rather than run unsandboxed:
 *
 *    FATAL:setuid_sandbox_host.cc(166)] The SUID sandbox helper binary was
 *    found, but is not configured correctly …
 *    electron exited with signal SIGTRAP
 *
 *  Historically this did not bite, because Chromium falls back to the
 *  namespace sandbox when unprivileged user namespaces are allowed. Ubuntu
 *  24.04 (and every distro that followed it, Mint 22 included) restricts those
 *  by default — and every container does — so the fallback is gone and the
 *  default client of this framework simply does not start. A user hit exactly
 *  this and had to go find `deno task install:electron` themselves, which does
 *  not even address it.
 *
 *  So: when the helper is present but not setuid-root, we say so and start
 *  Electron with `--no-sandbox`. That is a real (small) reduction in isolation
 *  for a process that loads THIS APP'S OWN local UI, weighed against a
 *  framework whose default target cannot launch. It is announced every time,
 *  never silent, and `AIO_ELECTRON_SANDBOX=1` forces the strict behaviour for
 *  anyone who has configured the helper properly. */
export async function sandboxUsable(
  bin: string,
  stat: (p: string) => Promise<Deno.FileInfo> = Deno.stat,
): Promise<boolean> {
  if (Deno.build.os !== "linux") return true; // only Linux has this helper
  if (Deno.env.get("AIO_ELECTRON_SANDBOX") === "1") return true;
  const helper = bin.replace(/\/[^/]+$/, "/chrome-sandbox");
  try {
    const info = await stat(helper);
    // uid 0 AND the setuid bit — anything else and Chromium aborts.
    const setuid = ((info.mode ?? 0) & 0o4000) !== 0;
    return info.uid === 0 && setuid;
  } catch {
    // No helper at all: nothing to misconfigure, Chromium picks another
    // sandbox. Leave it alone.
    return true;
  }
}

/** Writes script to temp file, spawns Electron, cleans up after exit or process unload */
async function spawnElectron(
  bin: string,
  script: string,
  extraArgs: string[] = [],
): Promise<Deno.ChildProcess> {
  const tmpFile = await Deno.makeTempFile({ suffix: ".cjs" });
  await Deno.writeTextFile(tmpFile, script);
  const sandboxArgs: string[] = [];
  if (!(await sandboxUsable(bin))) {
    log.warn(
      "[aio] electron: chrome-sandbox is not setuid-root (an npm install " +
        "cannot make it so), and this kernel restricts unprivileged user " +
        "namespaces — Chromium would abort instead of starting. Launching " +
        "with --no-sandbox. To use the sandbox instead:\n" +
        `      sudo chown root:root ${
          bin.replace(/\/[^/]+$/, "/chrome-sandbox")
        } && sudo chmod 4755 ${bin.replace(/\/[^/]+$/, "/chrome-sandbox")}\n` +
        "      then set AIO_ELECTRON_SANDBOX=1",
    );
    sandboxArgs.push("--no-sandbox");
  }
  const proc = new Deno.Command(bin, {
    args: [tmpFile, ...sandboxArgs, ...extraArgs],
    // The window dies with this process — see tmplParentWatch. Merged into
    // the inherited environment, so the shim passes it through to Electron.
    env: { AIO_PARENT_PID: String(Deno.pid) },
    // stderr is PIPED so the graphics-stack probe noise can be kept out of the
    // app's own log (see forwardStderr). stdout stays inherited — that is the
    // app's own console output and must pass through untouched.
    stderr: "piped",
  }).spawn();
  forwardStderr(proc);
  const cleanup = () => Deno.remove(tmpFile).catch(() => {});
  // Primary cleanup: after Electron exits normally
  proc.status.then(cleanup);
  // Backup cleanup: covers SIGKILL / host process crash where proc.status never resolves
  addEventListener("unload", cleanup);
  proc.status.then(() => removeEventListener("unload", cleanup));
  return proc;
}

/** The Chromium switch that opens the DevTools Protocol — or nothing.
 *
 *  Pure, and the ONLY place the switch is spelled: `--cdp` is opt-in, so an
 *  app that did not ask must launch with an argv identical to before (a bound
 *  debugging port is a port, and "zero ports" is a promise). Chromium binds
 *  `--remote-debugging-port` to 127.0.0.1 only. */
export function cdpSwitches(port: number | undefined): string[] {
  return port ? [`--remote-debugging-port=${port}`] : [];
}

/** Spawns Electron with the main app script */
export async function launchElectron(
  url: string,
  log: Log,
  meta?: AioMeta,
  /** THE declaration for what reaches the generated main script. Read it as
   *  the one list: the call below is a mechanical passthrough (`...rest`), so
   *  a key added here is wired by the fact of being declared.
   *
   *  It used to be a hand-copied literal, and this is the same shape the
   *  config bridge documents dropping keys six times over
   *  (`TransportConfig`, aio-server.ts). It did it again here: the socket that
   *  lets a zero-port app serve its own page was declared, threaded through
   *  four files, and then quietly not copied into this object — so the window
   *  fell back to `http://localhost:<port>` and opened on
   *  ERR_CONNECTION_REFUSED, with nothing in the chain wrong except a missing
   *  line in a literal. */
  uds?: {
    socketPath: string;
    baseDir?: string;
    title?: string;
    hasCSS?: boolean;
    /** Dev icon dir — the server's resolved baseDir (WYSIDIWYSIP). */
    iconDir?: string;
    /** Base64 PNG used when the app ships no `icon.png`. */
    defaultIcon?: string;
    shell?: ShellConfig;
    /** The app's HTTP handler on a socket — set when it binds no TCP port. */
    httpSocketPath?: string;
    /** `AIO_ELECTRON_PROTOCOL=1`: dev window over aio:// (test what you ship). */
    forceProtocol?: boolean;
  },
  /** The dist/ carrying the baked Electron version (compiled binaries). */
  distDir?: string,
  /** `--cdp`: open the DevTools Protocol on this loopback port (`am shot`). */
  cdpPort?: number,
): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log, { distDir });
  if (!bin) return null;
  const mode = bin.includes("node_modules")
    ? "dev"
    : bin.includes(join("aio", "tools", "electron"))
    ? "fetched runtime"
    : bin.includes("dist")
    ? "packaged"
    : "$ELECTRON_PATH";
  const transport = uds ? "UDS" : "WS";
  log.info(
    `launching Electron (${mode}, ${transport}${
      cdpPort ? `, cdp 127.0.0.1:${cdpPort}` : ""
    })`,
  );
  // `childWindows` is served by the UDS shell's PRELOAD (`__aioIPC.openWindow`,
  // and the `<webview>` gate that rides with it). The WebSocket shell — taken
  // whenever the app has a TCP port (`--expose`, `--port=N`, `transport:
  // "ws"`) — has no preload, so `__aioIPC` is simply not there and the app's
  // own `openWindow` call dies in the renderer as `undefined is not an
  // object`, a long way from the config that caused it. Say it here, where the
  // decision is actually made.
  if (!uds && meta?.childWindows) {
    log.error(
      "childWindows: true, but this window is on the WebSocket transport " +
        "(this app has a TCP port), where the IPC preload that provides " +
        "`__aioIPC.openWindow` is not installed — openWindow and <webview> " +
        "will not work. Drop --expose/--port so the local window uses its " +
        'own socket, or set transport: "uds".',
    );
  }
  // Mechanical passthrough — `socketPath` is positional, everything else the
  // caller declared rides across untouched. Never re-list the keys here.
  const { socketPath: _sock, ...udsOpts } = uds ?? { socketPath: "" };
  const script = uds
    ? electronMainScriptUDS(url, uds.socketPath, { ...udsOpts, meta })
    : electronMainScript(url, meta);
  return spawnElectron(bin, script, cdpSwitches(cdpPort));
}

/** Launches Electron with the client connect-page script (no server needed) */
export async function launchElectronClient(
  log: Log,
  url?: string,
): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log);
  if (!bin) return null;
  const args = url ? [`--server-url=${url}`] : [];
  log.info(`launching aio client${url ? ` → ${url}` : ""}`);
  return spawnElectron(bin, electronClientScript(), args);
}
