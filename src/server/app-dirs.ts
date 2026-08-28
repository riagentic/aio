// app-dirs.ts — ONE answer to "where does this app keep its files".
//
// Four tiers, and the only thing that distinguishes them is what a backup
// should contain:
//
//   ① critical   ~/.<appId>/data/     state, users, journal, keys, user files
//   ② expendable ~/.<appId>/logs|cache/ + launch.json  regenerable — delete freely
//   ②b payload   ~/.<appId>/app/      the unpacked binaries the app is RUNNING
//                                     from — regenerable, but not while it runs
//   ③ temporary  $XDG_RUNTIME_DIR/aio/    socket, pid, lock — must NOT survive a
//                                          reboot (see single-instance-lock.ts)
//
// "Back up ~/.<app>/data/" is therefore a complete, correct instruction that
// needs no tooling and no knowledge of what any individual file is. Everything
// outside `data/` is disposable by definition.
//
// Before this, an app's durable state was split four ways and differently in dev
// and prod: state in ./data.db (cwd), users in ~/.local/share/<appId>/auth.db,
// logs in ./.aio/log, certs in ./.aio-tls. Copying either location alone lost
// half the app, and the state file moved when you compiled.
//
// See docs/specs/2026-07-26-data-dir-and-updates.md.

import { basename, join, resolve } from "@std/path";
import { homedir } from "./paths.ts";

/** Two ways to answer "where does this app live", and one rule each:
 *
 *  • the AUTHOR names one app's folder — `aio.run({ appDir: "/opt/wallet" })`
 *  • whoever RUNS it names the root all apps sit under —
 *    `AIO_APPS_DIR=/srv/aio` → `/srv/aio/<appId>`
 *  • neither → `~/.<appId>`
 *
 *  The env var exists because the person who needs to move the data often cannot
 *  edit the code (they were handed a binary), and because a test suite spawns
 *  apps whose ids it doesn't control — one inherited variable covers them all.
 *
 *  There is deliberately no third "exact path for THIS app, by env" level: it
 *  held nothing `AIO_APPS_DIR=/var/lib` (→ `/var/lib/wallet`) doesn't, and a
 *  third spelling of the same idea is what made these names unreadable.
 *
 *  Note the dot only appears in the default: `~/.wallet` hides in a home
 *  directory, `/srv/aio/wallet` has no reason to hide. Dev and prod resolve
 *  identically, so "swap the binary, the data is untouched" holds with no
 *  asterisk. */
export function appHome(appId: string, configured?: string): string {
  if (configured) return configured;
  const root = Deno.env.get("AIO_APPS_DIR");
  if (root) return join(root, appId);
  return join(homedir(), `.${appId}`);
}

