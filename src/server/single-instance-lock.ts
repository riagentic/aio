// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import { dirname, join, resolve } from "@std/path";
import { privateDirRefusal, selfUid } from "./dir-permissions.ts";
import { connectLocal } from "./local-listen.ts";
import { appDirs, appHome } from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import { EXIT_WAIT_MS } from "./shutdown-budget.ts";
import { readDenoJsonSync } from "./deno-json.ts";

/** How long a lock may sit at `status:"starting"` before anyone — the next
 *  launch's zombie probe, `am start` — may treat "its listener does not answer"
 *  as "it is stuck". THE one decider: `am` used to have none, probed the port
 *  the placeholder lock carried (0, when the app had not declared one) and
 *  killed every app that was still booting. */
export const STARTUP_GRACE_MS = 10_000;

// ── Types ────────────────────────────────────────────────────

/** Unified lock file — replaces both .aio.lock and .aio.pid */
export type LockData = {
  appId: string; // canonical unique identity
  pid: number; // OS process ID
  port: number; // HTTP server port
  startedAt: number; // epoch ms
  status: "starting" | "started" | "stopping";
  cwd: string; // working directory (for am/instances display)
  /** The resolved data home this instance runs from. Part of the lock's
   *  IDENTITY (see {@linkcode lockKey}): two boots of one appId from two homes
   *  are two apps, not a duplicate. Optional only for locks written before
   *  alpha66 — a missing value means the default home. */
  home?: string;
  socketPath?: string; // UDS socket path (when using UDS transport)
  trojanPort?: number; // plain-HTTP control port (when TLS active)
  // LAN-discovery metadata — present only for --expose'd apps, so any
  // discovery responder on the host can report EVERY exposed app (not just
  // itself) by reading the lock dir. See src/server/discovery.ts.
  discovery?: { title?: string; tls: boolean; needsAuth: boolean };
  /** The aio VERSION the instance runs — so `am instances` can say which
   *  framework each process is on, and mark one that differs from the `am`
   *  reading it (two checkouts on one machine is the normal dev setup, and
   *  a mismatch is the first thing to rule out). Absent on locks written
   *  before alpha68. */
  aioVersion?: string;
  /** Chrome DevTools Protocol port of the instance's desktop window, when
   *  one is open and debuggable. Reserved: written as undefined for now. */
  cdpPort?: number;
  /** The CLIENT this instance runs — "electron" | "browser" | "cli" |
   *  "server-only". Only an electron app has a WINDOW, and `am shot` had no
   *  way to know that: it told the operator of a browser app to restart with
   *  `--cdp`, which for a browser app either is refused or records a port
   *  nothing will ever listen on. Absent on locks written before alpha76. */
  client?: string;
  /** A kernel stamp that changes when a pid is REUSED — see
   *  {@linkcode processStartToken}.
   *
   *  A pid on its own is not an identity. This lock file outlives a reboot
   *  whenever `XDG_RUNTIME_DIR` is unset (the base is then `/tmp`, which
   *  Debian and Ubuntu do NOT clear at boot — contradicting
   *  `docs/persistence/where-files-live.md:34`), and pids wrap. So every kill
   *  site — `am stop`, `killProcess`, `acquire(killExisting)`, the parent
   *  watch, `am kill --stale` — was one recycled pid away from SIGTERMing an
   *  unrelated program of the user's, on the strength of a number in a file.
   *  Written when the lock is created; absent on locks written before
   *  alpha69 and on platforms that cannot report it, where the pid alone is
   *  all there is. */
  startToken?: string;
};

/** What a boot records about itself beyond identity — see {@linkcode LockData}. */
export type LockMeta = {
  aioVersion?: string;
  cdpPort?: number;
  client?: string;
};

/** Instance info returned by instances() — lock data + liveness */
export type InstanceInfo = LockData & { alive: boolean };

/** What to do when another instance of the same app is already running */
export type SingletonMode = boolean;
// true = refuse if running (default)
// false = allow multiple instances

// ── App ID Resolution ────────────────────────────────────────

/** Slugify a string for filesystem use — THE transform.
 *
 *  One fact with four copies before this: the appId slug names the lock file,
 *  the data directory, the UDS socket AND the shared-key cookie, and the same
 *  expression was written out in `build-helpers` (binary names),
 *  `electron-shared` (the userData path) and `server.ts` (the cookie). They
 *  agreed, which is the dangerous state: changing the appId rule in one place
 *  would leave two apps whose ids differ only in punctuation sharing a cookie
 *  while holding separate locks — a credential crossing between apps, from an
 *  edit that looked local.
 *
 *  The FALLBACK stays a caller's choice, because it genuinely is one: a lock
 *  with no id is `aio-app`, a nameless binary is `myapp`, a cookie is `app`. */
export function slugify(s: string, fallback = "aio-app"): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    fallback;
}

