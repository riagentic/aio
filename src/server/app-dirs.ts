// app-dirs.ts — ONE answer to "where does this app keep its files".
//
// Three tiers, and the only thing that distinguishes them is what a backup
// should contain:
//
//   ① critical   ~/.<appId>/data/     state, users, journal, keys, user files
//   ② expendable ~/.<appId>/logs|cache/ + launch.json  regenerable — delete freely
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

import { join, resolve } from "@std/path";
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

/** Create the directories an app needs. `data/` is 0700 because it holds the
 *  auth store and a TLS private key — consolidation put secrets next to
 *  innocuous state, so the mode has to assume the worst file in the tree. */
export function ensureAppDirs(dirs: AppDirs): void {
  Deno.mkdirSync(dirs.data, { recursive: true });
  Deno.mkdirSync(dirs.logs, { recursive: true });
  try {
    // Windows has no POSIX mode; chmod throws there.
    if (Deno.build.os !== "windows") Deno.chmodSync(dirs.data, 0o700);
  } catch { /* best-effort — a restrictive umask or FS may refuse */ }
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