/** Every path an app writes, derived from one root. */
export type AppDirs = {
  /** `~/.<appId>` — the app's whole footprint. */
  home: string;
  /** ① `<home>/data` — THE backup unit. Critical + secret, mode 0700. */
  data: string;
  /** ② `<home>/cache` — regenerable bulk the APP writes: downloads, extracted
   *  sources, build trees, thumbnails. Deletable at any time; never in a backup.
   *
   *  Removed once, on the reasoning that the framework itself never writes here
   *  — the wrong question. The three-tier layout PROMISES an app somewhere to put
   *  regenerable bulk, and one app had 20 GB of it: without this field it either
   *  hand-computes `join(home, "cache")` (which it did) or, worse, puts the bulk
   *  in `data/` and doubles the size of every backup. The framework not writing a
   *  directory is not a reason to stop offering it. */
  cache: string;
  /** ②b `<home>/app` (mode 0700) — where a packaged app UNPACKS ITSELF: the
   *  `TMPDIR` every aio launcher hands to an AppImage, so both of the AppImage
   *  runtime's staging paths (`$TMPDIR/.mount_XXXXXX` for the FUSE mount,
   *  `$TMPDIR/appimage_extracted_<digest>` for the FUSE-less extract) land here
   *  instead of `/tmp`.
   *
   *  Not `cache/`, though it is equally regenerable: `cache/` promises "delete
   *  at any time", and deleting the tree a live process is executing from is not
   *  that. `app/` is regenerable-when-stopped.
   *
   *  The default `/tmp` was wrong on four counts, all measured on the runtime
   *  aio ships (`appimagetool` 1.9.1), not assumed:
   *
   *  • the extract path's directory name is a DIGEST OF THE APPIMAGE, not a
   *    mkdtemp random — so it is predictable to anyone on the host, in a
   *    world-writable directory. Planting a symlink at a name the extractor
   *    writes gets that write followed, as the launching user.
   *  • it is created 0755, so the unpacked app is world-READABLE (the FUSE
   *    mount is not — it is 0700 + user-only; only the extract path leaks).
   *  • the digest is per-FILE, not per-user, so a second user running the same
   *    AppImage collides with the first user's directory — and the runtime does
   *    not fail there. It warns ("could not create symlink"), EXITS 0, and runs
   *    whatever tree is already present. A silent partial extraction that then
   *    executes is the fail-loud violation that settled this.
   *  • `/tmp` is `noexec` on hardened hosts (the app simply won't start) and
   *    tmpfs on most distros (a ~200 MB Electron unpack goes to RAM), and
   *    tmp-cleaners delete underneath long-running apps.
   *
   *  Under `<home>/app` every one of those is structural rather than patched:
   *  the path is per-user by construction, ownership always matches, and an
   *  app's whole footprint stays one `rm -rf ~/.<appId>`. */
  app: string;
  /** ② `<home>/logs` — rotation-capped; excluded from a backup by default.
   *  Includes `stdout.log`, the raw stdout+stderr capture when `am`/`amui`
   *  launched the app (it used to be `<project>/.aio.log`, which split an app's
   *  logs between two directories for no reason). */
  logs: string;
  /** ① `<data>/state.db` — state + `db:` tables + the sync op-log. */
  stateDb: string;
  /** ① `<data>/auth.db` — users + sessions. SECRET. */
  authDb: string;
  /** ① `<data>/journal` — the durable action-journal FILE (`journal: true`). */
  journal: string;
  /** ① `<data>/tls` — self-signed cert + key. SECRET. */
  tls: string;
  /** ① `<data>/files` — app-written uploads. Bulk: symlink elsewhere if huge. */
  files: string;
  /** ① `<data>/app.key` — the persisted `key: true` access token. SECRET. */
  appKey: string;
  /** ① `<data>/meta.json` — appId + versions, so an archive is self-describing. */
  meta: string;
  /** ② `<home>/launch.json` — the flags `am` started this app with, so
   *  `am restart` can replay them. Per-app by nature (they are THIS app's
   *  flags), so it lives with the app rather than in a toolchain directory:
   *  "delete the app" stays one `rm -rf`, and there is no second root to
   *  relocate when sandboxing. NOT in `data/` — it is regenerable by relaunching. */
  launch: string;
};

// The EFFECTIVE dirs of every app booted in this process, keyed by appId.
//
// Without this, each caller recomputes the default — and any caller that doesn't
// know about an override (config.appDir, or the libraryMode default) resolves a
// DIFFERENT directory than the one the app is actually using. `app-key.ts` did
// exactly that: it wrote the key where aio.run() had put the data, but read it
// from `~/.<appId>`. One resolver has to mean one answer per app.
const _registered = new Map<string, AppDirs>();

/** Record the dirs an app actually booted with (aio.run(), once per app). */
export function registerAppDirs(appId: string, dirs: AppDirs): void {
  _registered.set(appId, dirs);
}

/** Forget every registration so a later boot resolves fresh. Exported from
 *  `aio/testing` for a test that pinned a fixture directory with
 *  `registerAppDirs()` and wants to release it.
 *  @internal */
export function _resetAppDirs(): void {
  _registered.clear();
}

/** Where a BUILT app is installed — the program, not its data.
 *
 *  `~/app/<name>/` by default (`AIO_INSTALL_ROOT` overrides): a plain
 *  directory a person can open, unlike `~/.<appId>/`, which is the app's own
 *  storage and stays hidden. The split is the point:
 *
 *    ~/app/<name>/       the artifact, its versions, its icon   ← replaceable
 *    ~/.<appId>/         state, logs, keys, user files          ← precious
 *
 *  so `am remove` can delete the first and leave the second, and an update can
 *  rewrite the first without ever touching the second.
 *
 *  THE decider: `run.sh` asks for this through
 *  `build.ts --print-install-root` rather than hardcoding `~/app`, and `am
 *  remove` and the updater read it directly. A shell copy of this rule is how
 *  an installer and an uninstaller come to disagree about where things are. */
export function installRoot(): string {
  const override = Deno.env.get("AIO_INSTALL_ROOT");
  if (override && override.trim()) return override;
  // Windows has its own convention and ignoring it makes an app look like it
  // was installed by a script that did not know where it was: user-scope
  // programs live under %LOCALAPPDATA%\Programs (what VS Code and friends
  // use), and that is where the Start Menu shortcut points.
  if (Deno.build.os === "windows") {
    const local = Deno.env.get("LOCALAPPDATA");
    if (local) return join(local, "Programs");
  }
  return join(homedir(), "app");
}