/** The identity fields of a project's `deno.json`, in the ONE order that decides
 *  an app's id. Null when the file names none of them.
 *
 *  Shared with the BUILD (`build-config.ts` names the binary with it) because a
 *  compiled app takes its identity from its own filename — so the build's
 *  naming rule and this chain are the same decision seen from two sides. They
 *  used to be two: the build read `title ?? basename(root)` and ignored `appId`
 *  outright, so a `deno.json` with `appId: "wallet"` in a directory called
 *  `thing` was `~/.wallet` in dev and `~/.thing` once compiled. The data
 *  directory MOVED when you compiled — the one asterisk `app-dirs.ts` promises
 *  it does not have. */
export function appIdFromConfig(
  cfg: { appId?: string; title?: string; name?: string } | null | undefined,
): string | null {
  const raw = cfg?.appId ?? cfg?.title ?? cfg?.name?.split("/").pop();
  return raw ? slugify(raw) : null;
}

/** The deno.json that travels INSIDE a compiled binary, next to its entry.
 *  Read relative to `Deno.mainModule` (the VFS), never the launch directory —
 *  the same lookup `appDenoJson()` uses for the version in the boot banner.
 *  Kept local so this module stays free of a server-side import cycle. */
function _embeddedDenoJson(): unknown {
  try {
    const main = new URL(Deno.mainModule);
    for (const up of ["./", "../", "../../"]) {
      try {
        const text = Deno.readTextFileSync(new URL(`${up}deno.json`, main));
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* not at this level — walk up */ }
    }
  } catch { /* no usable main module */ }
  return null;
}

/** Resolve app ID — explicit `appId` wins; otherwise inferred. */
export function resolveAppId(appId?: string): string {
  if (appId) return slugify(appId);
  // Compiled binaries: NEVER read the cwd's deno.json — the binary may be
  // launched from an unrelated project and must not adopt ITS identity
  // (locks, KV paths). The VFS path carries the binary name — stable per
  // binary regardless of launch directory.
  try {
    const main = new URL(Deno.mainModule);
    const compiledSeg = main.pathname.split("/").find((p) =>
      p.startsWith("deno-compile-")
    );
    if (compiledSeg) {
      // The VFS segment is named after the EXECUTABLE FILE, at runtime — so
      // renaming the binary renames the app. That is not a theoretical
      // objection: installing it as `<name>-<version>` (which is how versioned
      // installs and rollbacks work) gave the app the id `name-1-0-0`, and its
      // data directory moved with it. Every upgrade would then start from an
      // empty `~/.<name>-<newversion>/` while the real state sat in the old
      // one — silent, and exactly the kind of loss `~/.<appId>` exists to
      // prevent. `mv app app.bak` would do the same.
      //
      // The binary EMBEDS its deno.json (that is where the version in the boot
      // banner comes from), so the app's declared identity travels inside it
      // and does not depend on what the file is called. This still never reads
      // the CWD's deno.json — the rule that matters here is "not the launch
      // directory's identity", and an embedded file is the binary's own.
      const embedded = appIdFromConfig(
        _embeddedDenoJson() as
          | { appId?: string; title?: string; name?: string }
          | null,
      );
      if (embedded) return embedded;
      return slugify(compiledSeg.slice("deno-compile-".length));
    }
  } catch { /* no main module — fall through */ }
  // Zero-config inference (dev): deno.json appId > title > name (unscoped) —
  // then the main module's directory name (its parent when the entry sits in
  // src/). Deterministic per project, so locks/KV/socket identity is stable.
  try {
    // THE reader — JSONC-aware. `JSON.parse` here threw on a deno.json with a
    // comment in it, and the catch below inferred the app id from the
    // directory name instead: a different id, a different data dir, an
    // app that "lost" its data by adding a comment to its config.
    const cfg = readDenoJsonSync(Deno.cwd())?.config as
      | { appId?: string; title?: string; name?: string }
      | undefined;
    const fromCfg = cfg ? appIdFromConfig(cfg) : undefined;
    if (fromCfg) return fromCfg;
  } catch { /* no deno.json — fall through */ }
  try {
    const main = new URL(Deno.mainModule);
    if (main.protocol === "file:") {
      const parts = main.pathname.split("/").filter(Boolean);
      parts.pop(); // the entry file itself
      const dir = parts.pop();
      const name = dir === "src" ? parts.pop() : dir;
      if (name) return slugify(name);
    }
  } catch { /* unusual entry */ }
  throw new Error(
    '[aio] cannot infer an appId — add appId: "my-app" to aio.run() or ' +
      'an "appId"/"title" field to deno.json',
  );
}

// ── Lock File Paths ──────────────────────────────────────────

/** Directory for lock + socket files — /tmp/aio/ (or $XDG_RUNTIME_DIR/aio/ on Linux) */
let _lockDir: string | null = null;
let _lockDirKey: string | null = null;
export function lockDir(): string {
  // AIO_APPS_DIR relocates the apps' DATA root — the lock/socket dir scopes
  // with it, so ONE env var isolates an instance completely. A temp $HOME
  // alone used to isolate state but NOT the lock: a sandboxed e2e died on
  // "already running", and its `am` silently reached the production instance
  // (a field report). Must-not-survive-reboot still holds — the
  // base stays $XDG_RUNTIME_DIR//tmp either way.
  const appsRoot = Deno.env.get("AIO_APPS_DIR") ?? "";
  if (_lockDir && _lockDirKey === appsRoot) return _lockDir;
  const base = Deno.build.os === "windows"
    ? (Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp")
    : (Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp");
  const scope = appsRoot
    ? "-" + appsRoot.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(-48)
    : "";
  _lockDirKey = appsRoot;
  _lockDir = _chooseLockDir(base, scope);
  return _lockDir;
}

/** Create `dir` 0700 and say why it still cannot hold a control socket.
 *
 *  The 0700 is NOT tidiness: the base is `$XDG_RUNTIME_DIR` (already 0700, so
 *  the chmod is a no-op) OR `/tmp` when that is unset — containers,
 *  no-systemd hosts, plain ssh. There the default 0755 left every app's
 *  control socket at a predictable path any local user could traverse to and
 *  connect to, i.e. dispatch methods into someone else's app.
 *
 *  It used to stop at the chmod and swallow the failure, which is the half
 *  that does not hold: chmod on a directory you do not own returns EPERM, so
 *  a `/tmp/aio` somebody else created — at 0777, or at 0700 as themselves —
 *  was then used exactly as if the chmod had worked. Create, narrow, and then
 *  LOOK. */
export function _prepareLockDir(
  dir: string,
  // A seam, because the case that matters cannot be built in a test: chmod
  // fails with EPERM only on a directory owned by ANOTHER account, and a test
  // has exactly one uid. Injecting the chmod reproduces it exactly — the same
  // branch, for the same reason — instead of leaving the wiring unproven and
  // the pure rule tested in isolation. @internal
  ops: {
    chmod?: (path: string, mode: number) => void;
    stat?: (path: string) => Deno.FileInfo;
  } = {},
): string | null {
  const chmod = ops.chmod ?? Deno.chmodSync;
  const stat = ops.stat ?? Deno.statSync;
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch { /* already exists — the stat below is the real check */ }
  try {
    if (Deno.build.os !== "windows") chmod(dir, 0o700);
  } catch { /* not ours to chmod — precisely what the stat is for */ }
  if (Deno.build.os === "windows") return null; // no POSIX mode to read
  let st: Deno.FileInfo;
  try {
    st = stat(dir);
  } catch (e) {
    return `${dir} cannot be created or read (${
      e instanceof Error ? e.message : e
    })`;
  }
  if (!st.isDirectory) return `${dir} exists and is not a directory`;
  return privateDirRefusal(dir, st.mode, st.uid);
}

/** The lock/socket directory this process may actually use.
 *
 *  Shared `<base>/aio` first — one directory per machine keeps `am` able to
 *  see every app of THIS user. When that one belongs to somebody else, a
 *  uid-scoped sibling is used instead: it is the same isolation the shared
 *  directory was supposed to provide, and it also fixes the case that was
 *  merely broken rather than unsafe — a second user on a host with no
 *  `$XDG_RUNTIME_DIR` could not bind in the first user's 0700 directory and
 *  got an unexplained bind failure.
 *
 *  If the fallback is unusable too, that is not a configuration this can paper
 *  over, and a control socket is not something to place hopefully. */
function _chooseLockDir(base: string, scope: string): string {
  const preferred = join(base, "aio" + scope);
  const first = _prepareLockDir(preferred);
  if (first === null) return preferred;
  const uid = selfUid();
  if (uid === null) {
    throw new Error(
      `aio: ${first}, and this process cannot read its own uid to pick a ` +
        `private directory instead. Set XDG_RUNTIME_DIR to a directory you ` +
        `own, or grant --allow-sys.`,
    );
  }
  const scoped = join(base, `aio-u${uid}${scope}`);
  const second = _prepareLockDir(scoped);
  if (second === null) {
    log.warn(
      `${first} — using ${scoped} for this app's lock and control socket ` +
        `instead. Other users' aio apps are not visible to \`am\` from here.`,
    );
    return scoped;
  }
  throw new Error(
    `aio: refusing to place a control socket where another local user can ` +
      `reach it. ${first}; the private fallback failed too: ${second}. ` +
      `A control socket lets whoever connects dispatch methods into this app. ` +
      `Fix: remove or chmod 700 the directory named above, or set ` +
      `XDG_RUNTIME_DIR to a directory you own.`,
  );
}

/** Remove the per-`AIO_APPS_DIR` lock dir when it is empty — called at the
 *  very end of an app's shutdown. The default dir (`…/aio`) is never removed;
 *  it is shared by every app on the machine and costs nothing. A scoped one
 *  belongs to a temp home that is about to be deleted, and used to outlive it
 *  forever. Non-recursive on purpose: another app's lock or a live watcher
 *  sentinel makes the rmdir fail, which is the right answer. */
export function pruneLockDir(): void {
  if (!_lockDir || !Deno.env.get("AIO_APPS_DIR")) return;
  try {
    Deno.removeSync(_lockDir);
    // The path is still right; only the directory is gone. Forget the cached
    // answer so the next `lockDir()` call re-creates it (a later app in this
    // same process — every sequential test — must not write into a void).
    _lockDir = null;
    _lockDirKey = null;
  } catch { /* not empty, or already gone — either way not ours to force */ }
}

/** 8 hex chars of FNV-1a over `s` — a filename-safe tag, not a secret. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** THE key a lock (and its sockets) is filed under: `<appId>` when the app runs
 *  from its default home, `<appId>@<hash8(home)>` otherwise.
 *
 *  The lock used to be keyed by appId alone, so an app booted a second time
 *  ON PURPOSE from an isolated home (`--<app>-home=/tmp/x` for a smoke test or
 *  a screenshot harness) was refused as a duplicate — and the refusal named
 *  the USER's port and pid, which is how a harness came to `kill` the user's
 *  running wallet (a field report, §2.1). Identity is appId AND home: one
 *  data dir, one instance. The default home keeps the plain name, so nothing
 *  already running or already written needs migrating. */
export function lockKey(appId: string, home?: string): string {
  if (!home) return appId;
  const want = resolve(home);
  if (want === resolve(appHome(appId))) return appId;
  return `${appId}@${hash8(want)}`;
}

/** The two halves of a lock key / lock file name. */
export function parseLockKey(key: string): { appId: string; tag?: string } {
  const at = key.lastIndexOf("@");
  return at > 0
    ? { appId: key.slice(0, at), tag: key.slice(at + 1) }
    : { appId: key };
}

/** The key of the lock THIS process holds for `appId`, else the plain appId.
 *  The socket paths (`paths.ts`) are named by it, so an instance's control
 *  socket follows its lock: `am --home=<dir>` reads that lock and finds that
 *  socket, never the default instance's. */
export function heldLockKey(appId: string): string {
  for (const l of AppLock.live()) if (l.appId === appId) return l.key;
  return appId;
}

/** Full path to the lock file for a given lock key (see {@linkcode lockKey}) */
export function lockPath(key: string): string {
  return join(lockDir(), `${key}.lock`);
}

// ── Launch-info sidecar (am restart flag preservation) ───────
// The running app can't recover deno-runtime flags (e.g. --env-file) from its
// own Deno.args — only the launcher (am) knows them. am records them here at
// start so `am restart` can replay the exact launch; am-owned, the app's _run()
// never touches it. (a field report: restart dropped --env-file, so
// the vault silently stopped auto-unlocking.)
export type LaunchInfo = { flags: string[]; entry?: string; cwd?: string };

/** Path to am's launch-info sidecar: `~/.<appId>/launch.json`.
 *
 *  Two things this is NOT, both learned the hard way:
 *
 *  • not the runtime dir — a launch record has to outlive the machine (`am start`
 *    in the morning, reboot, `am restart` in the afternoon must still replay
 *    `--env-file`). `$XDG_RUNTIME_DIR` is cleared on logout BY DESIGN, which is
 *    exactly right for the lock and socket and exactly wrong for this.
 *  • not a shared toolchain directory — these are THIS app's flags, so keeping
 *    them with the app means "delete the app" is one `rm -rf` and there is no
 *    second root to relocate when sandboxing. */
export function launchInfoPath(appId: string): string {
  return appDirs(appId).launch;
}

/** Pre-alpha38: the record lived in the runtime dir, so it vanished on logout. */
function legacyLaunchPath(appId: string): string {
  return join(lockDir(), `${appId}.launch.json`);
}

/** Record the flags am launched an app with (best-effort). */
export function writeLaunchInfo(appId: string, info: LaunchInfo): void {
  try {
    const path = launchInfoPath(appId);
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(info));
  } catch { /* best-effort — restart falls back to a warning */ }
}

/** Read the recorded launch info, or null if none/corrupt. */
export function readLaunchInfo(appId: string): LaunchInfo | null {
  // The pre-alpha38 runtime-dir location is still read, so an app already
  // running when aio was upgraded can still be restarted with its flags.
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      const info = JSON.parse(Deno.readTextFileSync(path)) as LaunchInfo;
      if (Array.isArray(info.flags)) return info;
    } catch { /* next */ }
  }
  return null;
}