/** Every path `run.sh` creates when it installs `name`. Pure — the caller
 *  removes or inspects them; nothing here touches the filesystem. */
export function installedAppPaths(name: string): {
  dir: string;
  stable: string;
  desktop: string;
  binLink: string;
} {
  const dir = join(installRoot(), name);
  return {
    dir,
    stable: join(dir, name),
    desktop: join(
      homedir(),
      ".local",
      "share",
      "applications",
      `${name}.desktop`,
    ),
    binLink: join(homedir(), ".local", "bin", name),
  };
}

/** Compute (do not create) every path for `appId`.
 *
 *  With no explicit `configured`, a booted app's REGISTERED dirs win — so every
 *  module in the process (auth store, app key, profile export, `am` helpers)
 *  agrees with what `aio.run()` resolved. Falls back to the default rule for a
 *  separate process (`am` inspecting an app it did not boot). */
export function appDirs(appId: string, configured?: string): AppDirs {
  if (!configured) {
    const reg = _registered.get(appId);
    if (reg) return reg;
  }
  const home = appHome(appId, configured);
  const data = join(home, "data");
  return {
    home,
    data,
    cache: join(home, "cache"),
    app: join(home, "app"),
    logs: join(home, "logs"),
    stateDb: join(data, "state.db"),
    authDb: join(data, "auth.db"),
    journal: join(data, "journal"),
    tls: join(data, "tls"),
    files: join(data, "files"),
    appKey: join(data, "app.key"),
    meta: join(data, "meta.json"),
    launch: join(home, "launch.json"),
  };
}

/** THE rule for one app's directories, in one place.
 *
 *  `libraryMode` means a test or a host app owns the process. Such an app must
 *  not write into the user's home, so its data lands under `baseDir` — which
 *  tests already point at a temp dir. Everything else resolves normally.
 *
 *  Both boot entries call this, and both then `registerAppDirs()`, so a module
 *  that later asks `appDirs(appId)` with no override gets the same answer. When
 *  this rule lived only in the inner boot, the logger — initialised earlier —
 *  resolved the default instead and wrote a libraryMode app's logs to
 *  `~/.<appId>/logs`, i.e. exactly the place libraryMode exists to avoid. */
export function resolveAppDirs(opts: {
  appId: string;
  appDir?: string;
  libraryMode?: boolean;
  baseDir?: string;
}): AppDirs {
  const { appId, appDir, libraryMode, baseDir } = opts;
  return appDirs(
    appId,
    appDir ??
      (libraryMode ? join(resolve(baseDir ?? Deno.cwd()), ".aio") : undefined),
  );
}

/** Create the directories an app needs, each locked to its owner.
 *
 *  `data/` is 0700 because it holds the auth store and a TLS private key —
 *  consolidation put secrets next to innocuous state, so the mode has to
 *  assume the worst file in the tree.
 *
 *  `logs/` gets the same treatment, and so does `home` above them, because
 *  "the worst file in the tree" applies there too: the boot banner writes the
 *  share link (`share: …?token=<app key>`) into the app log, an app log carries
 *  whatever an app chose to log, and both directories were left at the umask —
 *  0775 on a stock Ubuntu, i.e. every local account could read a live
 *  credential. The mode of a directory is decided by what it can ever hold,
 *  never by what today's file happens to be. */
export function ensureAppDirs(dirs: AppDirs): void {
  Deno.mkdirSync(dirs.home, { recursive: true });
  Deno.mkdirSync(dirs.data, { recursive: true });
  Deno.mkdirSync(dirs.logs, { recursive: true });
  if (Deno.build.os === "windows") return; // no POSIX mode; chmod throws
  for (const dir of [dirs.home, dirs.data, dirs.logs]) {
    try {
      Deno.chmodSync(dir, 0o700);
    } catch { /* best-effort — a restrictive umask or FS may refuse */ }
  }
}

/** Create `<home>/app` and lock it to its owner. Returns the path.
 *
 *  The 0700 is the point, not a detail: `$HOME` itself is 0755 on most distros,
 *  so moving an unpack out of `/tmp` without narrowing the mode swaps one
 *  world-readable location for another and fixes nothing. */
export function ensureAppPayloadDir(dirs: AppDirs): string {
  Deno.mkdirSync(dirs.app, { recursive: true });
  try {
    // Windows has no POSIX mode; chmod throws there.
    if (Deno.build.os !== "windows") Deno.chmodSync(dirs.app, 0o700);
  } catch { /* best-effort — a restrictive umask or FS may refuse */ }
  return dirs.app;
}

/** Remove the empty `.mount_XXXXXX` stubs a crashed AppImage leaves behind.
 *
 *  `/tmp` cleaned these for us; `<home>/app` does not, and that is the one real
 *  cost of the move — so it is paid here rather than left to grow.
 *
 *  Non-recursive `removeSync` BY DESIGN: it succeeds only on an EMPTY directory,
 *  so a still-mounted squashfs or a live extraction is refused by the kernel
 *  instead of by a heuristic of ours guessing which sibling instance is alive.
 *  Extracted trees are deliberately never collected — they are the warm-start
 *  cache, and another process may be executing one right now. */
export function sweepAppPayloadDir(dirs: AppDirs): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dirs.app)];
  } catch {
    return; // no payload dir — nothing was ever unpacked here
  }
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name.startsWith(".mount_")) continue;
    try {
      Deno.removeSync(join(dirs.app, entry.name));
    } catch { /* mounted, or another instance is using it — leave it */ }
  }
}

/** THE rule for "this app unpacked itself somewhere other users can reach",
 *  pure so it is testable without building an AppImage.
 *
 *  Only a packaged app can be in this state (`appImage` is the runtime's
 *  `$APPIMAGE`), and only when its unpack root (`$APPDIR`) sits outside the
 *  app's own payload dir AND under a world-writable parent — the `/tmp` shape.
 *  A deliberate `TMPDIR=/srv/apps` is not world-writable and draws no warning:
 *  the hazard is the shared directory, not the disagreement with our default.
 *
 *  Observe-only by contract — identical in dev and prod. The app runs either
 *  way; what it must not do is run there SILENTLY. */
export function unsafeUnpackWarning(opts: {
  appImage?: string;
  appDir?: string;
  expected: string;
  parentWorldWritable: boolean;
}): string | null {
  const { appImage, appDir, expected, parentWorldWritable } = opts;
  if (!appImage || !appDir) return null;
  if (resolve(appDir) === resolve(expected)) return null;
  if (resolve(appDir).startsWith(resolve(expected) + "/")) return null;
  if (!parentWorldWritable) return null;
  return `this AppImage unpacked itself into ${appDir}, inside a ` +
    `world-writable directory — other users on this host can read it, and ` +
    `(on the FUSE-less extract path) the directory name is a predictable ` +
    `digest they can create first. Launch it as: ` +
    `TMPDIR=${expected} ${appImage}   (aio's own launchers do this)`;
}

/** `unsafeUnpackWarning` against the live environment. Returns the message, or
 *  null when the app is not packaged / already unpacks somewhere private. */
export function checkUnpackLocation(dirs: AppDirs): string | null {
  const appDir = Deno.env.get("APPDIR");
  let parentWorldWritable = false;
  if (appDir) {
    try {
      const mode = Deno.statSync(join(appDir, "..")).mode;
      parentWorldWritable = mode !== null && (mode & 0o002) !== 0;
    } catch { /* unreadable parent — cannot claim it is world-writable */ }
  }
  return unsafeUnpackWarning({
    appImage: Deno.env.get("APPIMAGE"),
    appDir,
    expected: dirs.app,
    parentWorldWritable,
  });
}

/** What `meta.json` records: enough for `am restore` to refuse the wrong archive
 *  and to warn when a backup is newer than the binary reading it. */
export type AppMeta = {
  appId: string;
  /** The aio version that last wrote this directory. */
  aio: string;
  /** App version (`config.appVersion`) when known. */
  app?: string;
  createdAt: string;
  updatedAt: string;
};

/** Write/refresh `meta.json`. Best-effort: a read-only home must never fail a
 *  boot — the app runs fine without it, only `am restore` loses a safety check. */
export function writeAppMeta(
  dirs: AppDirs,
  info: { appId: string; aio: string; app?: string },
): void {
  try {
    const now = new Date().toISOString();
    let createdAt = now;
    try {
      const prev = JSON.parse(Deno.readTextFileSync(dirs.meta)) as AppMeta;
      if (typeof prev.createdAt === "string") createdAt = prev.createdAt;
    } catch { /* first write, or unreadable — treat as new */ }
    const meta: AppMeta = { ...info, createdAt, updatedAt: now };
    Deno.writeTextFileSync(dirs.meta, JSON.stringify(meta, null, 2) + "\n");
  } catch { /* best-effort by design */ }
}