/** Remove the launch sidecar (on a clean stop) — both locations. */
export function removeLaunchInfo(appId: string): void {
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  }
}

// ── Process Liveness ─────────────────────────────────────────

/** Check if a process is alive via signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid EXISTS but belongs to another user — that process
    // is alive. Conflating it with ESRCH ("no such process") made every
    // liveness guard (backup/restore live-writer refusal, lock takeover)
    // treat an app running under a different account as stopped.
    return e instanceof Deno.errors.PermissionDenied;
  }
}

/** A stamp the KERNEL controls that changes when a pid is recycled, or null
 *  when this platform cannot say.
 *
 *  Linux: field 22 of `/proc/<pid>/stat` — the process's start time in clock
 *  ticks since boot. (Field 2, `comm`, may contain spaces and parentheses, so
 *  it is cut at the LAST `)` before splitting — a bug every naive parse of
 *  this file has.) macOS: `ps -o lstart=`, second resolution, which is enough:
 *  a pid that wrapped all the way around inside one second is not the case
 *  this guards.
 *
 *  Pure read, no signal, no side effect. Returns null (rather than throwing)
 *  for a pid that is gone — the caller's liveness check owns that answer. */
export function processStartToken(pid: number): string | null {
  if (!(pid > 0)) return null;
  try {
    if (Deno.build.os === "linux") {
      const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      const f = after.split(" ");
      // stat fields are 1-based and `after` begins at field 3, so field 22 is
      // index 19.
      const ticks = f[19];
      return ticks && /^\d+$/.test(ticks) ? ticks : null;
    }
    if (Deno.build.os === "darwin") {
      const r = new Deno.Command("ps", {
        args: ["-o", "lstart=", "-p", String(pid)],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      if (!r.success) return null;
      const t = new TextDecoder().decode(r.stdout).trim();
      return t || null;
    }
  } catch { /* no /proc entry, no ps, no permission — we simply cannot say */ }
  return null;
}

/** Is the process this lock names still THE process the lock was written for?
 *
 *  `isProcessAlive` answers "does some process have this pid", which is a
 *  different question and the one every kill site used to ask. A lock that
 *  survived a reboot names a pid the kernel has since handed to somebody
 *  else, and SIGTERM does not ask who it is talking to.
 *
 *  Fails SAFE in the only direction that is safe: when either token is
 *  unavailable (an old lock, Windows, a pid we cannot read) this falls back to
 *  liveness — which is exactly the old behaviour, never worse. When both are
 *  known and they DIFFER, the pid was recycled and the answer is no. */
export function isLockOwnerAlive(
  lock: { pid: number; startToken?: string },
): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (!lock.startToken) return true;
  const now = processStartToken(lock.pid);
  if (now === null) return true;
  return now === lock.startToken;
}

/** Check if a TCP port has something listening */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Check if a local socket (Unix socket, or a named pipe on windows) has
 *  something listening — used to detect zombie socket-only instances
 *  (prod/electron skipHttp) whose process is alive but whose listener died.
 *  Mirrors isPortInUse for the socket transport. */
export async function isSocketAlive(socketPath: string): Promise<boolean> {
  try {
    const conn = await connectLocal(socketPath);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

// ── Lock File CRUD ───────────────────────────────────────────

/** Read a lock file, return null if missing or corrupt */
/** Read a lock by its key — the plain appId for a default-home app, or the
 *  `<appId>@<hash8(home)>` key {@linkcode lockKey} builds for any other home. */
export function readLock(key: string): LockData | null {
  try {
    const raw = Deno.readTextFileSync(lockPath(key));
    const data = JSON.parse(raw) as LockData;
    // Validate the SHAPE of each field, never its truthiness.
    //
    // This used to be `if (!data.appId || !data.pid || !data.port)`, and
    // `port: 0` is falsy — while being the documented "pick a free port"
    // setting, written into the lock verbatim. A port-0 app's lock therefore
    // read back as INVALID, and every consequence compounded in the same
    // direction: `release()` guards on this returning our record, so a
    // GRACEFUL shutdown removed nothing; staleness is decided from this data,
    // so the leftover could never be recognised as stale either; and the next
    // launch refused to start, permanently, with "Already running". An app
    // bricked by its own clean exit, recoverable only by finding a file in a
    // runtime directory nobody has reason to know about.
    //
    // pid is checked as POSITIVE (no process is pid 0, and the not-ok branch
    // below synthesises `pid: 0` for "someone holds it and we can't say who" —
    // that placeholder must never validate as a real record), while port is
    // checked only for being a number, because 0 is a real port value here.
    if (typeof data.appId !== "string" || data.appId === "") return null;
    if (typeof data.pid !== "number" || !(data.pid > 0)) return null;
    if (typeof data.port !== "number" || data.port < 0) return null;
    return data;
  } catch {
    return null;
  }
}

/** Write lock file atomically — createNew for first write, overwrite for updates */
export function writeLock(data: LockData): void {
  const path = lockPath(lockKey(data.appId, data.home));
  try {
    Deno.writeTextFileSync(path, JSON.stringify(data));
  } catch (e) {
    // Same case as tryCreateLock: a sibling's shutdown pruned the scoped lock
    // dir between our `lockDir()` and this write. Re-create, write once more.
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(data));
  }
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(data: LockData): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const path = lockPath(lockKey(data.appId, data.home));
  const open = () => Deno.openSync(path, { createNew: true, write: true });
  try {
    let fd: Deno.FsFile;
    try {
      fd = open();
    } catch (e) {
      // The directory can vanish between `lockDir()` and this write: a sibling
      // app's shutdown pruned its (momentarily empty) scoped dir. Re-create
      // and try once more — an ENOENT here is never "someone holds the lock".
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      Deno.mkdirSync(dirname(path), { recursive: true });
      fd = open();
    }
    fd.writeSync(encoded);
    fd.close();
    return true;
  } catch (e) {
    // `false` means ONE thing: the file is already there, so another process
    // won the race. It used to mean "anything went wrong", and the caller
    // renders that as `[AIO] Already running` + exit 1 — which for a lock dir
    // that cannot be written is a lie about a machine problem, after a 3-second
    // retry loop looking for an owner that does not exist (measured: 3041 ms,
    // then "Already running: probe-app", pid 0).
    //
    // The triggers are ordinary: a read-only or full /tmp, `/tmp/aio` owned by
    // another uid when XDG_RUNTIME_DIR is unset (Docker, ssh without logind,
    // cron), SELinux. In every one of them the app cannot boot and the message
    // sends the operator to look for a process.
    if (e instanceof Deno.errors.AlreadyExists) return false;
    throw new Error(
      `cannot write the single-instance lock ${path}: ${
        e instanceof Error ? e.message : String(e)
      }\n` +
        `  This is not "already running" — the lock DIRECTORY is unusable ` +
        `(read-only or full filesystem, owned by another user, or blocked by ` +
        `SELinux/AppArmor).\n` +
        `  fix: make ${dirname(path)} writable by this user, or point the ` +
        `lock dir somewhere writable with XDG_RUNTIME_DIR=… (or AIO_APPS_DIR=… ` +
        `to scope the whole instance).`,
      { cause: e },
    );
  }
}

/** Remove a lock file by its key (the plain appId for a default-home app) */
export function removeLock(key: string): void {
  try {
    Deno.removeSync(lockPath(key));
  } catch { /* already gone */ }
}

// ── AppLock — Singleton Enforcement ──────────────────────────

export class AppLock {
  readonly appId: string;
  /** Resolved data home — half of the identity (see {@linkcode lockKey}). */
  readonly home: string;
  /** THE file name this lock lives under. */
  readonly key: string;
  private acquired = false;

  constructor(appId: string, home?: string) {
    this.appId = appId;
    this.home = resolve(home ?? appHome(appId));
    this.key = lockKey(appId, this.home);
  }

  /** Every lock held in this process (read-only view of `_live`). */
  static live(): readonly AppLock[] {
    return [...AppLock._live];
  }

  /** Register process-termination hooks. Idempotent — safe to call from every
   *  acquire() exit path.
   *
   *  Two different things happen here, and they used to be one:
   *
   *  • `unload` RELEASES — the process is ending, nothing runs after this.
   *  • SIGINT / SIGTERM only MARK the lock `stopping`. The signal starts the
   *    graceful shutdown (`aio-server.ts` installs that handler); the lock is
   *    released by its Phase 6, AFTER the final persist. Releasing it at signal
   *    time — which is what this did — left the app alive, listening and
   *    flushing, but unlocked: measured, the lock file was gone 1 ms after
   *    SIGTERM and the process 14 ms later, and for an app with a real final
   *    snapshot the gap is the whole shutdown (seconds). A launch in that gap
   *    took the lock, opened the same `state.db`, restored PRE-final state and
   *    overwrote the first app's last write on its next persist. The stale-
   *    lock case this was added for (Audit F-7: a hard exit leaves the file
   *    behind) is covered by pid liveness — a dead owner is reclaimed on the
   *    next launch — and a hard exit runs no JS handler anyway. */
  private _registerCleanupHandlers(): void {
    // TWO facts, and merging them was the bug: "are the process-wide listeners
    // installed?" and "which locks must they release?".
    //
    // The flag is static (right — one set of listeners per process) but the
    // handler used to close over ONE instance's `this`. So a second locked app
    // in the same process — a supported shape (D2); `singleton` defaults to
    // true outside libraryMode — saw the flag already set, returned early, and
    // got no cleanup at all. On SIGTERM the first app's lock was released and
    // the second's was left behind, to block that app's next launch.
    //
    // The live set is the second fact, held separately.
    AppLock._live.add(this);
    if (AppLock._cleanupRegistered) return;
    AppLock._cleanupRegistered = true;
    // Snapshot the set: `release()` mutates it, and a Set must not be mutated
    // while it is being iterated.
    const release = () => {
      for (const lock of [...AppLock._live]) lock.release();
    };
    const markStopping = () => {
      for (const lock of [...AppLock._live]) {
        lock.update({ status: "stopping" });
      }
    };
    try {
      addEventListener("unload", release);
    } catch { /* skip if listener limit */ }
    try {
      AppLock._sigintHandler = markStopping;
      Deno.addSignalListener("SIGINT", markStopping);
    } catch { /* unsupported on windows */ }
    try {
      AppLock._sigtermHandler = markStopping;
      Deno.addSignalListener("SIGTERM", markStopping);
    } catch { /* unsupported on windows */ }
  }

  /** Unregister signal handlers to prevent listener leaks (e.g. in tests). */
  private _unregisterCleanupHandlers(): void {
    // This lock is done, but the LISTENERS belong to the process. Tearing them
    // down while another app still holds a lock would silently un-protect it —
    // the same class of bug as the one above, arrived at from the other side.
    AppLock._live.delete(this);
    if (AppLock._live.size > 0) return;
    try {
      AppLock._sigintHandler &&
        Deno.removeSignalListener("SIGINT", AppLock._sigintHandler);
    } catch { /* already removed or unsupported */ }
    try {
      AppLock._sigtermHandler &&
        Deno.removeSignalListener("SIGTERM", AppLock._sigtermHandler);
    } catch { /* already removed or unsupported */ }
    AppLock._sigintHandler = undefined;
    AppLock._sigtermHandler = undefined;
    AppLock._cleanupRegistered = false;
  }

  // ── Shared cleanup state (only one set of handlers ever registered) ──
  /** Every lock currently held in THIS process. The signal handlers release
   *  all of them; see `_registerCleanupHandlers` for why this is separate from
   *  the registration flag. */
  private static _live = new Set<AppLock>();
  private static _cleanupRegistered = false;
  private static _sigintHandler?: () => void;
  private static _sigtermHandler?: () => void;

  /** Acquire the lock for this app.
   *  - Cleans stale locks (dead PID)
   *  - Refuses if alive instance exists (killExisting=false)
   *  - Kills old instance first (killExisting=true)
   *  Returns the existing LockData if refusing, null on success. */
  async acquire(
    port: number,
    killExisting = false,
    meta: LockMeta = {},
  ): Promise<{ ok: true } | { ok: false; existing: LockData }> {
    const maxRetries = 30; // 3 seconds total
    // The record a successful create writes — ONE shape for both attempts.
    const fresh = (): LockData => ({
      appId: this.appId,
      pid: Deno.pid,
      port,
      startedAt: Date.now(),
      status: "starting",
      cwd: Deno.cwd(),
      home: this.home,
      // Recorded WITH the pid, because the pid alone is not an identity.
      ...(processStartToken(Deno.pid) !== null
        ? { startToken: processStartToken(Deno.pid)! }
        : {}),
      ...(meta.aioVersion !== undefined ? { aioVersion: meta.aioVersion } : {}),
      ...(meta.cdpPort !== undefined ? { cdpPort: meta.cdpPort } : {}),
      ...(meta.client !== undefined ? { client: meta.client } : {}),
    });

    for (let i = 0; i < maxRetries; i++) {
      const existing = readLock(this.key);

      if (!existing) {
        // No lock — try atomic create
        if (tryCreateLock(fresh())) {
          this.acquired = true;
          this._registerCleanupHandlers();
          return { ok: true };
        }
        // Race — someone else created it between our read and write. Retry.
        await delay(100);
        continue;
      }

      // Lock exists but owner is us (am pre-registered) — take over
      if (existing.pid === Deno.pid) {
        removeLock(this.key);
        await delay(100);
        continue;
      }

      // Lock exists — check if the OWNER is alive (not merely "some process
      // has that pid": a lock under /tmp outlives a reboot, and a recycled pid
      // would make this refuse to boot on account of a stranger's process, or
      // — with killExisting — kill it).
      if (!isLockOwnerAlive(existing)) {
        // Dead process — clean stale lock and retry
        removeLock(this.key);
        await delay(100);
        continue;
      }

      // Owner's pid is alive but its listener may be dead (zombie: event-loop
      // starvation killed the HTTP server while the process spun on, see
      // watcher-loop field report #5). Liveness = pid alive AND listener
      // responds. Probe whichever transport the owner advertises: TCP port
      // for HTTP servers, UDS for socket-only (prod/electron skipHttp) ones.
      // Grace: skip while the owner is still starting up.
      const pastStartup = existing.status !== "starting" ||
        Date.now() - existing.startedAt > STARTUP_GRACE_MS;
      let listenerDead = false;
      if (pastStartup) {
        if (existing.socketPath) {
          listenerDead = !(await isSocketAlive(existing.socketPath));
        } else if (existing.port > 0) {
          listenerDead = !(await isPortInUse(existing.port));
        }
      }
      if (listenerDead) {
        const where = existing.socketPath
          ? `socket ${existing.socketPath}`
          : `port ${existing.port}`;
        log.warn(
          `[AIO] stale instance: pid ${existing.pid} is alive but ${where} refuses connections — reclaiming lock (zombie server)`,
        );
        removeLock(this.key);
        await delay(100);
        continue;
      }

      // Owner is alive — behavior depends on killExisting
      if (killExisting) {
        // Kill the old instance — SIGTERM, then wait out the WHOLE graceful
        // budget before SIGKILL: a takeover is not a reason to truncate the
        // previous instance's final snapshot.
        // Wait out the app's OWN self-kill deadline too (`stopProcess`'s
        // watchdog), not just the phase budget: a takeover that SIGKILLs at
        // 9 s cuts off an app that was about to end itself cleanly at 10 s.
        await killProcess(existing.pid, EXIT_WAIT_MS, existing);
        removeLock(this.key);
        await delay(100);
        continue;
      }

      // killExisting=false (default) — refuse
      return { ok: false, existing };
    }

    // Exhausted retries (persistent race condition)
    const existing = readLock(this.key);
    if (existing) return { ok: false, existing };
    // Last-ditch attempt
    if (tryCreateLock(fresh())) {
      this.acquired = true;
      this._registerCleanupHandlers();
      return { ok: true };
    }
    // The lock can vanish between that failed create and this read (the owner
    // exited in the gap). `readLock(...)!` asserted it away, and the caller
    // then read `.port` off null — a TypeError from inside the framework
    // instead of "already running", for a race whose honest answer is "someone
    // else holds it and we can't say who".
    return {
      ok: false,
      existing: readLock(this.key) ?? {
        appId: this.appId,
        pid: 0,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd: "",
        home: this.home,
      },
    };
  }

  /** Update lock data (e.g. status change, socketPath, trojanPort) */
  update(partial: Partial<Omit<LockData, "appId" | "pid" | "home">>): void {
    const existing = readLock(this.key);
    if (!existing || existing.pid !== Deno.pid) return; // not ours
    writeLock({ ...existing, ...partial });
  }

  /** Release the lock — removes the file and unregisters signal handlers */
  release(): void {
    if (!this.acquired) return;
    // Only remove if it's still ours (PID matches)
    const existing = readLock(this.key);
    if (existing && existing.pid === Deno.pid) {
      removeLock(this.key);
    }
    this.acquired = false;
    this._unregisterCleanupHandlers();
  }
}

// ── instances() — Scan Running Apps ──────────────────────────

/** Scan for running aio instances. Filters stale locks automatically.
 *
 *  A lock file is `<appId>[@<hash8(home)>].lock` (see {@linkcode lockKey});
 *  the identity is read from the LOCK's `appId` + `home`, never parsed back
 *  out of the file name, so a suffixed lock lists as the app it is. `home`
 *  is always filled in — a pre-alpha66 lock means the default home. */
export function instances(appId?: string): InstanceInfo[] {
  const dir = lockDir();
  const results: InstanceInfo[] = [];

  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".lock")) continue;
      const key = entry.name.slice(0, -5); // strip ".lock" suffix
      if (appId && parseLockKey(key).appId !== appId) continue;

      const lock = readLock(key);
      if (!lock || (appId && lock.appId !== appId)) continue;

      // By OWNER, not by pid: a lock that survived a reboot (the base is
      // `/tmp` whenever XDG_RUNTIME_DIR is unset, and /tmp is not cleared at
      // boot on Debian/Ubuntu) names a pid the kernel has since reused, and
      // `isProcessAlive` would call that stale lock a running app — which is
      // how `am stop` came to SIGTERM a stranger.
      const alive = isLockOwnerAlive(lock);
      if (!alive) {
        // Clean stale lock
        removeLock(key);
        continue;
      }
      results.push({ ...lock, home: lock.home ?? appHome(lock.appId), alive });
    }
  } catch { /* dir not readable */ }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const KILL_GRACE_MS = 2000;