// ── The workspace share ──────────────────────────────────────────────────────
//
// Two apps in one repository want one `shared/` — pure modules, a type
// package, a stylesheet. Browser-reachable imports may not leave the app root
// (it is an HTTP root, and a symlink out of it is refused — correctly), so a
// field app generated `client/src/shared/` by copy and policed it with a test.
//
// `"share": ["../shared"]` in deno.json is the sanctioned spelling. ONE fact,
// read by both worlds: the DEV server serves each share at `/<basename>/…`
// and the BUNDLER resolves the same `/<basename>/…` import to the directory,
// so a single import spelling works everywhere. The declaration is validated
// ONCE, here, and refused loudly: a share that does not exist, or that leaves
// the repository, is a config error, not a 404 at the first import.
//
// What it is NOT: a way to serve arbitrary directories. Never the control
// plane (the trojan and `/__aio/*` never touch a static root), never a
// symlink escape (every containment guard baseDir has applies to a share
// unchanged), never outside the repository root.

export type ShareRoot = {
  /** The URL prefix both worlds use — `/<basename of dir>`. */
  prefix: string;
  /** The absolute, real directory. */
  dir: string;
  /** As written in deno.json, for messages. */
  declared: string;
};

/** The repository root `root` belongs to: the nearest ancestor holding
 *  `.git`, else `root` itself (a project that is not a checkout has no wider
 *  boundary than its own directory). */
export function repoRootOf(
  root: string,
  exists: (p: string) => boolean = existsSyncSafe,
): string {
  let dir = resolve(root);
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, ".git"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return resolve(root);
}

function existsSyncSafe(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve and validate deno.json `share`. Pure given its probes; throws an
 *  Error whose message names the entry, the resolved path and the fix.
 *
 *  `root` is the directory of the deno.json the entries are written in. */
export function resolveShare(
  root: string,
  raw: unknown,
  probe: {
    isDirectory?: (p: string) => boolean;
    realPath?: (p: string) => string;
    repoRoot?: string;
  } = {},
): ShareRoot[] {
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) || raw.some((e) => typeof e !== "string" || !e.trim())
  ) {
    throw new Error(
      `deno.json "share" must be an array of directory paths, relative to ` +
        `deno.json — e.g. "share": ["../shared"] (got ${JSON.stringify(raw)})`,
    );
  }
  const isDirectory = probe.isDirectory ?? ((p: string) => {
    try {
      return Deno.statSync(p).isDirectory;
    } catch {
      return false;
    }
  });
  const realPath = probe.realPath ?? ((p: string) => Deno.realPathSync(p));
  const repo = realPath(probe.repoRoot ?? repoRootOf(root));
  const repoPfx = repo.endsWith("/") ? repo : repo + "/";
  const out: ShareRoot[] = [];
  for (const declared of raw as string[]) {
    const abs = resolve(root, declared);
    if (!isDirectory(abs)) {
      throw new Error(
        `deno.json "share": "${declared}" is not a directory (resolved to ` +
          `${abs}). A share is a directory the app imports from as ` +
          `"/${basename(abs)}/…"; fix the path, or remove the entry.`,
      );
    }
    const real = realPath(abs);
    if (real !== repo && !real.startsWith(repoPfx)) {
      throw new Error(
        `deno.json "share": "${declared}" resolves to ${real}, OUTSIDE the ` +
          `repository root ${repo}. A share may only point inside the ` +
          `repository (through a symlink or not); move the directory in, or ` +
          `vendor it.`,
      );
    }
    const prefix = "/" + basename(abs);
    const dup = out.find((s) => s.prefix === prefix);
    if (dup) {
      throw new Error(
        `deno.json "share": "${declared}" and "${dup.declared}" would both ` +
          `be served as "${prefix}/…" — a share is addressed by its ` +
          `directory name, so two shares need two names.`,
      );
    }
    out.push({ prefix, dir: real, declared });
  }
  return out;
}

/** Which share, if any, an import or URL path belongs to, and the path
 *  inside it. Pure. `/shared/x.ts` → `{ share, rel: "x.ts" }`. */
export function matchShare(
  shares: readonly ShareRoot[],
  path: string,
): { share: ShareRoot; rel: string } | null {
  for (const share of shares) {
    if (path === share.prefix) return { share, rel: "" };
    if (path.startsWith(share.prefix + "/")) {
      return { share, rel: path.slice(share.prefix.length + 1) };
    }
  }
  return null;
}