/** How often to re-check whether a signalled process has actually exited.
 *  Exported because `am`'s own kill loop polls the same fact — it had its own
 *  100 until they were found side by side. */
export const KILL_POLL_MS = 100;
const KILL_REAP_MS = 300;

/** Kill a process: SIGTERM first, SIGKILL after grace period */
/** Every descendant of `pid`, shallowest first.
 *
 *  Asked BEFORE anything is killed, because once a parent dies its children are
 *  reparented to init and can no longer be found by walking down from it. */
export async function descendantPids(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    const r = await new Deno.Command("pgrep", {
      args: ["-P", String(p)],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    if (!r?.success) return; // no pgrep (windows) — the parent is still killed
    for (const line of new TextDecoder().decode(r.stdout).trim().split("\n")) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        out.push(child);
        await walk(child);
      }
    }
  };
  await walk(pid).catch(() => {});
  return out;
}

/** THE process killer: SIGTERM, a grace period, then SIGKILL — and then any
 *  descendant the app left behind.
 *
 *  This used to exist TWICE, near-identically, and neither copy knew about
 *  child processes. That mattered most for the case it was written for: an aio
 *  app owns an Electron window, and a graceful stop closes it (`shutdown.ts`
 *  has an "electron" phase). But a HUNG app never reaches its shutdown, so the
 *  SIGKILL below orphaned the window — leaving a desktop app on screen with no
 *  server behind it, and a developer killing processes by hand before their
 *  next run would start.
 *
 *  The graceful path is unchanged and still preferred: when the app shuts down
 *  properly it reaps its own children, and the sweep below finds nothing. */
export async function killProcess(
  pid: number,
  grace = KILL_GRACE_MS,
  expect?: { startToken?: string },
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  // `expect` is the lock that named this pid. If it recorded a start token and
  // the live process's does not match, the pid was RECYCLED: signalling it
  // would kill whatever the user happens to be running now. Refusing is the
  // only safe answer, and it is loud — a caller that wanted a process gone has
  // to know it is not gone.
  if (expect?.startToken && !isLockOwnerAlive({ pid, ...expect })) {
    throw new Error(
      `refusing to signal pid ${pid}: it is no longer the process that ` +
        `recorded this lock (the pid was reused — the lock outlived a reboot, ` +
        `which happens whenever XDG_RUNTIME_DIR is unset and the lock dir is ` +
        `under /tmp).\n` +
        `  fix: the lock is stale — remove it (am stop --stale) rather than ` +
        `killing pid ${pid}, which now belongs to something else.`,
    );
  }
  // Ask first, kill second.
  const kids = await descendantPids(pid);
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(KILL_POLL_MS);
  }
  if (isProcessAlive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* ok */ }
    await delay(KILL_REAP_MS);
  }
  // Deepest first, so a parent cannot spawn a replacement on its way out.
  // Anything already gone (the graceful case) is a no-op.
  for (const kid of kids.reverse()) {
    if (!isProcessAlive(kid)) continue;
    try {
      Deno.kill(kid, "SIGKILL");
    } catch { /* already gone, or not ours to signal */ }
  }
}
